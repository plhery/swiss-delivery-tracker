import json
import unittest
import urllib.error
import urllib.parse
from datetime import datetime, timezone
from io import BytesIO
from unittest.mock import Mock, patch

from server.supabase_client import (
    SupabaseError,
    SupabaseServiceClient,
    SupabaseUserClient,
)


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
    def test_user_client_combines_public_api_key_with_user_token(self, urlopen):
        urlopen.return_value = Response(b"[]")
        client = SupabaseUserClient(
            "https://supabase.example.test",
            "publishable-key",
            "signed-user-token",
        )

        client.list_packages()

        request = urlopen.call_args.args[0]
        self.assertEqual(request.get_header("Apikey"), "publishable-key")
        self.assertEqual(request.get_header("Authorization"), "Bearer signed-user-token")

    @patch("server.supabase_client.urllib.request.urlopen")
    def test_request_normalizes_http_and_network_errors(self, urlopen):
        conflict = urllib.error.HTTPError(
            "https://example.test",
            409,
            "Conflict",
            {},
            BytesIO(b'{"message":"Duplicate","code":"23505"}'),
        )
        self.addCleanup(conflict.close)
        urlopen.side_effect = conflict
        with self.assertRaisesRegex(SupabaseError, r"\(409\): Duplicate") as raised:
            self.client._request("/rest/v1/packages", method="POST")
        self.assertEqual(raised.exception.status, 409)
        self.assertEqual(raised.exception.code, "23505")

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
        self.assertIn("tracking_url", query["select"][0])
        self.assertIn("dpd_postcode", query["select"][0])
        self.assertIn("archived_at", query["select"][0])
        self.assertIn("notifications_muted", query["select"][0])

        self.client._request.reset_mock()
        self.client.list_packages(include_archived=True)
        archived_query = urllib.parse.parse_qs(
            urllib.parse.urlsplit(self.client._request.call_args.args[0]).query
        )
        self.assertNotIn("archived_at", archived_query)

        self.client._request.reset_mock()
        self.client.get_package("pkg-1")
        self.assertIn("id=eq.pkg-1", self.client._request.call_args.args[0])

        self.client._request.return_value = []
        self.assertIsNone(self.client.get_package("missing"))

    def test_create_archive_and_restore_package(self):
        self.client._request = Mock(side_effect=[[{"id": "pkg-1"}], [{"id": "pkg-1"}]])
        package = self.client.create_package("TRACKING1", "Coffee", "swiss-post")
        self.assertEqual(package, {"id": "pkg-1"})
        create = self.client._request.call_args_list[0]
        self.assertEqual(create.args[0], "/rest/v1/packages")
        self.assertEqual(create.kwargs["method"], "POST")
        self.assertEqual(
            create.kwargs["body"],
            {
                "tracking_number": "TRACKING1",
                "label": "Coffee",
                "carrier": "swiss-post",
            },
        )

        tracking_url = "https://trackandtrace.planzergroup.com/shared/sendungen/1?accessKey=key"
        self.client._request = Mock(side_effect=[[{"id": "pkg-2"}], [{"id": "pkg-2"}]])
        self.client.create_package("TRACKING2", "Plants", "planzer", tracking_url)
        self.assertEqual(
            self.client._request.call_args_list[0].kwargs["body"]["tracking_url"],
            tracking_url,
        )

        self.client._request = Mock(side_effect=[[{"id": "pkg-3"}], [{"id": "pkg-3"}]])
        self.client.create_package("06086514587082", "Shoes", "dpd", None, "8004")
        self.assertEqual(
            self.client._request.call_args_list[0].kwargs["body"]["dpd_postcode"],
            "8004",
        )

        self.client._request = Mock()
        self.client.archive_package("pkg/1")
        archive = self.client._request.call_args
        self.assertIn("id=eq.pkg%2F1", archive.args[0])
        self.assertEqual(archive.kwargs["method"], "PATCH")
        self.assertIsNotNone(archive.kwargs["body"]["archived_at"])

        self.client.restore_package("pkg/1")
        restore = self.client._request.call_args
        self.assertEqual(restore.kwargs["body"], {"archived_at": None})

        self.client._request = Mock(return_value=[{"id": "pkg/1"}])
        self.assertTrue(self.client.delete_archived_package("pkg/1"))
        delete = self.client._request.call_args
        self.assertIn("id=eq.pkg%2F1", delete.args[0])
        self.assertIn("archived_at=not.is.null", delete.args[0])
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
        self.assertNotIn("sync_status", query)
        self.assertIn("swiss-post", query["carrier"][0])
        self.assertIn("dachser", query["carrier"][0])
        self.assertEqual(
            query["order"], ["last_synced_at.asc.nullsfirst,created_at.asc"]
        )
        self.assertIn("dpd_postcode", query["select"][0])
        self.assertNotIn("user_id", query)

        self.client._request.reset_mock()
        self.client.update_package("pkg/1", {"sync_status": "ok"})
        update = self.client._request.call_args
        self.assertIn("id=eq.pkg%2F1", update.args[0])
        self.assertEqual(update.kwargs["method"], "PATCH")

    def test_old_deliveries_are_archived_in_one_update(self):
        self.client._request = Mock(return_value=[{"id": "old-1"}, {"id": "old-2"}])
        cutoff = datetime(2026, 6, 1, tzinfo=timezone.utc)

        self.assertEqual(self.client.archive_delivered_before(cutoff), 2)

        call = self.client._request.call_args
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(call.args[0]).query)
        self.assertEqual(query["archived_at"], ["is.null"])
        self.assertEqual(query["current_stage"], ["eq.delivered"])
        self.assertEqual(query["last_synced_at"], ["lt.2026-06-01T00:00:00+00:00"])
        self.assertEqual(call.kwargs["method"], "PATCH")
        self.assertEqual(call.kwargs["prefer"], "return=representation")

        with self.assertRaisesRegex(ValueError, "timezone"):
            self.client.archive_delivered_before(cutoff.replace(tzinfo=None))

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
            "user-1",
            "https://push.example.test/token",
            "p256dh-value",
            "auth-value",
            "iPhone",
        )
        self.assertEqual(result, {"id": "sub-1"})
        create = self.client._request.call_args
        self.assertIn("on_conflict=endpoint", create.args[0])
        self.assertEqual(create.kwargs["method"], "POST")
        self.assertEqual(create.kwargs["body"]["user_id"], "user-1")
        self.assertEqual(create.kwargs["body"]["disabled_at"], None)
        self.assertIn("merge-duplicates", create.kwargs["prefer"])

        self.client._request = Mock()
        self.client.delete_push_subscription("user-1", "https://push.example.test/a/b")
        delete = self.client._request.call_args
        self.assertIn("user_id=eq.user-1", delete.args[0])
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

    def test_account_deletion_uses_the_server_only_auth_admin_endpoint(self):
        self.client._request = Mock()

        self.client.delete_auth_user("user/1")

        call = self.client._request.call_args
        self.assertEqual(call.args[0], "/auth/v1/admin/users/user%2F1")
        self.assertEqual(call.kwargs["method"], "DELETE")


class SupabaseUserClientMutationTests(unittest.TestCase):
    def setUp(self):
        self.client = SupabaseUserClient(
            "https://supabase.example.test",
            "publishable-key",
            "signed-user-token",
        )

    def test_create_uses_the_validated_quota_rpc_and_reloads_the_row(self):
        self.client._request = Mock(
            side_effect=[{"id": "pkg-1"}, [{"id": "pkg-1", "label": "Coffee"}]]
        )

        package = self.client.create_package(
            "TRACKING1",
            "Coffee",
            "dpd",
            None,
            "8004",
        )

        self.assertEqual(package["id"], "pkg-1")
        create = self.client._request.call_args_list[0]
        self.assertEqual(create.args[0], "/rest/v1/rpc/create_owned_package")
        self.assertEqual(create.kwargs["method"], "POST")
        self.assertEqual(
            create.kwargs["body"],
            {
                "p_tracking_number": "TRACKING1",
                "p_label": "Coffee",
                "p_carrier": "dpd",
                "p_tracking_url": None,
                "p_dpd_postcode": "8004",
            },
        )
        self.assertIn("id=eq.pkg-1", self.client._request.call_args_list[1].args[0])

    def test_composite_rpc_list_shape_is_accepted(self):
        self.client._request = Mock(
            side_effect=[[{"id": "pkg-1"}], [{"id": "pkg-1"}]]
        )

        self.assertEqual(
            self.client.create_package("TRACKING1", "", "unknown")["id"],
            "pkg-1",
        )

    def test_user_updates_can_only_call_approved_package_rpcs(self):
        self.client._request = Mock(return_value=True)

        self.client.update_package("pkg-1", {"label": "Coffee"})
        rename = self.client._request.call_args
        self.assertEqual(rename.args[0], "/rest/v1/rpc/rename_owned_package")
        self.assertEqual(
            rename.kwargs["body"],
            {"p_package_id": "pkg-1", "p_label": "Coffee"},
        )

        self.client.archive_package("pkg-1")
        archive = self.client._request.call_args
        self.assertEqual(archive.args[0], "/rest/v1/rpc/set_owned_package_archived")
        self.assertTrue(archive.kwargs["body"]["p_archived"])

        self.client.restore_package("pkg-1")
        self.assertFalse(self.client._request.call_args.kwargs["body"]["p_archived"])

        self.assertTrue(self.client.delete_archived_package("pkg-1"))
        delete = self.client._request.call_args
        self.assertEqual(delete.args[0], "/rest/v1/rpc/delete_owned_archived_package")
        self.assertEqual(delete.kwargs["body"], {"p_package_id": "pkg-1"})

        self.client.update_package("pkg-1", {"notifications_muted": True})
        notifications = self.client._request.call_args
        self.assertEqual(
            notifications.args[0],
            "/rest/v1/rpc/set_owned_package_notifications_muted",
        )
        self.assertEqual(
            notifications.kwargs["body"],
            {"p_package_id": "pkg-1", "p_muted": True},
        )

        with self.assertRaisesRegex(ValueError, "approved mutation"):
            self.client.update_package("pkg-1", {"sync_status": "ok"})

    def test_notification_preferences_use_owner_scoped_reads_and_rpc_writes(self):
        stored = {
            "enabled_stages": ["out_for_delivery", "delivered"],
            "quiet_hours_start": "22:00:00",
            "quiet_hours_end": "08:00:00",
            "timezone": "Europe/Zurich",
        }
        self.client._request = Mock(return_value=[stored])

        self.assertEqual(self.client.get_notification_preferences(), stored)
        read = self.client._request.call_args
        self.assertIn("/rest/v1/notification_preferences?", read.args[0])
        self.assertNotIn("user_id", read.args[0])

        self.client._request = Mock(return_value=stored)
        self.assertEqual(
            self.client.set_notification_preferences(
                ["out_for_delivery", "delivered"],
                "22:00",
                "08:00",
                "Europe/Zurich",
            ),
            stored,
        )
        write = self.client._request.call_args
        self.assertEqual(
            write.args[0], "/rest/v1/rpc/set_owned_notification_preferences"
        )
        self.assertEqual(write.kwargs["method"], "POST")
        self.assertEqual(write.kwargs["body"]["p_quiet_hours_start"], "22:00")

        self.client._request = Mock(return_value=[])
        defaults = self.client.get_notification_preferences()
        self.assertIn("in_transit", defaults["enabled_stages"])
        self.assertIsNone(defaults["quiet_hours_start"])

        self.client._request = Mock(return_value=[])
        with self.assertRaisesRegex(SupabaseError, "did not return"):
            self.client.set_notification_preferences(
                ["delivered"], None, None, "Europe/Zurich"
            )

    def test_false_mutation_results_are_reported_as_not_found(self):
        self.client._request = Mock(return_value=False)

        with self.assertRaises(SupabaseError) as raised:
            self.client.update_package("other-owner", {"label": "Nope"})

        self.assertEqual(raised.exception.status, 404)


if __name__ == "__main__":
    unittest.main()
