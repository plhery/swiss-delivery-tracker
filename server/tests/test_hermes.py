import unittest
import urllib.error
from unittest.mock import patch

from server.hermes import HermesTracker, parse_tracking_response, status_for_id


class FakeResponse:
    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None

    def read(self, _amount):
        return self.body


class HermesTests(unittest.TestCase):
    def test_status_bands_keep_exceptions_out_of_delivered(self):
        cases = {
            40: "pending",
            10_100: "pending",
            20_000: "in_transit",
            30_000: "out_for_delivery",
            40_000: "delivered",
            49_999: "delivered",
            50_000: "exception",
            50_123: "exception",
        }
        for status_id, expected in cases.items():
            with self.subTest(status_id=status_id):
                self.assertEqual(status_for_id(status_id), expected)
        self.assertEqual(status_for_id("invalid"), "pending")
        self.assertEqual(status_for_id(object()), "pending")

    def test_response_preserves_event_level_provider_stages(self):
        result = parse_tracking_response(
            {
                "body": {
                    "auftragsdaten": {
                        "lieferdatum": "2026-08-07",
                        "statusjourneyDto": {
                            "auftragstatusdaten": [
                                {
                                    "sendungsstatusId": 50_000,
                                    "sendungsstatus": "Delivery not possible",
                                    "sendungsstatusBuchungszeitpunkt": "2026-08-05 12:00:00",
                                }
                            ],
                            "statusdaten": [
                                {
                                    "sendungsstatusId": 40_000,
                                    "sendungsstatus": "Delivered",
                                    "sendungsstatusBuchungszeitpunkt": "2026-08-04 12:00:00",
                                }
                            ],
                        },
                    }
                }
            }
        )

        self.assertEqual(result["status"], "exception")
        self.assertEqual(result["events"][0]["stage"], "failed_attempt")
        self.assertEqual(result["events"][1]["stage"], "delivered")
        self.assertEqual(result["timezone"], "Europe/Zurich")

    def test_rejects_malformed_response_shapes(self):
        for payload in (
            [],
            {"body": []},
            {"auftragsdaten": [1]},
            {"auftragsdaten": {"statusjourneyDto": [1]}},
        ):
            with self.subTest(payload=payload):
                with self.assertRaisesRegex(ValueError, "invalid tracking response"):
                    parse_tracking_response(payload)

    def test_fetches_a_bounded_json_response(self):
        response = FakeResponse(b'{"auftragsdaten":{"statusjourneyDto":{}}}')
        with patch("server.hermes.urllib.request.urlopen", return_value=response) as fetch:
            result = HermesTracker(timeout=7).fetch("HES 123")

        request = fetch.call_args.args[0]
        self.assertIn("parcelNumber=HES%20123", request.full_url)
        self.assertEqual(fetch.call_args.kwargs["timeout"], 7)
        self.assertEqual(result["status"], "pending")

    def test_rejects_transport_oversize_and_json_failures(self):
        with patch(
            "server.hermes.urllib.request.urlopen",
            side_effect=urllib.error.URLError("offline"),
        ):
            with self.assertRaisesRegex(RuntimeError, "unavailable"):
                HermesTracker().fetch("HES123")

        with patch("server.hermes.MAX_HERMES_RESPONSE_BYTES", 3), patch(
            "server.hermes.urllib.request.urlopen",
            return_value=FakeResponse(b"four"),
        ):
            with self.assertRaisesRegex(RuntimeError, "unexpectedly large"):
                HermesTracker().fetch("HES123")

        with patch(
            "server.hermes.urllib.request.urlopen",
            return_value=FakeResponse(b"not json"),
        ):
            with self.assertRaisesRegex(ValueError, "invalid tracking response"):
                HermesTracker().fetch("HES123")


if __name__ == "__main__":
    unittest.main()
