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
            "HealthResponse",
            {
                "ok": True,
                "pending_sync_jobs": 0,
                "last_summary": {"checked": 1, "updated": 1},
                "last_error": None,
            },
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
                ("GET", "/api/packages"),
                ("POST", "/api/packages"),
                ("PATCH", "/api/packages/{packageId}"),
                ("DELETE", "/api/packages/{packageId}"),
                ("POST", "/api/packages/{packageId}/restore"),
                ("POST", "/api/packages/{packageId}/sync"),
                ("POST", "/api/sync"),
                ("GET", "/api/push/config"),
                ("POST", "/api/push/subscriptions"),
                ("DELETE", "/api/push/subscriptions"),
                ("GET", "/health"),
            },
        )


if __name__ == "__main__":
    unittest.main()
