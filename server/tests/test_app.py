import base64
import http.client
import json
import os
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock, patch

import server.app as app
from server.rate_limit import RateLimiter
from server.supabase_auth import SupabaseAuthError, SupabaseUser
from server.supabase_client import SupabaseError
from server.tests.contract import CONTRACT, assert_contract
from server.tracking_sync import SyncSummary

PACKAGE = {
    "id": "40000000-0000-0000-0000-000000000004",
    "tracking_number": "993412345612345678",
    "label": "Coffee",
    "carrier": "swiss-post",
    "created_at": "2026-07-15T00:00:00Z",
    "expected_delivery": None,
    "last_status_text": None,
    "last_synced_at": None,
    "sync_status": "pending",
    "sync_error": None,
    "tracking_url": None,
    "dpd_postcode": None,
    "archived_at": None,
    "notifications_muted": False,
    "tracking_events": [],
}
PUSH_ENDPOINT = "https://fcm.googleapis.com/fcm/send/device-token"
PUSH_PUBLIC_KEY = base64.urlsafe_b64encode(b"\x04" + b"\x01" * 64).rstrip(b"=").decode()
PUSH_AUTH_KEY = base64.urlsafe_b64encode(b"\x02" * 16).rstrip(b"=").decode()


class QuietHandler(app.Handler):
    def log_message(self, format, *args):
        return


class FakeService:
    def __init__(self, summary=None, error=None):
        self.summary = summary or SyncSummary(checked=1, updated=1)
        self.error = error
        self.client = Mock()
        self.client.list_packages.side_effect = self._list_packages
        self.client.list_active_packages.return_value = [PACKAGE]
        self.client.create_package.side_effect = self._create_package
        self.client.get_package.return_value = PACKAGE
        self.client.update_package.side_effect = self._update_package
        self.client.archive_package.side_effect = self._archive_package
        self.client.restore_package.side_effect = self._restore_package
        self.client.delete_archived_package.return_value = True
        self.client.archive_delivered_before.return_value = 0
        self.client.upsert_push_subscription.return_value = {
            "id": "sub-1",
            "endpoint": PUSH_ENDPOINT,
            "p256dh": PUSH_PUBLIC_KEY,
            "auth": PUSH_AUTH_KEY,
        }
        self.client.upsert_native_push_device.return_value = {
            "id": "native-device-1",
            "token": "ab" * 32,
            "environment": "development",
            "locale": "fr",
        }
        self.client.get_notification_preferences.return_value = {
            "enabled_stages": ["out_for_delivery", "delivered"],
            "quiet_hours_start": "22:00:00",
            "quiet_hours_end": "08:00:00",
            "timezone": "Europe/Zurich",
        }
        self.client.set_notification_preferences.return_value = (
            self.client.get_notification_preferences.return_value
        )
        self.notifier = None
        self.sync = Mock(side_effect=self._sync)
        self.sync_package = Mock(side_effect=lambda package: self._sync())

    def _maybe_raise(self):
        if self.error:
            raise self.error

    def _list_packages(self, include_archived=False):
        self._maybe_raise()
        return [PACKAGE]

    def _create_package(
        self,
        tracking_number,
        label,
        carrier,
        tracking_url=None,
        dpd_postcode=None,
    ):
        self._maybe_raise()
        return {
            **PACKAGE,
            "tracking_number": tracking_number,
            "label": label,
            "carrier": carrier,
            "tracking_url": tracking_url,
            "dpd_postcode": dpd_postcode,
        }

    def _archive_package(self, package_id):
        self._maybe_raise()

    def _restore_package(self, package_id):
        self._maybe_raise()

    def _update_package(self, package_id, values):
        self._maybe_raise()

    def _sync(self):
        self._maybe_raise()
        return self.summary


class AppHttpTests(unittest.TestCase):
    def setUp(self):
        self.original_dist = app.DIST
        self.original_service = app.SERVICE
        self.original_sync_jobs = app.SYNC_JOBS
        self.original_authenticator = app.AUTHENTICATOR
        self.original_rate_limiter = app.RATE_LIMITER
        self.original_state = dict(app.STATE)
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        (root / "assets").mkdir()
        (root / "index.html").write_text("<html>current shell</html>", encoding="utf-8")
        (root / "assets" / "app.js").write_text("console.log('ok')", encoding="utf-8")
        app.DIST = root.resolve()
        app.SERVICE = FakeService()
        app.SYNC_JOBS = Mock(service=app.SERVICE)
        app.AUTHENTICATOR = Mock()
        app.AUTHENTICATOR.validate.return_value = SupabaseUser(
            "10000000-0000-0000-0000-000000000001",
            "owner@example.test",
            datetime.now(timezone.utc),
            "30000000-0000-0000-0000-000000000003",
        )
        app.AUTHENTICATOR.user_client.side_effect = lambda _token: (
            app.SERVICE.client if app.SERVICE else Mock()
        )
        app.RATE_LIMITER = RateLimiter()
        app.SYNC_JOBS.enqueue_all.return_value = True
        app.SYNC_JOBS.enqueue_package.return_value = True
        app.SYNC_JOBS.pending_count.return_value = 1
        app.STATE.clear()
        app.STATE.update(last_scheduled_sync=123, last_summary={"checked": 1}, last_error=None)
        self.server = app.ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()
        app.DIST = self.original_dist
        app.SERVICE = self.original_service
        app.SYNC_JOBS = self.original_sync_jobs
        app.AUTHENTICATOR = self.original_authenticator
        app.RATE_LIMITER = self.original_rate_limiter
        app.STATE.clear()
        app.STATE.update(self.original_state)

    def request(
        self,
        method,
        path,
        headers=None,
        payload=None,
        raw_body=None,
        authenticate=True,
    ):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        body = raw_body
        request_headers = dict(headers or {})
        if authenticate and path.startswith("/api/"):
            request_headers.setdefault("Authorization", "Bearer valid-user-token")
        if payload is not None:
            body = json.dumps(payload).encode()
            request_headers["Content-Type"] = "application/json"
        connection.request(method, path, body=body, headers=request_headers)
        response = connection.getresponse()
        response_body = response.read()
        result = (response.status, dict(response.getheaders()), response_body)
        connection.close()
        return result

    def test_health_reports_only_public_readiness_and_missing_configuration(self):
        status, headers, body = self.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(json.loads(body), {"ok": True})

        app.SERVICE = None
        status, _, body = self.request("GET", "/health")
        self.assertEqual(status, 503)
        self.assertFalse(json.loads(body)["ok"])

        status, _, body = self.request("HEAD", "/health")
        self.assertEqual(status, 503)
        self.assertEqual(body, b"")

    def test_openapi_contract_is_served_without_database_configuration(self):
        app.SERVICE = None
        status, headers, body = self.request("GET", "/api/openapi.json")

        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(json.loads(body), CONTRACT)

        with patch.object(app, "API_CONTRACT", Path(self.temp.name) / "missing.json"):
            status, _, body = self.request("GET", "/api/openapi.json")
        self.assertEqual(status, 503)
        assert_contract("ErrorResponse", json.loads(body))

    def test_api_routes_validate_supabase_bearer_tokens(self):
        status, _, body = self.request("GET", "/api/packages", authenticate=False)
        self.assertEqual(status, 401)
        self.assertEqual(json.loads(body), {"error": "Authentication is required"})

        authenticator = app.AUTHENTICATOR
        app.AUTHENTICATOR = None
        status, _, body = self.request("GET", "/api/packages")
        self.assertEqual(status, 503)
        self.assertIn("not configured", json.loads(body)["error"])
        app.AUTHENTICATOR = authenticator

        status, _, _ = self.request(
            "GET",
            "/api/packages",
            headers={"Authorization": "Bearer signed-user-token"},
        )
        self.assertEqual(status, 200)
        app.AUTHENTICATOR.validate.assert_called_with("signed-user-token")
        app.AUTHENTICATOR.user_client.assert_called_with("signed-user-token")

        app.AUTHENTICATOR.validate.side_effect = SupabaseAuthError("expired")
        status, _, body = self.request(
            "POST",
            "/api/sync",
            headers={"Authorization": "Bearer expired-token"},
        )
        self.assertEqual(status, 401)
        self.assertEqual(json.loads(body), {"error": "Authentication is required"})

    def test_api_rate_limits_are_per_user_and_send_retry_after(self):
        with patch("server.app.api_rate_policy", return_value=("test", 1, 30)):
            status, _, _ = self.request("GET", "/api/packages")
            self.assertEqual(status, 200)

            status, headers, body = self.request("GET", "/api/packages")
            self.assertEqual(status, 429)
            self.assertEqual(headers["Retry-After"], "30")
            self.assertIn("Too many requests", json.loads(body)["error"])

            app.AUTHENTICATOR.validate.return_value = SupabaseUser(
                "20000000-0000-0000-0000-000000000002",
                "second@example.test",
            )
            status, _, _ = self.request("GET", "/api/packages")
            self.assertEqual(status, 200)

    def test_invalid_tokens_are_rate_limited_before_repeated_auth_checks(self):
        app.AUTHENTICATOR.validate.side_effect = SupabaseAuthError("expired")
        with patch.multiple(
            app,
            PREAUTH_REQUEST_LIMIT=1,
            PREAUTH_REQUEST_WINDOW=30.0,
        ):
            status, _, _ = self.request(
                "GET",
                "/api/packages",
                headers={"Authorization": "Bearer invalid-token"},
            )
            self.assertEqual(status, 401)

            status, headers, body = self.request(
                "GET",
                "/api/packages",
                headers={"Authorization": "Bearer invalid-token"},
            )
            self.assertEqual(status, 429)
            self.assertEqual(headers["Retry-After"], "30")
            self.assertIn("authentication attempts", json.loads(body)["error"])
        app.AUTHENTICATOR.validate.assert_called_once_with("invalid-token")

    def test_static_shell_assets_spa_fallback_and_path_safety(self):
        with patch.dict(
            os.environ,
            {"SUPABASE_PUBLIC_URL": "https://auth.example.test/project"},
        ):
            status, headers, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"<html>current shell</html>")
        self.assertEqual(headers["Cache-Control"], "no-store, max-age=0, must-revalidate")
        self.assertEqual(headers["Pragma"], "no-cache")
        self.assertEqual(headers["X-Frame-Options"], "DENY")
        self.assertEqual(headers["Cross-Origin-Opener-Policy"], "same-origin")
        self.assertEqual(headers["Cross-Origin-Resource-Policy"], "same-origin")
        self.assertEqual(headers["Strict-Transport-Security"], "max-age=31536000")
        self.assertIn("default-src 'self'", headers["Content-Security-Policy"])
        self.assertIn(
            "connect-src 'self' https://auth.example.test",
            headers["Content-Security-Policy"],
        )
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])
        self.assertIn("camera=()", headers["Permissions-Policy"])

        status, headers, body = self.request("GET", "/assets/app.js")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"console.log('ok')")
        self.assertEqual(headers["Cache-Control"], "public, max-age=31536000, immutable")

        status, _, body = self.request("GET", "/fresh-route")
        self.assertEqual(status, 200)
        self.assertIn(b"current shell", body)

        status, _, _ = self.request("GET", "/%2e%2e/secret")
        self.assertEqual(status, 404)

        status, headers, body = self.request("HEAD", "/")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Length"], str(len(b"<html>current shell</html>")))
        self.assertEqual(body, b"")

    def test_user_package_list_create_rename_archive_and_restore(self):
        status, _, body = self.request("GET", "/api/packages")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["packages"][0]["id"], PACKAGE["id"])
        app.SERVICE.client.list_packages.assert_called_with(include_archived=False)

        status, _, body = self.request("GET", "/api/packages?includeArchived=true")
        self.assertEqual(status, 200)
        app.SERVICE.client.list_packages.assert_called_with(include_archived=True)

        status, _, body = self.request(
            "POST",
            "/api/packages",
            payload={
                "trackingNumber": "99.34.123456.12345678",
                "label": " Coffee beans ",
                "carrier": "swiss-post",
            },
        )
        self.assertEqual(status, 201)
        self.assertEqual(json.loads(body)["tracking_number"], "993412345612345678")
        app.SERVICE.client.create_package.assert_called_once_with(
            "993412345612345678", "Coffee beans", "swiss-post", None, None
        )

        status, _, body = self.request(
            "POST",
            "/api/packages",
            payload={
                "trackingNumber": "44.00.123456.12345678",
                "label": "Quickpac parcel",
                # An older cached client may still submit this broad fallback.
                "carrier": "swiss-post",
            },
        )
        self.assertEqual(status, 201)
        self.assertEqual(json.loads(body)["tracking_number"], "440012345612345678")
        app.SERVICE.client.create_package.assert_called_with(
            "440012345612345678", "Quickpac parcel", "quickpac", None, None
        )

        tracking_url = (
            "https://trackandtrace.planzergroup.com/shared/sendungen/999.90.03316119"
            "?accessKey=abcdefghijklmnopqrstuvwxyzABCDEFGH"
        )
        status, _, body = self.request(
            "POST",
            "/api/packages",
            payload={
                "trackingNumber": "999.90.03316119",
                "label": "Plants",
                "carrier": "planzer",
                "trackingUrl": tracking_url,
            },
        )
        self.assertEqual(status, 201)
        self.assertEqual(json.loads(body)["tracking_url"], tracking_url)
        app.SERVICE.client.create_package.assert_called_with(
            "9999003316119", "Plants", "planzer", tracking_url, None
        )

        dachser_url = (
            "https://customeriberia.dachser.com/customerarea/utilidades/"
            "seguimiento-publico/detalle?cliente=generico"
            "&numeroUnico=9010000001234&fecha=20260513&clave=TESTKEY9"
        )
        status, _, body = self.request(
            "POST",
            "/api/packages",
            payload={
                "trackingNumber": "9010000001234",
                "label": "Furniture",
                "carrier": "dachser",
                "trackingUrl": dachser_url,
            },
        )
        self.assertEqual(status, 201)
        self.assertEqual(json.loads(body)["tracking_url"], dachser_url)
        app.SERVICE.client.create_package.assert_called_with(
            "9010000001234", "Furniture", "dachser", dachser_url, None
        )

        status, _, body = self.request(
            "POST",
            "/api/packages",
            payload={
                "trackingNumber": "06086514587082",
                "label": "DPD parcel",
                "carrier": "dpd",
                "dpdPostcode": "8004",
            },
        )
        self.assertEqual(status, 201)
        self.assertEqual(json.loads(body)["dpd_postcode"], "8004")
        app.SERVICE.client.create_package.assert_called_with(
            "06086514587082", "DPD parcel", "dpd", None, "8004"
        )

        renamed = {**PACKAGE, "label": "Espresso beans"}
        app.SERVICE.client.get_package.return_value = renamed
        status, _, body = self.request(
            "PATCH",
            f"/api/packages/{PACKAGE['id']}",
            payload={"label": " Espresso beans "},
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["label"], "Espresso beans")
        app.SERVICE.client.update_package.assert_called_once_with(
            PACKAGE["id"], {"label": "Espresso beans"}
        )

        status, _, body = self.request("DELETE", f"/api/packages/{PACKAGE['id']}")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["ok"])
        app.SERVICE.client.archive_package.assert_called_once_with(PACKAGE["id"])

        status, _, body = self.request("POST", f"/api/packages/{PACKAGE['id']}/restore")
        self.assertEqual(status, 200)
        app.SERVICE.client.restore_package.assert_called_once_with(PACKAGE["id"])

    def test_restore_returns_conflict_at_active_parcel_quota(self):
        app.SERVICE = FakeService(error=SupabaseError("quota", code="P0001"))

        status, _, body = self.request("POST", f"/api/packages/{PACKAGE['id']}/restore")

        self.assertEqual(status, 409)
        self.assertIn("parcel limit", json.loads(body)["error"])

    def test_only_archived_packages_can_be_permanently_deleted(self):
        status, _, body = self.request(
            "DELETE", f"/api/packages/{PACKAGE['id']}/permanent"
        )
        self.assertEqual(status, 409)
        self.assertIn("Archive", json.loads(body)["error"])
        app.SERVICE.client.delete_archived_package.assert_not_called()

        app.SERVICE.client.get_package.return_value = {
            **PACKAGE,
            "archived_at": "2026-08-06T10:00:00Z",
        }
        status, _, body = self.request(
            "DELETE", f"/api/packages/{PACKAGE['id']}/permanent"
        )
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["ok"])
        app.SERVICE.client.delete_archived_package.assert_called_once_with(PACKAGE["id"])

    def test_account_export_and_confirmed_permanent_deletion(self):
        status, headers, body = self.request("GET", "/api/account/export")
        self.assertEqual(status, 200)
        self.assertEqual(
            headers["Content-Disposition"],
            'attachment; filename="swiss-delivery-tracker-export.json"',
        )
        export = json.loads(body)
        self.assertEqual(
            export["account"],
            {
                "id": "10000000-0000-0000-0000-000000000001",
                "email": "owner@example.test",
            },
        )
        self.assertEqual(export["packages"], [PACKAGE])
        app.SERVICE.client.list_packages.assert_called_with(include_archived=True)

        status, _, body = self.request(
            "DELETE",
            "/api/account",
            payload={"confirmation": "different@example.test"},
        )
        self.assertEqual(status, 400)
        self.assertIn("account email", json.loads(body)["error"])
        app.SERVICE.client.delete_auth_user.assert_not_called()

        status, _, body = self.request(
            "DELETE",
            "/api/account",
            payload={"confirmation": " Owner@Example.Test "},
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"ok": True})
        app.SERVICE.client.delete_auth_user.assert_called_once_with(
            "10000000-0000-0000-0000-000000000001"
        )

    def test_account_deletion_requires_a_recent_sign_in(self):
        app.AUTHENTICATOR.validate.return_value = SupabaseUser(
            "10000000-0000-0000-0000-000000000001",
            "owner@example.test",
            datetime(2020, 1, 1, tzinfo=timezone.utc),
        )

        status, _, body = self.request(
            "DELETE",
            "/api/account",
            payload={"confirmation": "owner@example.test"},
        )

        self.assertEqual(status, 401)
        self.assertIn("Sign in again", json.loads(body)["error"])
        app.SERVICE.client.delete_auth_user.assert_not_called()

    def test_account_deletion_revalidates_the_requesting_session_without_cache(self):
        current_user = app.AUTHENTICATOR.validate.return_value

        status, _, body = self.request(
            "DELETE",
            "/api/account",
            payload={"confirmation": "owner@example.test"},
        )

        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"ok": True})
        self.assertEqual(app.AUTHENTICATOR.validate.call_count, 2)
        app.AUTHENTICATOR.validate.assert_any_call("valid-user-token")
        app.AUTHENTICATOR.validate.assert_any_call("valid-user-token", use_cache=False)
        app.SERVICE.client.delete_auth_user.assert_called_once_with(current_user.id)

    def test_account_deletion_rejects_a_recent_sign_in_from_another_session(self):
        app.AUTHENTICATOR.validate.side_effect = [
            SupabaseUser(
                "10000000-0000-0000-0000-000000000001",
                "owner@example.test",
                datetime.now(timezone.utc),
                "30000000-0000-0000-0000-000000000003",
            ),
            SupabaseUser(
                "10000000-0000-0000-0000-000000000001",
                "owner@example.test",
                None,
                "40000000-0000-0000-0000-000000000004",
            ),
        ]

        status, _, body = self.request(
            "DELETE",
            "/api/account",
            payload={"confirmation": "owner@example.test"},
        )

        self.assertEqual(status, 401)
        self.assertIn("Sign in again", json.loads(body)["error"])
        app.SERVICE.client.delete_auth_user.assert_not_called()

    def test_success_responses_match_the_openapi_schemas(self):
        status, _, body = self.request("GET", "/health")
        self.assertEqual(status, 200)
        assert_contract("HealthResponse", json.loads(body))

        status, _, body = self.request("GET", "/api/packages?includeArchived=true")
        self.assertEqual(status, 200)
        assert_contract("PackageListResponse", json.loads(body))

        status, _, body = self.request(
            "POST",
            "/api/packages",
            payload={"trackingNumber": "1234567890", "carrier": "dhl", "label": "Shoes"},
        )
        self.assertEqual(status, 201)
        assert_contract("PackageRow", json.loads(body))

        status, _, body = self.request("POST", "/api/sync")
        self.assertEqual(status, 202)
        assert_contract("QueueResponse", json.loads(body))

        status, _, body = self.request("GET", "/api/push/config")
        self.assertEqual(status, 200)
        assert_contract("PushConfigResponse", json.loads(body))

        status, _, body = self.request("DELETE", f"/api/packages/{PACKAGE['id']}")
        self.assertEqual(status, 200)
        assert_contract("OkResponse", json.loads(body))

    def test_push_configuration_subscription_and_unsubscribe(self):
        status, _, body = self.request("GET", "/api/push/config")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"available": False, "publicKey": None})

        notifier = Mock(public_key="vapid-public")
        app.SERVICE.notifier = notifier
        status, _, body = self.request("GET", "/api/push/config")
        self.assertEqual(json.loads(body), {"available": True, "publicKey": "vapid-public"})

        payload = {
            "endpoint": PUSH_ENDPOINT,
            "keys": {"p256dh": PUSH_PUBLIC_KEY, "auth": PUSH_AUTH_KEY},
        }
        status, _, body = self.request(
            "POST", "/api/push/subscriptions", payload=payload, headers={"User-Agent": "iPhone"}
        )
        self.assertEqual(status, 201)
        self.assertTrue(json.loads(body)["testSent"])
        app.SERVICE.client.upsert_push_subscription.assert_called_once_with(
            "10000000-0000-0000-0000-000000000001",
            payload["endpoint"],
            PUSH_PUBLIC_KEY,
            PUSH_AUTH_KEY,
            "iPhone",
        )
        notifier.send_test.assert_called_once()

        status, _, body = self.request(
            "DELETE", "/api/push/subscriptions", payload={"endpoint": payload["endpoint"]}
        )
        self.assertEqual(status, 200)
        app.SERVICE.client.delete_push_subscription.assert_called_once_with(
            "10000000-0000-0000-0000-000000000001",
            payload["endpoint"],
        )

    def test_notification_preferences_and_parcel_muting(self):
        status, _, body = self.request("GET", "/api/push/preferences")
        self.assertEqual(status, 200)
        self.assertEqual(
            json.loads(body),
            {
                "enabledStages": ["out_for_delivery", "delivered"],
                "quietHoursStart": "22:00",
                "quietHoursEnd": "08:00",
                "timezone": "Europe/Zurich",
            },
        )

        payload = {
            "enabledStages": ["customs", "out_for_delivery", "delivered"],
            "quietHoursStart": "23:00",
            "quietHoursEnd": "07:00",
            "timezone": "Europe/Zurich",
        }
        status, _, body = self.request("PATCH", "/api/push/preferences", payload=payload)
        self.assertEqual(status, 200)
        assert_contract("NotificationPreferences", json.loads(body))
        app.SERVICE.client.set_notification_preferences.assert_called_once_with(
            payload["enabledStages"],
            "23:00",
            "07:00",
            "Europe/Zurich",
        )

        muted = {**PACKAGE, "notifications_muted": True}
        app.SERVICE.client.get_package.return_value = muted
        status, _, body = self.request(
            "PATCH",
            f"/api/packages/{PACKAGE['id']}/notifications",
            payload={"muted": True},
        )
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["notifications_muted"])
        app.SERVICE.client.update_package.assert_called_once_with(
            PACKAGE["id"], {"notifications_muted": True}
        )

        invalid_preferences = [
            {**payload, "enabledStages": []},
            {**payload, "enabledStages": ["teleported"]},
            {**payload, "quietHoursEnd": None},
            {**payload, "quietHoursStart": "25:00"},
            {**payload, "timezone": "Not/A_Real_Zone"},
        ]
        for invalid in invalid_preferences:
            status, _, _ = self.request(
                "PATCH", "/api/push/preferences", payload=invalid
            )
            self.assertEqual(status, 400)

        status, _, _ = self.request(
            "PATCH",
            f"/api/packages/{PACKAGE['id']}/notifications",
            payload={"muted": "yes"},
        )
        self.assertEqual(status, 400)

    def test_native_push_device_registration_and_removal(self):
        native = Mock()
        app.SERVICE.notifier = app.CompositePushNotificationService(None, native)
        payload = {
            "token": "AB" * 32,
            "environment": "development",
            "locale": "fr",
            "deviceName": "Paul’s iPhone",
            "sendTest": True,
        }

        status, _, body = self.request("POST", "/api/push/devices", payload=payload)

        self.assertEqual(status, 201)
        self.assertEqual(json.loads(body), {"ok": True, "testSent": True})
        app.SERVICE.client.upsert_native_push_device.assert_called_once_with(
            "10000000-0000-0000-0000-000000000001",
            "ab" * 32,
            "development",
            "fr",
            "Paul’s iPhone",
        )
        native.send_test.assert_called_once_with(
            app.SERVICE.client.upsert_native_push_device.return_value
        )

        status, _, body = self.request(
            "POST", "/api/push/devices", payload={**payload, "sendTest": False}
        )
        self.assertEqual(status, 201)
        self.assertEqual(json.loads(body), {"ok": True, "testSent": False})
        native.send_test.assert_called_once()

        status, _, body = self.request(
            "DELETE", "/api/push/devices", payload={"token": "AB" * 32}
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"ok": True})
        app.SERVICE.client.delete_native_push_device.assert_called_once_with(
            "10000000-0000-0000-0000-000000000001", "ab" * 32
        )

    def test_native_push_device_validation_and_configuration(self):
        native = Mock()
        app.SERVICE.notifier = app.CompositePushNotificationService(None, native)
        valid = {
            "token": "ab" * 32,
            "environment": "development",
            "locale": "en",
            "deviceName": "iPhone",
            "sendTest": True,
        }
        for invalid in (
            {},
            {**valid, "token": "short"},
            {**valid, "environment": "staging"},
            {**valid, "locale": "es"},
            {**valid, "deviceName": "x" * 101},
            {**valid, "sendTest": "yes"},
        ):
            status, _, _ = self.request("POST", "/api/push/devices", payload=invalid)
            self.assertEqual(status, 400)

        app.SERVICE.notifier = None
        status, _, body = self.request("POST", "/api/push/devices", payload=valid)
        self.assertEqual(status, 503)
        self.assertIn("not configured", json.loads(body)["error"])

    def test_push_routes_validate_credentials_and_handle_test_failure(self):
        app.SERVICE.notifier = Mock(public_key="public")
        invalid = [
            {},
            {"endpoint": "http://insecure.test", "keys": {}},
            {"endpoint": "https://push.example.test", "keys": {"p256dh": "short", "auth": "short"}},
            {
                "endpoint": "https://127.0.0.1/push",
                "keys": {"p256dh": PUSH_PUBLIC_KEY, "auth": PUSH_AUTH_KEY},
            },
            {
                "endpoint": "https://attacker.example/push",
                "keys": {"p256dh": PUSH_PUBLIC_KEY, "auth": PUSH_AUTH_KEY},
            },
        ]
        for payload in invalid:
            status, _, _ = self.request("POST", "/api/push/subscriptions", payload=payload)
            self.assertEqual(status, 400)

        app.SERVICE.notifier.send_test.side_effect = RuntimeError("Apple unavailable")
        status, _, body = self.request(
            "POST",
            "/api/push/subscriptions",
            payload={
                "endpoint": PUSH_ENDPOINT,
                "keys": {"p256dh": PUSH_PUBLIC_KEY, "auth": PUSH_AUTH_KEY},
            },
        )
        self.assertEqual(status, 201)
        self.assertFalse(json.loads(body)["testSent"])

        app.SERVICE.notifier = None
        status, _, body = self.request("POST", "/api/push/subscriptions", payload={})
        self.assertEqual(status, 503)
        self.assertIn("not configured", json.loads(body)["error"])

    def test_api_requires_configuration_and_valid_routes(self):
        app.SERVICE = None
        for method, path in (
            ("GET", "/api/packages"),
            ("POST", "/api/sync"),
            ("PATCH", f"/api/packages/{PACKAGE['id']}"),
            ("DELETE", f"/api/packages/{PACKAGE['id']}"),
        ):
            status, _, body = self.request(method, path)
            self.assertEqual(status, 503)
            self.assertIn("not configured", json.loads(body)["error"])

        app.SERVICE = FakeService()
        status, _, body = self.request("POST", "/not-an-api")
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body), {"error": "Not found"})
        status, _, body = self.request("DELETE", "/not-an-api")
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body), {"error": "Not found"})
        status, _, body = self.request("PATCH", "/not-an-api", payload={"label": "New"})
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body), {"error": "Not found"})

    def test_rename_validates_the_package_id_and_title(self):
        for path, payload, message in (
            ("/api/packages/not-a-uuid", {"label": "New"}, "Invalid package id"),
            (f"/api/packages/{PACKAGE['id']}", {}, "must be text"),
            (f"/api/packages/{PACKAGE['id']}", {"label": "x" * 81}, "at most 80"),
        ):
            status, _, body = self.request("PATCH", path, payload=payload)
            self.assertEqual(status, 400)
            self.assertIn(message, json.loads(body)["error"])

        app.SERVICE.client.get_package.return_value = None
        status, _, body = self.request(
            "PATCH", f"/api/packages/{PACKAGE['id']}", payload={"label": "Missing"}
        )
        self.assertEqual(status, 404)
        self.assertIn("not found", json.loads(body)["error"].lower())

    def test_create_validates_json_fields_and_duplicate_tracking(self):
        invalid_requests = [
            ({}, "between 4 and 40"),
            ({"trackingNumber": ["bad"], "label": "", "carrier": "unknown"}, "must be text"),
            (
                {"trackingNumber": "hello there", "label": "", "carrier": "unknown"},
                "include a digit",
            ),
            ({"trackingNumber": "12??", "label": "", "carrier": "unknown"}, "letters and numbers"),
            ({"trackingNumber": "1234", "label": "x" * 81, "carrier": "unknown"}, "at most 80"),
            ({"trackingNumber": "1234", "label": "", "carrier": "invented"}, "supported carrier"),
            (
                {"trackingNumber": "06086514587082", "label": "", "carrier": "dpd"},
                "four-digit delivery postcode",
            ),
            (
                {
                    "trackingNumber": "06086514587082",
                    "label": "",
                    "carrier": "dpd",
                    "dpdPostcode": "80A4",
                },
                "four-digit delivery postcode",
            ),
            (
                {
                    "trackingNumber": "1234567890",
                    "label": "",
                    "carrier": "dhl",
                    "dpdPostcode": "8004",
                },
                "only used for DPD",
            ),
            (
                {"trackingNumber": "999.90.03316119", "label": "", "carrier": "planzer"},
                "requires its complete tracking URL",
            ),
            (
                {
                    "trackingNumber": "999.90.03316119",
                    "label": "",
                    "carrier": "planzer",
                    "trackingUrl": "https://example.test/shared/sendungen/999.90.03316119"
                    "?accessKey=abcdefghijklmnopqrstuvwxyzABCDEFGH",
                },
                "must use https://trackandtrace.planzergroup.com",
            ),
            (
                {"trackingNumber": "9010000001234", "label": "", "carrier": "dachser"},
                "requires its complete tracking URL",
            ),
            (
                {
                    "trackingNumber": "9010000001234",
                    "label": "",
                    "carrier": "dachser",
                    "trackingUrl": (
                        "https://example.test/customerarea/utilidades/seguimiento-publico/"
                        "detalle?numeroUnico=9010000001234&fecha=20260513&clave=TESTKEY9"
                    ),
                },
                "must use https://customeriberia.dachser.com",
            ),
        ]
        for payload, message in invalid_requests:
            status, _, body = self.request("POST", "/api/packages", payload=payload)
            self.assertEqual(status, 400)
            self.assertIn(message, json.loads(body)["error"])

        for raw_body in (b"not-json", b"[]", b""):
            status, _, body = self.request("POST", "/api/packages", raw_body=raw_body)
            self.assertEqual(status, 400)
            self.assertIn(
                "valid JSON object" if raw_body else "request size", json.loads(body)["error"]
            )

        app.SERVICE = FakeService(error=SupabaseError("duplicate", status=409))
        status, _, body = self.request(
            "POST",
            "/api/packages",
            payload={"trackingNumber": "1234", "label": "", "carrier": "unknown"},
        )
        self.assertEqual(status, 409)
        self.assertIn("already", json.loads(body)["error"])

        app.SERVICE = FakeService(error=SupabaseError("quota", code="P0001"))
        status, _, body = self.request(
            "POST",
            "/api/packages",
            payload={"trackingNumber": "1234", "label": "", "carrier": "unknown"},
        )
        self.assertEqual(status, 409)
        self.assertIn("parcel limit", json.loads(body)["error"])

    def test_sync_requests_are_queued_for_the_current_user_and_package(self):
        status, _, body = self.request("POST", "/api/sync")
        self.assertEqual(status, 202)
        self.assertEqual(json.loads(body), {"queued": True, "pending": 1})
        app.SERVICE.client.list_active_packages.assert_called_once_with()
        app.SYNC_JOBS.enqueue_package.assert_called_with(PACKAGE)

        status, _, body = self.request("POST", f"/api/packages/{PACKAGE['id']}/sync")
        self.assertEqual(status, 202)
        self.assertEqual(json.loads(body), {"queued": True, "pending": 1})
        self.assertEqual(app.SYNC_JOBS.enqueue_package.call_count, 2)

        app.SERVICE.client.get_package.return_value = None
        status, _, body = self.request("POST", f"/api/packages/{PACKAGE['id']}/sync")
        self.assertEqual(status, 404)

        status, _, body = self.request("POST", "/api/packages/not-a-uuid/sync")
        self.assertEqual(status, 400)

        app.SYNC_JOBS.enqueue_package.side_effect = app.SyncQueueFull("queue busy")
        status, _, body = self.request("POST", "/api/sync")
        self.assertEqual(status, 429)
        self.assertEqual(json.loads(body), {"error": "queue busy"})

    def test_bulk_sync_queues_at_most_five_packages_for_one_user(self):
        packages = [{**PACKAGE, "id": f"package-{number}"} for number in range(7)]
        app.SERVICE.client.list_active_packages.return_value = packages

        status, _, body = self.request("POST", "/api/sync")

        self.assertEqual(status, 202)
        self.assertTrue(json.loads(body)["queued"])
        self.assertEqual(app.SYNC_JOBS.enqueue_package.call_count, 5)
        self.assertEqual(
            [call.args[0]["id"] for call in app.SYNC_JOBS.enqueue_package.call_args_list],
            [f"package-{number}" for number in range(5)],
        )

    def test_database_errors_and_invalid_delete_ids_are_reported(self):
        app.SERVICE = FakeService(error=SupabaseError("database offline"))
        status, _, body = self.request("GET", "/api/packages")
        self.assertEqual(status, 502)
        self.assertNotIn("database offline", json.loads(body)["error"])
        self.assertIn("temporarily unavailable", json.loads(body)["error"])

        status, _, body = self.request(
            "POST",
            "/api/packages",
            payload={"trackingNumber": "1234", "label": "", "carrier": "unknown"},
        )
        self.assertEqual(status, 502)

        app.SERVICE = FakeService()
        status, _, body = self.request("DELETE", "/api/packages/not-a-uuid")
        self.assertEqual(status, 400)
        self.assertIn("Invalid", json.loads(body)["error"])

        app.SERVICE = FakeService(error=SupabaseError("archive failed"))
        status, _, body = self.request("DELETE", f"/api/packages/{PACKAGE['id']}")
        self.assertEqual(status, 502)
        self.assertNotIn("archive failed", json.loads(body)["error"])

        app.SERVICE = FakeService(error=SupabaseError("rename failed"))
        status, _, body = self.request(
            "PATCH", f"/api/packages/{PACKAGE['id']}", payload={"label": "New title"}
        )
        self.assertEqual(status, 502)
        self.assertNotIn("rename failed", json.loads(body)["error"])


class AppLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.original_service = app.SERVICE
        self.original_sync_jobs = app.SYNC_JOBS
        self.original_state = dict(app.STATE)

    def tearDown(self):
        app.SERVICE = self.original_service
        app.SYNC_JOBS = self.original_sync_jobs
        app.STATE.clear()
        app.STATE.update(self.original_state)

    def test_build_service_requires_server_only_supabase_values(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(app.build_service())

        with (
            patch.dict(
                os.environ,
                {
                    "SUPABASE_URL": "http://supabase",
                    "SUPABASE_SERVICE_ROLE_KEY": "service",
                },
                clear=True,
            ),
            patch("server.app.SupabaseServiceClient") as client_class,
            patch("server.app.TrackingSyncService") as service_class,
        ):
            self.assertIs(app.build_service(), service_class.return_value)
            client_class.assert_called_once_with("http://supabase", "service")
            service_class.assert_called_once_with(client_class.return_value, notifier=None)

        with (
            patch.dict(
                os.environ,
                {
                    "SUPABASE_URL": "http://supabase",
                    "SUPABASE_SERVICE_ROLE_KEY": "service",
                    "VAPID_PUBLIC_KEY": "public",
                    "VAPID_PRIVATE_KEY": "private",
                    "VAPID_SUBJECT": "mailto:owner@example.test",
                },
                clear=True,
            ),
            patch("server.app.SupabaseServiceClient") as client_class,
            patch("server.app.PushNotificationService") as push_class,
            patch("server.app.TrackingSyncService") as service_class,
        ):
            app.build_service()
            push_class.assert_called_once_with(
                client_class.return_value,
                "public",
                "private",
                "mailto:owner@example.test",
            )
            service_class.assert_called_once_with(
                client_class.return_value, notifier=push_class.return_value
            )

        with patch.dict(
            os.environ,
            {
                "SUPABASE_URL": "http://supabase",
                "SUPABASE_SERVICE_ROLE_KEY": "service",
                "APNS_TEAM_ID": "TEAM",
            },
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "APNS_KEY_ID"):
                app.build_service()

        with (
            patch.dict(
                os.environ,
                {
                    "SUPABASE_URL": "http://supabase",
                    "SUPABASE_SERVICE_ROLE_KEY": "service",
                    "APNS_TEAM_ID": "TEAM",
                    "APNS_KEY_ID": "KEY",
                    "APNS_PRIVATE_KEY": "private-key",
                    "APNS_BUNDLE_ID": "com.example.DeliveryTracker",
                },
                clear=True,
            ),
            patch("server.app.SupabaseServiceClient") as client_class,
            patch("server.app.NativePushNotificationService") as native_class,
            patch("server.app.TrackingSyncService") as service_class,
        ):
            app.build_service()
            native_class.assert_called_once_with(
                client_class.return_value,
                "TEAM",
                "KEY",
                "private-key",
                "com.example.DeliveryTracker",
            )
            service_class.assert_called_once_with(
                client_class.return_value, notifier=native_class.return_value
            )

    def test_authenticator_requires_complete_public_configuration(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(app.build_authenticator())

        with patch.dict(os.environ, {"SUPABASE_URL": "http://supabase"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "publishable key"):
                app.build_authenticator()

        with (
            patch.dict(
                os.environ,
                {
                    "SUPABASE_URL": "http://supabase",
                    "SUPABASE_ANON_KEY": "legacy-anon-key",
                },
                clear=True,
            ),
            patch("server.app.SupabaseAuthenticator") as authenticator_class,
        ):
            self.assertIs(app.build_authenticator(), authenticator_class.return_value)
            authenticator_class.assert_called_once_with("http://supabase", "legacy-anon-key")

    def test_public_supabase_origin_rejects_unsafe_configuration(self):
        cases = {
            "": None,
            "javascript:alert(1)": None,
            "https://user:password@example.test": None,
            "https://auth.example.test/path": "https://auth.example.test",
            "http://supabase.internal:8000/rest": "http://supabase.internal:8000",
        }
        for raw_url, expected in cases.items():
            with self.subTest(raw_url=raw_url):
                with patch.dict(
                    os.environ,
                    {"SUPABASE_PUBLIC_URL": raw_url, "SUPABASE_URL": ""},
                ):
                    self.assertEqual(app.public_supabase_origin(), expected)

    def test_schedule_uses_ten_minutes_by_day_and_hourly_by_night(self):
        cases = [
            (datetime(2026, 7, 15, 7, 4, 30, tzinfo=timezone.utc), 330),  # 09:04 Zurich
            (datetime(2026, 7, 15, 19, 59, tzinfo=timezone.utc), 60),  # 21:59 Zurich
            (datetime(2026, 7, 15, 20, 1, tzinfo=timezone.utc), 3540),  # 22:01 Zurich
            (datetime(2026, 7, 15, 5, 30, tzinfo=timezone.utc), 1800),  # 07:30 Zurich
            (datetime(2026, 1, 15, 6, 30, tzinfo=timezone.utc), 1800),  # winter boundary
        ]
        for now, expected in cases:
            with self.subTest(now=now):
                self.assertEqual(app.seconds_until_next_sync(now), expected)
        with self.assertRaisesRegex(ValueError, "timezone"):
            app.seconds_until_next_sync(datetime(2026, 7, 15, 9))

    def test_new_packages_start_syncing_in_the_background(self):
        service = FakeService()
        jobs = Mock(service=service)
        app.SYNC_JOBS = jobs

        app.start_immediate_sync(service, PACKAGE)

        jobs.enqueue_package.assert_called_once_with(PACKAGE)

    def test_sync_queue_is_bounded_deduplicated_and_starts_once(self):
        service = FakeService()
        jobs = app.SyncJobQueue(service, max_pending=1)
        with patch.object(jobs, "start") as start:
            self.assertTrue(jobs.enqueue_all())
            self.assertFalse(jobs.enqueue_all())
            with self.assertRaises(app.SyncQueueFull):
                jobs.enqueue_package(PACKAGE)
        self.assertEqual(jobs.pending_count(), 1)
        start.assert_called_once_with()

    def test_scheduler_records_success_and_top_level_failures(self):
        app.STATE.clear()
        service = FakeService(summary=SyncSummary(checked=2, waiting=2))
        app.SERVICE = service
        with patch("server.app.time.sleep", side_effect=[None, StopIteration]):
            with self.assertRaises(StopIteration):
                app.scheduler()
        self.assertEqual(app.STATE["last_summary"]["waiting"], 2)
        self.assertIsNone(app.STATE["last_error"])
        service.client.archive_delivered_before.assert_called_once()

        app.STATE.clear()
        app.SERVICE = FakeService(error=RuntimeError("database unavailable"))
        with patch("server.app.time.sleep", side_effect=[None, StopIteration]):
            with self.assertRaises(StopIteration):
                app.scheduler()
        self.assertEqual(app.STATE["last_error"], "database unavailable")

    def test_main_starts_scheduler_and_serves_forever(self):
        fake_server = Mock()
        app.SERVICE = FakeService()
        with (
            patch(
                "server.app.BoundedThreadingHTTPServer", return_value=fake_server
            ) as server_class,
            patch("server.app.threading.Thread") as thread_class,
            patch("builtins.print") as output,
        ):
            app.main()
        server_class.assert_called_once_with(("0.0.0.0", app.PORT), app.Handler)
        thread_class.return_value.start.assert_called_once()
        fake_server.serve_forever.assert_called_once()
        output.assert_called_once()


if __name__ == "__main__":
    unittest.main()
