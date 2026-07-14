import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

import server.app as app
from server.supabase_client import SupabaseError
from server.tracking_sync import SyncSummary


class QuietHandler(app.Handler):
    def log_message(self, format, *args):
        return


class FakeService:
    def __init__(self, user=None, summary=None, error=None):
        self.user = user or {"id": "user-1"}
        self.summary = summary or SyncSummary(checked=1, updated=1)
        self.error = error
        self.client = Mock()
        self.client.auth_user.side_effect = self._auth_user
        self.sync = Mock(side_effect=self._sync)

    def _auth_user(self, token):
        if self.error and isinstance(self.error, SupabaseError):
            raise self.error
        return self.user

    def _sync(self, user_id=None):
        if self.error and not isinstance(self.error, SupabaseError):
            raise self.error
        return self.summary


class AppHttpTests(unittest.TestCase):
    def setUp(self):
        self.original_dist = app.DIST
        self.original_service = app.SERVICE
        self.original_state = dict(app.STATE)
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        (root / "assets").mkdir()
        (root / "index.html").write_text("<html>current shell</html>", encoding="utf-8")
        (root / "assets" / "app.js").write_text("console.log('ok')", encoding="utf-8")
        app.DIST = root.resolve()
        app.SERVICE = FakeService()
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
        app.STATE.clear()
        app.STATE.update(self.original_state)

    def request(self, method, path, headers=None):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        connection.request(method, path, headers=headers or {})
        response = connection.getresponse()
        body = response.read()
        result = (response.status, dict(response.getheaders()), body)
        connection.close()
        return result

    def test_health_reports_scheduler_state_and_missing_configuration(self):
        status, headers, body = self.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(json.loads(body)["last_summary"], {"checked": 1})

        app.SERVICE = None
        status, _, body = self.request("GET", "/health")
        self.assertEqual(status, 503)
        self.assertFalse(json.loads(body)["ok"])

        status, _, body = self.request("HEAD", "/health")
        self.assertEqual(status, 503)
        self.assertEqual(body, b"")

    def test_static_shell_assets_spa_fallback_and_path_safety(self):
        status, headers, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"<html>current shell</html>")
        self.assertEqual(headers["Cache-Control"], "no-store, max-age=0, must-revalidate")
        self.assertEqual(headers["Pragma"], "no-cache")
        self.assertEqual(headers["X-Frame-Options"], "DENY")

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

    def test_sync_endpoint_requires_service_and_authentication(self):
        status, _, body = self.request("POST", "/not-sync")
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body), {"error": "Not found"})

        app.SERVICE = None
        status, _, body = self.request("POST", "/api/sync")
        self.assertEqual(status, 503)
        self.assertIn("not configured", json.loads(body)["error"])

        app.SERVICE = FakeService()
        status, _, body = self.request("POST", "/api/sync")
        self.assertEqual(status, 401)
        self.assertIn("Sign in", json.loads(body)["error"])

    def test_sync_endpoint_scopes_work_to_the_authenticated_user(self):
        service = FakeService(user={"id": "user-42"})
        app.SERVICE = service
        status, _, body = self.request(
            "POST", "/api/sync", {"Authorization": "Bearer valid-token"}
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["updated"], 1)
        service.client.auth_user.assert_called_once_with("valid-token")
        service.sync.assert_called_once_with("user-42")

    def test_sync_endpoint_maps_auth_and_worker_failures(self):
        app.SERVICE = FakeService(error=SupabaseError("expired"))
        status, _, body = self.request(
            "POST", "/api/sync", {"Authorization": "Bearer expired-token"}
        )
        self.assertEqual(status, 401)
        self.assertEqual(json.loads(body), {"error": "expired"})

        app.SERVICE = FakeService(error=RuntimeError("carrier exploded"))
        status, _, body = self.request(
            "POST", "/api/sync", {"Authorization": "Bearer valid-token"}
        )
        self.assertEqual(status, 502)
        self.assertEqual(json.loads(body), {"error": "carrier exploded"})


class AppLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.original_service = app.SERVICE
        self.original_state = dict(app.STATE)

    def tearDown(self):
        app.SERVICE = self.original_service
        app.STATE.clear()
        app.STATE.update(self.original_state)

    def test_build_service_requires_all_three_supabase_values(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(app.build_service())

        with (
            patch.dict(
                os.environ,
                {
                    "SUPABASE_URL": "http://supabase",
                    "SUPABASE_ANON_KEY": "anon",
                    "SUPABASE_SERVICE_ROLE_KEY": "service",
                },
                clear=True,
            ),
            patch("server.app.SupabaseServiceClient") as client_class,
            patch("server.app.TrackingSyncService") as service_class,
        ):
            self.assertIs(app.build_service(), service_class.return_value)
            client_class.assert_called_once_with("http://supabase", "anon", "service")
            service_class.assert_called_once_with(client_class.return_value)

    def test_scheduler_records_success_and_top_level_failures(self):
        app.STATE.clear()
        service = FakeService(summary=SyncSummary(checked=2, waiting=2))
        app.SERVICE = service
        with patch("server.app.time.sleep", side_effect=[None, StopIteration]):
            with self.assertRaises(StopIteration):
                app.scheduler()
        self.assertEqual(app.STATE["last_summary"]["waiting"], 2)
        self.assertIsNone(app.STATE["last_error"])

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
            patch("server.app.ThreadingHTTPServer", return_value=fake_server) as server_class,
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
