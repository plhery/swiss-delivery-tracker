import json
import unittest
from io import BytesIO

from server.swiss_post import SwissPostTracker, expected_delivery, parse_shipment


class Response(BytesIO):
    def __init__(self, payload, headers=None):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        super().__init__(body)
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False


class Opener:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


class SwissPostTests(unittest.TestCase):
    def test_delivery_eta_includes_the_available_time_interval(self):
        self.assertEqual(
            expected_delivery(
                {
                    "calculatedDeliveryDate": "2026-08-07T00:00:00+02:00",
                    "deliveryTimeInterval": {
                        "start": "2026-08-07T13:15:00+02:00",
                        "end": "2026-08-07T15:00:00+02:00",
                    },
                }
            ),
            "2026-08-07 13:15–15:00",
        )
        self.assertEqual(
            expected_delivery(
                {
                    "calculatedDeliveryDate": None,
                    "deliveryRange": {
                        "start": "2026-08-10T00:00:00+02:00",
                        "end": "2026-08-11T00:00:00+02:00",
                    },
                }
            ),
            "2026-08-10",
        )
        self.assertEqual(
            expected_delivery(
                {
                    "calculatedDeliveryDate": "2026-08-07",
                    "deliveryTimeInterval": "13:15–15:00",
                }
            ),
            "2026-08-07 13:15–15:00",
        )

    def test_parses_official_event_labels_and_detects_delivery_vehicle_loading(self):
        result = parse_shipment(
            {
                "globalStatus": "TO_BE_DELIVERED",
                "lastEventDateTime": "2026-08-07T06:55:43+02:00",
                "calculatedDeliveryDate": "2026-08-07T00:00:00+02:00",
            },
            [
                {
                    "eventCode": "PARCEL.*.2.1201",
                    "timestamp": "2026-08-06T14:53:55+02:00",
                },
                {
                    "eventCode": "PARCEL.*.2.1003",
                    "timestamp": "2026-08-07T06:55:43+02:00",
                    "city": "Zürich",
                    "zip": "8000",
                },
            ],
            {
                "PARCEL.*.*.1201.*": "Sorted for delivery",
                "PARCEL.*.*.1003.*": "Loading into delivery vehicle",
            },
        )

        self.assertEqual(result["status"], "out_for_delivery")
        self.assertEqual(result["last_status_text"], "Loading into delivery vehicle")
        self.assertEqual(result["global_status"], "TO_BE_DELIVERED")
        self.assertEqual(result["events"][0]["stage"], "out_for_delivery")
        self.assertEqual(result["events"][0]["location"], "Zürich 8000")
        self.assertEqual(result["events"][1]["description"], "Sorted for delivery")

    def test_fetches_the_separate_event_history_and_translation_dictionary(self):
        opener = Opener(
            Response(
                {"userIdentifier": "anonymous-user"},
                {"x-csrf-token": "csrf-token"},
            ),
            Response({"hash": "search/hash"}),
            Response(
                [
                    {
                        "identity": "shipment/id",
                        "globalStatus": "TO_BE_DELIVERED",
                        "lastEventDateTime": "2026-08-07T06:55:43+02:00",
                        "calculatedDeliveryDate": "2026-08-07T00:00:00+02:00",
                        "deliveryTimeInterval": {
                            "start": "2026-08-07T13:00:00+02:00",
                            "end": "2026-08-07T15:00:00+02:00",
                        },
                    }
                ]
            ),
            Response(
                [
                    {
                        "eventCode": "PARCEL.*.2.1003",
                        "timestamp": "2026-08-07T06:55:43+02:00",
                    }
                ]
            ),
            Response(
                {
                    "shipment-text--": {
                        "PARCEL.*.*.1003.*": "Loading into delivery vehicle"
                    }
                }
            ),
        )
        tracker = SwissPostTracker(opener_factory=lambda: opener)

        result = tracker.fetch("993412345612345678")

        self.assertEqual(result["status"], "out_for_delivery")
        self.assertEqual(result["expected_delivery"], "2026-08-07 13:00–15:00")
        self.assertEqual(result["events"][0]["description"], "Loading into delivery vehicle")
        urls = [request.full_url for request, _ in opener.requests]
        self.assertIn("/shipment/id/shipment%2Fid/events", urls[3])
        self.assertIn("/translations/en/shipment-text-messages", urls[4])
        history_request = opener.requests[1][0]
        self.assertEqual(history_request.get_method(), "POST")
        self.assertEqual(
            json.loads(history_request.data),
            {"searchQuery": "993412345612345678"},
        )

    def test_event_endpoint_failure_keeps_the_global_status_fallback(self):
        opener = Opener(
            Response(
                {"userIdentifier": "anonymous-user"},
                {"x-csrf-token": "csrf-token"},
            ),
            Response({"hash": "search-hash"}),
            Response(
                [
                    {
                        "identity": "shipment-id",
                        "globalStatus": "TO_BE_DELIVERED",
                        "lastEventDateTime": "2026-08-07T06:55:43+02:00",
                        "calculatedDeliveryDate": "2026-08-07T00:00:00+02:00",
                    }
                ]
            ),
            OSError("events temporarily unavailable"),
        )

        result = SwissPostTracker(opener_factory=lambda: opener).fetch("tracking")

        self.assertEqual(result["status"], "in_transit")
        self.assertEqual(result["last_status_text"], "TO_BE_DELIVERED")
        self.assertEqual(result["events"], [])
        self.assertEqual(len(opener.requests), 4)


if __name__ == "__main__":
    unittest.main()
