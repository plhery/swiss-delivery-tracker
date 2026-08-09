import unittest

from server.api_contract import CARRIER_CAPABILITIES, CARRIER_IDS
from server.carriers import (
    AUTOMATIC_CARRIER_IDS,
    CARRIER_NAMES,
    active_requirements,
    carrier_adapter,
    normalize_carrier_inputs,
    supports_swiss_post_handoff,
)


class CarrierCapabilitiesTests(unittest.TestCase):
    def test_swiss_post_handoff_requires_a_valid_tracked_letter_s10(self):
        self.assertTrue(supports_swiss_post_handoff("LW230226618CH"))
        self.assertFalse(supports_swiss_post_handoff("LW230226619CH"))
        self.assertFalse(supports_swiss_post_handoff("RR230226618CH"))

    def test_registry_covers_every_carrier_and_drives_automatic_support(self):
        self.assertEqual(set(CARRIER_CAPABILITIES), CARRIER_IDS)
        expected = {
            carrier_id
            for carrier_id, definition in CARRIER_CAPABILITIES.items()
            if definition["tracking"]["mode"] == "automatic"
        }
        self.assertEqual(AUTOMATIC_CARRIER_IDS, expected)

    def test_quickpac_uses_the_planzer_adapter_without_losing_its_identity(self):
        self.assertEqual(carrier_adapter("quickpac"), "planzer")
        self.assertEqual(CARRIER_NAMES["quickpac"], "Planzer")

    def test_requirements_are_conditional_and_reject_unrelated_inputs(self):
        self.assertEqual(active_requirements("planzer", "91346097020038089282"), ())
        self.assertEqual(
            active_requirements("planzer", "9999003316119")[0]["field"],
            "trackingUrl",
        )
        self.assertEqual(
            normalize_carrier_inputs("swiss-post", "993412345612345678", "", ""),
            (None, None),
        )
        with self.assertRaisesRegex(ValueError, "not used"):
            normalize_carrier_inputs(
                "swiss-post",
                "993412345612345678",
                "https://example.test/private",
                "",
            )

    def test_dpd_postcode_is_validated_from_its_capability(self):
        self.assertEqual(
            normalize_carrier_inputs("dpd", "06086514587082", "", "8004"),
            (None, "8004"),
        )
        with self.assertRaisesRegex(ValueError, "four-digit"):
            normalize_carrier_inputs("dpd", "06086514587082", "", "80A4")


if __name__ == "__main__":
    unittest.main()
