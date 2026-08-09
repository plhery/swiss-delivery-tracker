import base64
import json
import unittest
from unittest.mock import Mock

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from server.push import (
    CompositePushNotificationService,
    NativePushNotificationService,
    PushSummary,
)


def private_key() -> str:
    key = ec.generate_private_key(ec.SECP256R1())
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()


def row(
    device: str = "device-1",
    package: str = "pkg-1",
    event: str = "event-1",
    created: str = "2026-08-09T08:00:00Z",
) -> dict[str, str]:
    return {
        "device_id": device,
        "token": "ab" * 32,
        "environment": "development",
        "locale": "fr",
        "event_id": event,
        "package_id": package,
        "label": "Café",
        "stage": "in_transit",
        "description": "Trié",
        "location": "Zürich",
        "event_created_at": created,
    }


class NativePushNotificationTests(unittest.TestCase):
    def service(self, rows, sender=None, now=lambda: 1_786_262_400):
        client = Mock()
        client.list_pending_native_push_notifications.return_value = rows
        response = Mock(status_code=200)
        service = NativePushNotificationService(
            client,
            "TEAM123456",
            "KEY1234567",
            private_key(),
            "com.example.DeliveryTracker",
            sender=sender or Mock(return_value=response),
            now=now,
        )
        return service, client

    def test_dispatch_groups_events_and_sends_localized_private_payload(self):
        sender = Mock(return_value=Mock(status_code=200))
        service, client = self.service(
            [
                row(event="event-1"),
                row(event="event-2", created="2026-08-09T08:01:00Z"),
                row(package="pkg-2", event="event-3"),
            ],
            sender,
        )

        summary = service.dispatch()

        self.assertEqual((summary.attempted, summary.sent, summary.failed), (2, 2, 0))
        self.assertEqual(sender.call_count, 2)
        first = sender.call_args_list[0]
        self.assertTrue(first.args[0].startswith("https://api.sandbox.push.apple.com/3/device/"))
        self.assertEqual(first.kwargs["headers"]["apns-topic"], "com.example.DeliveryTracker")
        self.assertEqual(first.kwargs["headers"]["apns-push-type"], "alert")
        self.assertGreater(int(first.kwargs["headers"]["apns-expiration"]), 1_786_262_400)
        payload = first.kwargs["json"]
        self.assertEqual(payload["aps"]["alert"]["title"], "Café")
        self.assertEqual(payload["aps"]["alert"]["body"], "Colis en transit · Zürich")
        self.assertEqual(payload["parcel_id"], "pkg-1")
        self.assertNotIn("tracking", json.dumps(payload).casefold())
        client.record_native_push_deliveries.assert_any_call(
            "device-1", ["event-1", "event-2"]
        )

    def test_provider_token_is_es256_and_cached_for_fifty_minutes(self):
        sender = Mock(return_value=Mock(status_code=200))
        now_value = [1_786_262_400]
        service, _ = self.service([], sender, now=lambda: now_value[0])
        device = {
            "token": "ab" * 32,
            "environment": "production",
            "locale": "en",
        }

        service.send_test(device)
        first = sender.call_args.kwargs["headers"]["authorization"].removeprefix("bearer ")
        now_value[0] += 60
        service.send_test(device)
        second = sender.call_args.kwargs["headers"]["authorization"].removeprefix("bearer ")

        self.assertEqual(first, second)
        header, claims, signature = first.split(".")
        def decode(value):
            return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))

        self.assertEqual(json.loads(decode(header)), {"alg": "ES256", "kid": "KEY1234567"})
        self.assertEqual(json.loads(decode(claims))["iss"], "TEAM123456")
        self.assertEqual(len(decode(signature)), 64)

    def test_expired_tokens_are_disabled_and_transient_errors_retry(self):
        expired = Mock(status_code=410)
        expired.json.return_value = {"reason": "Unregistered"}
        failed = Mock(status_code=500)
        failed.json.return_value = {"reason": "InternalServerError"}
        sender = Mock(side_effect=[expired, failed])
        service, client = self.service(
            [row(device="old"), row(device="retry")], sender
        )

        summary = service.dispatch()

        self.assertEqual((summary.expired, summary.failed, summary.sent), (1, 1, 0))
        self.assertIn(
            "disabled_at", client.update_native_push_device.call_args_list[0].args[1]
        )
        self.assertEqual(
            client.update_native_push_device.call_args_list[1].args[1]["last_error"],
            "APNs delivery failed",
        )
        client.record_native_push_deliveries.assert_not_called()

    def test_untrusted_carrier_text_cannot_overflow_the_apns_payload(self):
        sender = Mock(return_value=Mock(status_code=200))
        oversized = row()
        oversized["location"] = "  Zürich\n" + "x" * 5_000
        oversized["label"] = "Parcel\n" + "y" * 500
        service, _ = self.service([oversized], sender)

        service.dispatch()

        payload = sender.call_args.kwargs["json"]
        self.assertLess(len(json.dumps(payload, ensure_ascii=False).encode()), 4_096)
        self.assertNotIn("\n", payload["aps"]["alert"]["title"])
        self.assertTrue(payload["aps"]["alert"]["body"].endswith("…"))

    def test_composite_dispatch_sums_browser_and_native_channels(self):
        web = Mock()
        native = Mock()
        web.dispatch.return_value = PushSummary(attempted=2, sent=1, failed=1)
        native.dispatch.return_value = PushSummary(attempted=1, sent=1, expired=1)

        summary = CompositePushNotificationService(web, native).dispatch()

        self.assertEqual(
            (summary.attempted, summary.sent, summary.failed, summary.expired),
            (3, 2, 1, 1),
        )


if __name__ == "__main__":
    unittest.main()
