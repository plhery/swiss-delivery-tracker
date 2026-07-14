from datetime import datetime, timezone
import unittest

from server.tracking_sync import TrackingSyncService, infer_stage


class FakeClient:
    def __init__(self, packages):
        self.packages = packages
        self.updates = []
        self.events = []

    def list_active_packages(self, user_id=None):
        return [p for p in self.packages if user_id is None or p["user_id"] == user_id]

    def update_package(self, package_id, values):
        self.updates.append((package_id, values))

    def insert_events(self, events):
        self.events.extend(events)


class FakeAdapter:
    def fetch(self, carrier_id, tracking_number, tracking_url):
        return {
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

        summary = service.sync("user-1")

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


if __name__ == "__main__":
    unittest.main()
