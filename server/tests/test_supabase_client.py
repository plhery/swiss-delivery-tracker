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
            "https://supabase.example.test/", "service-key", timeout=7
        )

    @patch("server.supabase_client.urllib.request.urlopen")
    def test_request_serializes_json_and_service_headers(self, urlopen):
        urlopen.return_value = Response(b'{"saved": true}')

        result = self.client._request(
            "/rest/v1/packages",
            method="POST",
            body={"label": "Grüezi"},
            prefer="return=minimal",
        )

        self.assertEqual(result, {"saved": True})
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "https://supabase.example.test/rest/v1/packages")
        self.assertEqual(request.method, "POST")
        self.assertEqual(json.loads(request.data), {"label": "Grüezi"})
        self.assertEqual(request.get_header("Authorization"), "Bearer service-key")
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
        with self.assertRaisesRegex(SupabaseError, r"\(409\): Duplicate") as raised:
            self.client._request("/rest/v1/packages", method="POST")
        self.assertEqual(raised.exception.status, 409)

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

    def test_package_queries_and_writes_use_shared_postgrest_contract(self):
        self.client._request = Mock(return_value=[{"id": "pkg-1"}])
        self.assertEqual(self.client.list_packages(), [{"id": "pkg-1"}])
        path = self.client._request.call_args.args[0]
        parsed = urllib.parse.urlsplit(path)
        query = urllib.parse.parse_qs(parsed.query)
        self.assertEqual(parsed.path, "/rest/v1/packages")
        self.assertNotIn("user_id", query)
        self.assertEqual(query["archived_at"], ["is.null"])
        self.assertEqual(query["order"], ["created_at.desc"])
        self.assertIn("tracking_events", query["select"][0])

        self.client._request.reset_mock()
        self.client.get_package("pkg-1")
        self.assertIn("id=eq.pkg-1", self.client._request.call_args.args[0])

        self.client._request.return_value = []
        self.assertIsNone(self.client.get_package("missing"))

    def test_create_and_delete_package(self):
        self.client._request = Mock(side_effect=[[{"id": "pkg-1"}], [{"id": "pkg-1"}]])
        package = self.client.create_package("TRACKING1", "Coffee", "swiss-post")
        self.assertEqual(package, {"id": "pkg-1"})
        create = self.client._request.call_args_list[0]
        self.assertEqual(create.args[0], "/rest/v1/packages")
        self.assertEqual(create.kwargs["method"], "POST")
        self.assertEqual(
            create.kwargs["body"],
            {
                "user_id": None,
                "tracking_number": "TRACKING1",
                "label": "Coffee",
                "carrier": "swiss-post",
            },
        )

        self.client._request = Mock()
        self.client.delete_package("pkg/1")
        delete = self.client._request.call_args
        self.assertIn("id=eq.pkg%2F1", delete.args[0])
        self.assertEqual(delete.kwargs["method"], "DELETE")

    def test_create_package_requires_insert_and_reload_results(self):
        self.client._request = Mock(return_value=[])
        with self.assertRaisesRegex(SupabaseError, "did not return"):
            self.client.create_package("TRACKING1", "", "unknown")

        self.client._request = Mock(side_effect=[[{"id": "pkg-1"}], []])
        with self.assertRaisesRegex(SupabaseError, "could not be reloaded"):
            self.client.create_package("TRACKING1", "", "unknown")

    def test_sync_queries_and_writes_use_expected_contract(self):
        self.client._request = Mock(return_value=[{"id": "pkg-1"}])
        rows = self.client.list_active_packages()
        self.assertEqual(rows, [{"id": "pkg-1"}])
        path = self.client._request.call_args.args[0]
        parsed = urllib.parse.urlsplit(path)
        query = urllib.parse.parse_qs(parsed.query)
        self.assertEqual(query["current_stage"], ["not.in.(delivered,returned)"])
        self.assertNotIn("user_id", query)

        self.client._request.reset_mock()
        self.client.update_package("pkg/1", {"sync_status": "ok"})
        update = self.client._request.call_args
        self.assertIn("id=eq.pkg%2F1", update.args[0])
        self.assertEqual(update.kwargs["method"], "PATCH")

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

    def test_push_subscription_lifecycle_uses_server_only_tables(self):
        self.client._request = Mock(return_value=[{"id": "sub-1"}])
        result = self.client.upsert_push_subscription(
            "https://push.example.test/token", "p256dh-value", "auth-value", "iPhone"
        )
        self.assertEqual(result, {"id": "sub-1"})
        create = self.client._request.call_args
        self.assertIn("on_conflict=endpoint", create.args[0])
        self.assertEqual(create.kwargs["method"], "POST")
        self.assertEqual(create.kwargs["body"]["disabled_at"], None)
        self.assertIn("merge-duplicates", create.kwargs["prefer"])

        self.client._request = Mock()
        self.client.delete_push_subscription("https://push.example.test/a/b")
        delete = self.client._request.call_args
        self.assertIn("endpoint=eq.https%3A%2F%2Fpush.example.test%2Fa%2Fb", delete.args[0])
        self.assertEqual(delete.kwargs["method"], "DELETE")

    def test_pending_push_queries_acknowledgements_and_status_updates(self):
        self.client._request = Mock(return_value=[{"event_id": "event-1"}])
        self.assertEqual(
            self.client.list_pending_push_notifications(), [{"event_id": "event-1"}]
        )
        self.assertIn("pending_push_notifications", self.client._request.call_args.args[0])

        self.client._request = Mock()
        self.client.record_push_deliveries("sub-1", [])
        self.client._request.assert_not_called()
        self.client.record_push_deliveries("sub-1", ["event-1", "event-2"])
        delivery = self.client._request.call_args
        self.assertEqual(delivery.kwargs["method"], "POST")
        self.assertEqual(len(delivery.kwargs["body"]), 2)

        self.client.update_push_subscription("sub/1", {"last_error": None})
        update = self.client._request.call_args
        self.assertIn("id=eq.sub%2F1", update.args[0])
        self.assertEqual(update.kwargs["method"], "PATCH")


if __name__ == "__main__":
    unittest.main()
