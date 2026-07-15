import json
import unittest
from unittest.mock import Mock

from server.push import PushNotificationService


def row(subscription="sub-1", package="pkg-1", event="event-1", created="2026-07-15T08:00:00Z"):
    return {
        "subscription_id": subscription,
        "endpoint": f"https://push.example.test/{subscription}",
        "p256dh": "public-encryption-key",
        "auth": "auth-secret",
        "event_id": event,
        "package_id": package,
        "label": "Coffee beans",
        "stage": "in_transit",
        "description": "Sorted",
        "location": "Zürich",
        "event_created_at": created,
    }


class PushNotificationTests(unittest.TestCase):
    def service(self, rows, sender=None):
        client = Mock()
        client.list_pending_push_notifications.return_value = rows
        return PushNotificationService(
            client, "public", "private", "mailto:owner@example.test", sender or Mock()
        ), client

    def test_dispatch_groups_events_per_device_and_parcel(self):
        earlier = row(event="event-1")
        latest = row(event="event-2", created="2026-07-15T08:01:00Z")
        other = row(package="pkg-2", event="event-3")
        sender = Mock()
        service, client = self.service([earlier, latest, other], sender)

        summary = service.dispatch()

        self.assertEqual((summary.attempted, summary.sent, summary.failed), (2, 2, 0))
        self.assertEqual(sender.call_count, 2)
        payload = json.loads(sender.call_args_list[0].kwargs["data"])
        self.assertEqual(payload["title"], "Coffee beans")
        self.assertEqual(payload["body"], "Parcel in transit · Zürich")
        self.assertEqual(payload["data"]["url"], "/?parcel=pkg-1")
        self.assertNotIn("tracking", payload["body"].casefold())
        client.record_push_deliveries.assert_any_call("sub-1", ["event-1", "event-2"])

    def test_expired_endpoints_are_disabled_and_other_failures_retry(self):
        expired = RuntimeError("gone")
        expired.response = type("Response", (), {"status_code": 410})()
        sender = Mock(side_effect=[expired, RuntimeError("temporary")])
        service, client = self.service(
            [row(subscription="old"), row(subscription="retry")], sender
        )

        summary = service.dispatch()

        self.assertEqual((summary.expired, summary.failed, summary.sent), (1, 1, 0))
        self.assertEqual(client.update_push_subscription.call_count, 2)
        self.assertIn("disabled_at", client.update_push_subscription.call_args_list[0].args[1])
        self.assertEqual(
            client.update_push_subscription.call_args_list[1].args[1]["last_error"],
            "Push delivery failed",
        )
        client.record_push_deliveries.assert_not_called()

    def test_test_notification_uses_the_same_vapid_credentials(self):
        sender = Mock()
        service, _ = self.service([], sender)
        service.send_test(row())
        call = sender.call_args.kwargs
        self.assertEqual(call["vapid_private_key"], "private")
        self.assertEqual(call["vapid_claims"], {"sub": "mailto:owner@example.test"})
        self.assertEqual(json.loads(call["data"])["title"], "Notifications are on")


if __name__ == "__main__":
    unittest.main()
