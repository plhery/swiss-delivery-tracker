import unittest

from server.hermes import parse_tracking_response, status_for_id


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


if __name__ == "__main__":
    unittest.main()
