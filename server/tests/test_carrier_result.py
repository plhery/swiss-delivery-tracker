import unittest

from server.carrier_result import normalize_carrier_result


class CarrierResultTests(unittest.TestCase):
    def test_normalizes_unknown_status_and_preserves_adapter_metadata(self):
        result = normalize_carrier_result(
            {
                "status": "provider-added-a-new-status",
                "events": [{"time": "2026-08-05", "description": "On its way"}],
                "provider_reference": "safe-metadata",
            }
        )

        self.assertEqual(result["status"], "unknown")
        self.assertEqual(result["events"][0]["description"], "On its way")
        self.assertEqual(result["provider_reference"], "safe-metadata")

    def test_rejects_malformed_result_and_event_shapes(self):
        invalid = (
            None,
            [],
            {"events": "not-a-list"},
            {"events": ["not-an-object"]},
            {"events": [{"time": 123}]},
            {"expected_delivery": {"date": "2026-08-05"}},
        )
        for value in invalid:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "carrier adapter"):
                normalize_carrier_result(value)


if __name__ == "__main__":
    unittest.main()
