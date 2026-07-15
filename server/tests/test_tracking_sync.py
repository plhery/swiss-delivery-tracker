from datetime import datetime, timezone
import json
import sys
from types import ModuleType
import unittest
from unittest.mock import patch

from server.tracking_sync import (
    CARRIER_NAMES,
    SyncSummary,
    TrackingSyncService,
    UpstreamTrackerAdapter,
    build_events,
    event_timestamp,
    infer_stage,
    provider_event_id,
    result_stage,
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

    def fetch(self, carrier_id, tracking_number, tracking_url):
        self.calls.append((carrier_id, tracking_number, tracking_url))
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
        }

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
            result_stage({"status": "exception", "last_status_text": "Held at customs"}),
            "customs",
        )
        self.assertIsNone(result_stage({"status": "unknown"}))

    def test_event_timestamps_accept_common_formats_and_fallback(self):
        fallback = datetime(2026, 7, 14, 9, tzinfo=timezone.utc)
        self.assertEqual(
            event_timestamp("2026-07-14T10:00:00+02:00", fallback),
            "2026-07-14T08:00:00+00:00",
        )
        self.assertEqual(
            event_timestamp("2026-07-14 10:00", fallback),
            "2026-07-14T10:00:00+00:00",
        )
        self.assertEqual(
            event_timestamp("14.07.2026 10:00", fallback),
            "2026-07-14T10:00:00+00:00",
        )
        self.assertEqual(
            event_timestamp("2026-07-14", fallback),
            "2026-07-14T00:00:00+00:00",
        )
        self.assertEqual(event_timestamp("not-a-date", fallback), fallback.isoformat())
        self.assertEqual(event_timestamp(None, fallback), fallback.isoformat())

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
        self.assertEqual(pending_client.events[0]["stage"], "pending")
        self.assertEqual(pending_client.updates[-1][1]["current_stage"], "pending")
        self.assertEqual(pending_client.updates[-1][1]["sync_status"], "waiting")

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
            def fetch(self, carrier_id, tracking_number, tracking_url):
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
        notifier.dispatch.return_value = type(
            "Push", (), {"sent": 2, "failed": 1, "expired": 1}
        )()
        summary = TrackingSyncService(FakeClient([]), FakeAdapter(), notifier=notifier).sync()
        self.assertEqual(summary.notifications_sent, 2)
        self.assertEqual(summary.notification_errors, 1)
        self.assertEqual(summary.subscriptions_expired, 1)

        notifier.dispatch.side_effect = RuntimeError("push offline")
        summary = TrackingSyncService(FakeClient([]), FakeAdapter(), notifier=notifier).sync()
        self.assertEqual(summary.notification_errors, 1)

    def test_upstream_adapter_loads_modules_and_handles_missing_carriers(self):
        tracker = ModuleType("swiss_delivery_tracker.tracker")
        swiss_module = type("SwissModule", (), {"fetch": staticmethod(lambda number: {"number": number})})
        dachser_module = type(
            "DachserModule",
            (),
            {"fetch": staticmethod(lambda number, url: {"number": number, "url": url})},
        )
        tracker.CARRIER_MODULES = {"Swiss Post": swiss_module, "Dachser": dachser_module}
        package = ModuleType("swiss_delivery_tracker")
        with patch.dict(
            sys.modules,
            {"swiss_delivery_tracker": package, "swiss_delivery_tracker.tracker": tracker},
        ):
            adapter = UpstreamTrackerAdapter()
        self.assertEqual(adapter.fetch("swiss-post", "123", None), {"number": "123"})
        with patch.dict(CARRIER_NAMES, {"dachser-test": "Dachser"}):
            self.assertEqual(
                adapter.fetch("dachser-test", "456", "https://example.test"),
                {"number": "456", "url": "https://example.test"},
            )
        with self.assertRaisesRegex(LookupError, "not available"):
            adapter.fetch("unknown", "123", None)
        with patch.dict(CARRIER_NAMES, {"missing-test": "Missing"}):
            with self.assertRaisesRegex(LookupError, "no Missing adapter"):
                adapter.fetch("missing-test", "123", None)


if __name__ == "__main__":
    unittest.main()
