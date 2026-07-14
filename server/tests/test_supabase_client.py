from io import BytesIO
import json
import unittest
import urllib.error
import urllib.parse
from unittest.mock import Mock, patch

from server.supabase_client import SupabaseError, SupabaseServiceClient


class Response:
    def __init__(self, body=b""):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self):
        return self.body


class SupabaseServiceClientTests(unittest.TestCase):
    def setUp(self):
        self.client = SupabaseServiceClient(
            "https://supabase.example.test/", "anon-key", "service-key", timeout=7
        )

    @patch("server.supabase_client.urllib.request.urlopen")
    def test_request_serializes_json_and_service_headers(self, urlopen):
        urlopen.return_value = Response(b'{"saved": true}')

        result = self.client._request(
            "/rest/v1/packages",
            method="POST",
            body={"label": "Grüezi"},
            token="user-token",
            prefer="return=minimal",
        )

        self.assertEqual(result, {"saved": True})
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "https://supabase.example.test/rest/v1/packages")
        self.assertEqual(request.method, "POST")
        self.assertEqual(json.loads(request.data), {"label": "Grüezi"})
        self.assertEqual(request.get_header("Authorization"), "Bearer user-token")
        self.assertEqual(request.get_header("Apikey"), "service-key")
        self.assertEqual(request.get_header("Prefer"), "return=minimal")
        urlopen.assert_called_once_with(request, timeout=7)

    @patch("server.supabase_client.urllib.request.urlopen")
    def test_request_returns_none_for_empty_responses(self, urlopen):
        urlopen.return_value = Response()
        self.assertIsNone(self.client._request("/rest/v1/packages"))

    @patch("server.supabase_client.urllib.request.urlopen")
    def test_request_normalizes_http_and_network_errors(self, urlopen):
        conflict = urllib.error.HTTPError(
            "https://example.test", 409, "Conflict", {}, BytesIO(b'{"message":"Duplicate"}')
        )
        self.addCleanup(conflict.close)
        urlopen.side_effect = conflict
        with self.assertRaisesRegex(SupabaseError, r"\(409\): Duplicate"):
            self.client._request("/rest/v1/packages", method="POST")

        gateway = urllib.error.HTTPError(
            "https://example.test", 502, "Bad Gateway", {}, BytesIO(b"gateway down")
        )
        self.addCleanup(gateway.close)
        urlopen.side_effect = gateway
        with self.assertRaisesRegex(SupabaseError, "gateway down"):
            self.client._request("/rest/v1/packages")

        urlopen.side_effect = urllib.error.URLError("connection refused")
        with self.assertRaisesRegex(SupabaseError, "unreachable: connection refused"):
            self.client._request("/rest/v1/packages")

    @patch("server.supabase_client.urllib.request.urlopen")
    def test_auth_user_uses_the_anon_key_and_maps_expired_tokens(self, urlopen):
        urlopen.return_value = Response(b'{"id":"user-1"}')
        self.assertEqual(self.client.auth_user("access-token"), {"id": "user-1"})
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "https://supabase.example.test/auth/v1/user")
        self.assertEqual(request.get_header("Apikey"), "anon-key")
        self.assertEqual(request.get_header("Authorization"), "Bearer access-token")

        unauthorized = urllib.error.HTTPError(
            "https://example.test", 401, "Unauthorized", {}, BytesIO(b"expired")
        )
        self.addCleanup(unauthorized.close)
        urlopen.side_effect = unauthorized
        with self.assertRaisesRegex(SupabaseError, "invalid or expired"):
            self.client.auth_user("expired-token")

    def test_package_queries_and_writes_use_expected_postgrest_contract(self):
        self.client._request = Mock(return_value=[{"id": "pkg-1"}])
        rows = self.client.list_active_packages("user-1")
        self.assertEqual(rows, [{"id": "pkg-1"}])
        path = self.client._request.call_args.args[0]
        parsed = urllib.parse.urlsplit(path)
        query = urllib.parse.parse_qs(parsed.query)
        self.assertEqual(parsed.path, "/rest/v1/packages")
        self.assertEqual(query["user_id"], ["eq.user-1"])
        self.assertEqual(query["archived_at"], ["is.null"])
        self.assertEqual(query["current_stage"], ["not.in.(delivered,returned)"])

        self.client._request.reset_mock()
        self.client.update_package("pkg/1", {"sync_status": "ok"})
        update = self.client._request.call_args
        self.assertIn("id=eq.pkg%2F1", update.args[0])
        self.assertEqual(update.kwargs["method"], "PATCH")
        self.assertEqual(update.kwargs["prefer"], "return=minimal")

    def test_event_inserts_are_idempotent_and_empty_batches_are_skipped(self):
        self.client._request = Mock()
        self.client.insert_events([])
        self.client._request.assert_not_called()

        events = [{"package_id": "pkg-1", "provider_event_id": "event-1"}]
        self.client.insert_events(events)
        call = self.client._request.call_args
        self.assertIn("on_conflict=package_id,provider_event_id", call.args[0])
        self.assertEqual(call.kwargs["method"], "POST")
        self.assertEqual(call.kwargs["body"], events)
        self.assertEqual(call.kwargs["prefer"], "resolution=ignore-duplicates,return=minimal")


if __name__ == "__main__":
    unittest.main()
