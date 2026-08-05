import json
import sys
import unittest
from datetime import datetime, timezone
from types import ModuleType
from unittest.mock import patch
from zoneinfo import ZoneInfo

from server.tracking_sync import (
    SyncSummary,
    TrackingSyncService,
    UpstreamTrackerAdapter,
    build_events,
    event_timestamp,
    fair_sync_packages,
    infer_stage,
    provider_event_id,
    result_stage,
    result_timezone,
)


class FakeClient:
    def __init__(self, packages):
        self.packages = packages
        self.updates = []
        self.events = []

    def list_active_packages(self):
        return list(self.packages)

    def update_package(self, package_id, values):
        self.updates.append((package_id, values))

    def insert_events(self, events):
        self.events.extend(events)


class FakeAdapter:
    def __init__(self, result=None, error=None):
        self.result = result
        self.error = error
        self.calls = []

    def fetch(self, carrier_id, tracking_number, tracking_url, dpd_postcode=None):
        self.calls.append((carrier_id, tracking_number, tracking_url, dpd_postcode))
        if self.error:
            raise self.error
        return self.result or {
            "status": "out_for_delivery",
            "last_status_text": "Out for delivery",
            "last_update": "2026-07-14T10:00:00+02:00",
            "expected_delivery": "2026-07-14",
            "events": [
                {
                    "time": "2026-07-14T10:00:00+02:00",
                    "location": "Zürich",
                    "description": "Out for delivery",
                }
            ],
        }


class TrackingSyncTests(unittest.TestCase):
    def package(self, package_id="pkg-1", carrier="swiss-post"):
        return {
            "id": package_id,
            "user_id": "user-1",
            "tracking_number": "993412345612345678",
            "carrier": carrier,
            "tracking_url": None,
            "dpd_postcode": None,
        }

    def test_dpd_sync_uses_the_postcode_stored_with_the_package(self):
        package = self.package("pkg-dpd", "dpd")
        package["tracking_number"] = "06086514587082"
        package["dpd_postcode"] = "8004"
        adapter = unittest.mock.Mock()
        adapter.fetch.return_value = {"status": "pending"}

        TrackingSyncService(FakeClient([package]), adapter).sync()

        adapter.fetch.assert_called_once_with("dpd", "06086514587082", None, "8004")

    def test_sync_writes_deduplicated_events_and_package_state(self):
        client = FakeClient(
            [
                {
                    "id": "pkg-1",
                    "user_id": "user-1",
                    "tracking_number": "993412345612345678",
                    "carrier": "swiss-post",
                    "tracking_url": None,
                }
            ]
        )
        service = TrackingSyncService(
            client,
            FakeAdapter(),
            now=lambda: datetime(2026, 7, 14, 9, tzinfo=timezone.utc),
        )

        summary = service.sync()

        self.assertEqual(summary.updated, 1)
        self.assertEqual(len(client.events), 1)
        self.assertEqual(client.events[0]["stage"], "out_for_delivery")
        self.assertTrue(client.events[0]["provider_event_id"].startswith("swiss-post:"))
        final_update = client.updates[-1][1]
        self.assertEqual(final_update["current_stage"], "out_for_delivery")
        self.assertEqual(final_update["sync_status"], "ok")

    def test_sync_package_checks_only_the_new_package_immediately(self):
        package = self.package("new-package")
        other = self.package("older-package")
        client = FakeClient([other])
        adapter = FakeAdapter()
        service = TrackingSyncService(client, adapter)

        summary = service.sync_package(package)

        self.assertEqual(summary.checked, 1)
        self.assertEqual(summary.updated, 1)
        self.assertEqual(
            adapter.calls,
            [("swiss-post", package["tracking_number"], None, None)],
        )
        self.assertTrue(all(package_id == "new-package" for package_id, _ in client.updates))

    def test_unsupported_carrier_is_explicit(self):
        client = FakeClient(
            [
                {
                    "id": "pkg-2",
                    "user_id": "user-1",
                    "tracking_number": "1234567890",
                    "carrier": "dhl",
                    "tracking_url": None,
                }
            ]
        )
        summary = TrackingSyncService(client, FakeAdapter()).sync()
        self.assertEqual(summary.unsupported, 1)
        self.assertEqual(client.updates[-1][1]["sync_status"], "unsupported")

    def test_stage_inference_handles_exceptions(self):
        self.assertEqual(infer_stage("Held at customs"), "customs")
        self.assertEqual(infer_stage("Ready for pickup"), "ready_for_pickup")
        self.assertEqual(infer_stage("Returned to sender"), "returned")
        self.assertEqual(infer_stage("Parcel not delivered"), "failed_attempt")
        self.assertEqual(infer_stage("Shipment could not be delivered"), "failed_attempt")
        self.assertEqual(infer_stage("Sendung nicht zugestellt"), "failed_attempt")

    def test_stage_inference_covers_happy_path_and_fallbacks(self):
        cases = {
            "Parcel deposited": "delivered",
            "In delivery": "out_for_delivery",
            "Missed delivery": "failed_attempt",
            "Received at origin": "accepted",
            "Label created": "registered",
            "Departed sorting center": "in_transit",
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(infer_stage(text), expected)
        self.assertEqual(infer_stage("Unrecognised", "waiting"), "waiting")
        self.assertEqual(infer_stage("Parcel handed to DPD"), "accepted")
        self.assertEqual(infer_stage("At delivery centre"), "in_transit")

    def test_result_stage_maps_provider_states(self):
        self.assertEqual(result_stage({"status": "pending"}), "pending")
        self.assertEqual(
            result_stage({"status": "pending", "last_status_text": "Label created"}),
            "registered",
        )
        self.assertEqual(result_stage({"status": "in_transit"}), "in_transit")
        self.assertEqual(result_stage({"status": "out_for_delivery"}), "out_for_delivery")
        self.assertEqual(result_stage({"status": "delivered"}), "delivered")
        self.assertEqual(
            result_stage({"status": "delivered", "last_status_text": "Not delivered"}),
            "failed_attempt",
        )
        self.assertEqual(
            result_stage({"status": "exception", "last_status_text": "Held at customs"}),
            "customs",
        )
        self.assertIsNone(result_stage({"status": "unknown"}))

    def test_event_timestamps_accept_common_formats_without_inventing_a_time(self):
        self.assertEqual(
            event_timestamp("2026-07-14T10:00:00+02:00"),
            "2026-07-14T08:00:00+00:00",
        )
        self.assertEqual(
            event_timestamp("2026-07-14 10:00"),
            "2026-07-14T10:00:00+00:00",
        )
        self.assertEqual(
            event_timestamp("14.07.2026 10:00"),
            "2026-07-14T10:00:00+00:00",
        )
        self.assertEqual(
            event_timestamp("2026-07-14"),
            "2026-07-14T00:00:00+00:00",
        )
        zurich = ZoneInfo("Europe/Zurich")
        self.assertEqual(
            event_timestamp("2026-07-14 10:00", zurich),
            "2026-07-14T08:00:00+00:00",
        )
        self.assertEqual(
            event_timestamp("14.07.2026 10:00", zurich),
            "2026-07-14T08:00:00+00:00",
        )
        self.assertEqual(
            event_timestamp("14/07/2026 10:00", zurich),
            "2026-07-14T08:00:00+00:00",
        )
        self.assertIsNone(event_timestamp("not-a-date"))
        self.assertIsNone(event_timestamp(None))

    def test_carrier_or_declared_timezone_is_used_for_naive_events(self):
        zurich = ZoneInfo("Europe/Zurich")
        self.assertEqual(result_timezone("swiss-post", {}), zurich)
        self.assertEqual(result_timezone("aliexpress", {}), timezone.utc)
        self.assertEqual(
            result_timezone("dachser", {}),
            ZoneInfo("Europe/Madrid"),
        )
        self.assertEqual(
            result_timezone("aliexpress", {"timezone": "Asia/Shanghai"}),
            ZoneInfo("Asia/Shanghai"),
        )
        self.assertEqual(
            result_timezone("swiss-post", {"timezone": "not/a-zone"}),
            zurich,
        )

        rows = build_events(
            self.package(),
            {
                "status": "in_transit",
                "events": [
                    {
                        "time": "2026-07-14 10:00",
                        "location": "Zürich",
                        "description": "Sorted",
                    }
                ],
            },
            datetime(2026, 7, 14, 9, tzinfo=timezone.utc),
        )
        self.assertEqual(rows[0]["occurred_at"], "2026-07-14T08:00:00+00:00")

    def test_provider_ids_are_stable_and_content_addressed(self):
        first = provider_event_id("swiss-post", "time", "Zürich", "Sorted")
        second = provider_event_id("swiss-post", "time", "Zürich", "Sorted")
        changed = provider_event_id("swiss-post", "time", "Bern", "Sorted")
        self.assertEqual(first, second)
        self.assertNotEqual(first, changed)
        self.assertTrue(first.startswith("swiss-post:"))

    def test_build_events_uses_fallback_status_when_history_is_empty(self):
        now = datetime(2026, 7, 14, 9, tzinfo=timezone.utc)
        rows = build_events(
            self.package(),
            {
                "status": "delivered",
                "last_status_text": "Delivered",
                "last_update": "2026-07-14",
                "events": [],
            },
            now,
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["stage"], "delivered")
        self.assertIsNone(rows[0]["location"])
        self.assertEqual(rows[0]["raw_data"], {})
        self.assertEqual(build_events(self.package(), {"status": "unknown"}, now), [])

    def test_build_events_drops_rows_without_a_real_provider_timestamp(self):
        now = datetime(2026, 7, 14, 9, tzinfo=timezone.utc)
        rows = build_events(
            self.package(),
            {
                "status": "delivered",
                "last_status_text": "Delivered",
                "events": [
                    {"time": "not-a-date", "description": "Delivered"},
                    {"description": "Out for delivery"},
                ],
            },
            now,
        )
        self.assertEqual(rows, [])

    def test_build_events_honors_a_valid_adapter_stage(self):
        rows = build_events(
            self.package(carrier="dachser"),
            {
                "status": "delivered",
                "events": [
                    {
                        "time": "2026-07-14T08:00:00+02:00",
                        "location": "",
                        "stage": "in_transit",
                        "description": "Dachser tracking update",
                    }
                ],
            },
            datetime(2026, 7, 14, 9, tzinfo=timezone.utc),
        )

        self.assertEqual(rows[0]["stage"], "in_transit")

    def test_waiting_and_carrier_errors_are_persisted(self):
        client = FakeClient([self.package()])
        waiting = TrackingSyncService(
            client,
            FakeAdapter(result={"status": "unknown", "events": []}),
        ).sync()
        self.assertEqual(waiting.waiting, 1)
        self.assertEqual(client.updates[-1][1]["sync_status"], "waiting")

        pending_client = FakeClient([self.package("pkg-pending")])
        pending = TrackingSyncService(
            pending_client,
            FakeAdapter(
                result={
                    "status": "pending",
                    "last_status_text": "Shipment not found yet",
                    "events": [],
                }
            ),
        ).sync()
        self.assertEqual(pending.waiting, 1)
        self.assertEqual(pending_client.events, [])
        self.assertEqual(pending_client.updates[-1][1]["current_stage"], "pending")
        self.assertEqual(pending_client.updates[-1][1]["sync_status"], "waiting")

        history_client = FakeClient([self.package("pkg-history")])
        from_history = TrackingSyncService(
            history_client,
            FakeAdapter(
                result={
                    "status": "unknown",
                    "events": [
                        {
                            "description": "Delivered",
                            "time": "2026-07-15T12:00:00+00:00",
                        }
                    ],
                }
            ),
        ).sync()
        self.assertEqual(from_history.updated, 1)
        self.assertEqual(history_client.events[-1]["stage"], "delivered")
        self.assertEqual(history_client.updates[-1][1]["current_stage"], "delivered")

        json_client = FakeClient([self.package("pkg-json")])
        json_error = json.JSONDecodeError("bad", "<html>", 0)
        errored = TrackingSyncService(json_client, FakeAdapter(error=json_error)).sync()
        self.assertEqual(errored.errors, 1)
        self.assertEqual(
            json_client.updates[-1][1]["sync_error"],
            "The carrier returned a maintenance page instead of tracking data.",
        )

        long_client = FakeClient([self.package("pkg-long")])
        TrackingSyncService(long_client, FakeAdapter(error=RuntimeError("x" * 700))).sync()
        self.assertEqual(len(long_client.updates[-1][1]["sync_error"]), 500)

    def test_one_carrier_failure_does_not_stop_other_packages(self):
        class MixedAdapter:
            def fetch(self, carrier_id, tracking_number, tracking_url, dpd_postcode=None):
                if tracking_number == "bad":
                    raise RuntimeError()
                return {"status": "delivered", "last_status_text": "Delivered"}

        good = self.package("good")
        good["tracking_number"] = "good"
        bad = self.package("bad")
        bad["tracking_number"] = "bad"
        client = FakeClient([bad, good])
        summary = TrackingSyncService(client, MixedAdapter()).sync()
        self.assertEqual(summary.checked, 2)
        self.assertEqual(summary.errors, 1)
        self.assertEqual(summary.updated, 1)
        self.assertEqual(client.updates[1][1]["sync_error"], "RuntimeError")

    def test_summary_serialization(self):
        self.assertEqual(
            SyncSummary(checked=2, updated=1, waiting=1, errors=0, unsupported=0).to_dict(),
            {
                "checked": 2,
                "updated": 1,
                "waiting": 1,
                "errors": 0,
                "unsupported": 0,
                "notifications_sent": 0,
                "notification_errors": 0,
                "subscriptions_expired": 0,
            },
        )

    def test_notification_delivery_is_summarized_without_breaking_sync(self):
        notifier = unittest.mock.Mock()
        notifier.dispatch.return_value = type("Push", (), {"sent": 2, "failed": 1, "expired": 1})()
        summary = TrackingSyncService(FakeClient([]), FakeAdapter(), notifier=notifier).sync()
        self.assertEqual(summary.notifications_sent, 2)
        self.assertEqual(summary.notification_errors, 1)
        self.assertEqual(summary.subscriptions_expired, 1)

        notifier.dispatch.side_effect = RuntimeError("push offline")
        summary = TrackingSyncService(FakeClient([]), FakeAdapter(), notifier=notifier).sync()
        self.assertEqual(summary.notification_errors, 1)

    def test_scheduled_sync_round_robins_accounts_and_caps_each_owner(self):
        packages = [{"id": f"first-{number}", "user_id": "first"} for number in range(1, 8)]
        packages.extend({"id": f"second-{number}", "user_id": "second"} for number in range(1, 4))

        ordered = fair_sync_packages(packages, per_owner_limit=5)

        self.assertEqual(
            [package["id"] for package in ordered[:6]],
            ["first-1", "second-1", "first-2", "second-2", "first-3", "second-3"],
        )
        self.assertEqual(sum(row["user_id"] == "first" for row in ordered), 5)
        self.assertNotIn("first-6", {row["id"] for row in ordered})

    def test_upstream_adapter_loads_modules_and_handles_missing_carriers(self):
        tracker = ModuleType("swiss_delivery_tracker.tracker")
        swiss_module = type(
            "SwissModule", (), {"fetch": staticmethod(lambda number: {"number": number})}
        )
        tracker.CARRIER_MODULES = {"Swiss Post": swiss_module}
        package = ModuleType("swiss_delivery_tracker")
        carriers = ModuleType("swiss_delivery_tracker.carriers")
        package.carriers = carriers
        with patch.dict(
            sys.modules,
            {
                "swiss_delivery_tracker": package,
                "swiss_delivery_tracker.carriers": carriers,
                "swiss_delivery_tracker.tracker": tracker,
            },
        ):
            dpd_tracker = unittest.mock.Mock()
            dpd_tracker.fetch.return_value = {"status": "in_transit"}
            dachser_tracker = unittest.mock.Mock()
            dachser_tracker.fetch.return_value = {"status": "delivered"}
            planzer_shared_tracker = unittest.mock.Mock()
            planzer_shared_tracker.fetch.return_value = {"status": "out_for_delivery"}
            hermes_tracker = unittest.mock.Mock()
            hermes_tracker.fetch.return_value = {"status": "exception"}
            ups_tracker = unittest.mock.Mock()
            ups_tracker.fetch.return_value = {"status": "delivered"}
            adapter = UpstreamTrackerAdapter(
                dpd_tracker=dpd_tracker,
                dachser_tracker=dachser_tracker,
                hermes_tracker=hermes_tracker,
                planzer_shared_tracker=planzer_shared_tracker,
                ups_tracker=ups_tracker,
            )
        self.assertEqual(
            adapter.fetch("swiss-post", "123", None),
            {"number": "123", "status": "unknown", "events": []},
        )
        self.assertEqual(
            adapter.fetch("dpd", "06086514587082", None),
            {"status": "in_transit", "events": []},
        )
        dpd_tracker.fetch.assert_called_once_with("06086514587082", None)
        self.assertEqual(
            adapter.fetch("ups", "1Z999AA10123456784", None),
            {"status": "delivered", "events": []},
        )
        ups_tracker.fetch.assert_called_once_with("1Z999AA10123456784")
        self.assertEqual(
            adapter.fetch("planzer", "9999003316119", "https://planzer.example/shared"),
            {"status": "out_for_delivery", "events": []},
        )
        planzer_shared_tracker.fetch.assert_called_once_with(
            "9999003316119", "https://planzer.example/shared"
        )
        self.assertEqual(
            adapter.fetch("dachser", "456", "https://dachser.example/shared"),
            {"status": "delivered", "events": []},
        )
        dachser_tracker.fetch.assert_called_once_with("456", "https://dachser.example/shared")
        with self.assertRaisesRegex(ValueError, "complete tracking URL"):
            adapter.fetch("dachser", "456", None)
        with self.assertRaisesRegex(LookupError, "not available"):
            adapter.fetch("unknown", "123", None)
        self.assertEqual(
            adapter.fetch("hermes", "HES123", None),
            {"status": "exception", "events": []},
        )
        hermes_tracker.fetch.assert_called_once_with("HES123")


if __name__ == "__main__":
    unittest.main()
