import unittest

import server.app as app
from server.api_contract import CARRIER_IDS, STAGES, SYNC_STATUSES
from server.tests.contract import CONTRACT, assert_contract, contract_schema
from server.tests.test_app import PACKAGE


class ApiContractTests(unittest.TestCase):
    def test_generated_enums_match_the_openapi_source(self):
        self.assertEqual(CARRIER_IDS, frozenset(contract_schema("CarrierId")["enum"]))
        self.assertEqual(STAGES, frozenset(contract_schema("Stage")["enum"]))
        self.assertEqual(SYNC_STATUSES, frozenset(contract_schema("SyncStatus")["enum"]))
        self.assertIs(app.VALID_CARRIERS, CARRIER_IDS)

    def test_representative_payloads_match_their_schemas(self):
        assert_contract("PackageListResponse", {"packages": [PACKAGE]})
        assert_contract("QueueResponse", {"queued": True, "pending": 1})
        assert_contract("OkResponse", {"ok": True})
        assert_contract("ErrorResponse", {"error": "Package not found"})
        assert_contract("PushConfigResponse", {"available": False, "publicKey": None})
        assert_contract("PushSubscriptionResponse", {"ok": True, "testSent": False})
        assert_contract(
            "NativePushDeviceRequest",
            {
                "token": "ab" * 32,
                "environment": "development",
                "locale": "de",
                "deviceName": "iPhone",
                "sendTest": True,
            },
        )
        assert_contract(
            "NativePushDeviceRequest",
            {
                "token": "cd" * 32,
                "environment": "production",
                "locale": "fr",
                "sendTest": False,
            },
        )
        assert_contract("DeleteNativePushDeviceRequest", {"token": "ab" * 32})
        assert_contract(
            "NotificationPreferences",
            {
                "enabledStages": ["out_for_delivery", "delivered"],
                "quietHoursStart": "22:00",
                "quietHoursEnd": "08:00",
                "timezone": "Europe/Zurich",
            },
        )
        assert_contract("PackageNotificationRequest", {"muted": True})
        assert_contract(
            "AccountExportResponse",
            {
                "exportedAt": "2026-08-05T12:00:00Z",
                "account": {
                    "id": "10000000-0000-0000-0000-000000000001",
                    "email": "owner@example.test",
                },
                "packages": [PACKAGE],
            },
        )
        assert_contract(
            "DeleteAccountRequest", {"confirmation": "owner@example.test"}
        )
        assert_contract(
            "HealthResponse",
            {"ok": True},
        )

    def test_all_supported_http_operations_are_documented(self):
        operations = {
            (method.upper(), path)
            for path, path_item in CONTRACT["paths"].items()
            for method in path_item
            if method in {"get", "post", "patch", "delete"}
        }
        self.assertEqual(
            operations,
            {
                ("GET", "/api/openapi.json"),
                ("GET", "/api/account/export"),
                ("DELETE", "/api/account"),
                ("GET", "/api/packages"),
                ("POST", "/api/packages"),
                ("PATCH", "/api/packages/{packageId}"),
                ("DELETE", "/api/packages/{packageId}"),
                ("POST", "/api/packages/{packageId}/restore"),
                ("DELETE", "/api/packages/{packageId}/permanent"),
                ("PATCH", "/api/packages/{packageId}/notifications"),
                ("POST", "/api/packages/{packageId}/sync"),
                ("POST", "/api/sync"),
                ("GET", "/api/push/config"),
                ("GET", "/api/push/preferences"),
                ("PATCH", "/api/push/preferences"),
                ("POST", "/api/push/subscriptions"),
                ("DELETE", "/api/push/subscriptions"),
                ("POST", "/api/push/devices"),
                ("DELETE", "/api/push/devices"),
                ("GET", "/health"),
            },
        )


if __name__ == "__main__":
    unittest.main()
