"""Serve the PWA and run scheduled carrier synchronization in one container."""

from __future__ import annotations

import json
import mimetypes
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from .supabase_client import SupabaseError, SupabaseServiceClient
from .tracking_sync import TrackingSyncService


DIST = Path(os.environ.get("STATIC_DIR", "/app/dist")).resolve()
PORT = int(os.environ.get("PORT", "3000"))
SYNC_INTERVAL = max(60, int(os.environ.get("SYNC_INTERVAL_SECONDS", "900")))


def build_service() -> TrackingSyncService | None:
    url = os.environ.get("SUPABASE_URL", "")
    anon_key = os.environ.get("SUPABASE_ANON_KEY", "")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not all((url, anon_key, service_key)):
        return None
    return TrackingSyncService(SupabaseServiceClient(url, anon_key, service_key))


SERVICE = build_service()
STATE: dict[str, object] = {"last_scheduled_sync": None, "last_summary": None, "last_error": None}


def scheduler() -> None:
    time.sleep(8)
    while SERVICE:
        try:
            summary = SERVICE.sync()
            STATE.update(
                last_scheduled_sync=time.time(), last_summary=summary.to_dict(), last_error=None
            )
        except Exception as exc:
            STATE.update(last_scheduled_sync=time.time(), last_error=str(exc)[:500])
        time.sleep(SYNC_INTERVAL)


class Handler(BaseHTTPRequestHandler):
    server_version = "DeliveryTracker/2"

    def _json(self, status: int, payload: object) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._security_headers()
        self.end_headers()
        self.wfile.write(body)

    def _security_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("X-Frame-Options", "DENY")

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/health":
            healthy = SERVICE is not None
            self._json(200 if healthy else 503, {"ok": healthy, **STATE})
            return
        self._serve_static(path)

    def do_HEAD(self) -> None:  # noqa: N802
        if urlparse(self.path).path == "/health":
            self.send_response(200 if SERVICE else 503)
            self.end_headers()
            return
        self._serve_static(urlparse(self.path).path, head_only=True)

    def do_POST(self) -> None:  # noqa: N802
        if urlparse(self.path).path != "/api/sync":
            self._json(404, {"error": "Not found"})
            return
        if not SERVICE:
            self._json(503, {"error": "The tracking worker is not configured"})
            return
        authorization = self.headers.get("Authorization", "")
        if not authorization.startswith("Bearer "):
            self._json(401, {"error": "Sign in before syncing deliveries"})
            return
        try:
            user = SERVICE.client.auth_user(authorization.removeprefix("Bearer ").strip())
            summary = SERVICE.sync(str(user["id"]))
            self._json(200, summary.to_dict())
        except SupabaseError as exc:
            self._json(401, {"error": str(exc)})
        except Exception as exc:
            self._json(502, {"error": str(exc)[:500]})

    def _serve_static(self, path: str, head_only: bool = False) -> None:
        relative = unquote(path).lstrip("/") or "index.html"
        candidate = (DIST / relative).resolve()
        if DIST not in candidate.parents and candidate != DIST:
            self.send_error(404)
            return
        if not candidate.is_file():
            candidate = DIST / "index.html"
        if not candidate.is_file():
            self.send_error(503, "Frontend build not found")
            return
        body = candidate.read_bytes()
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        self.send_response(200)
        self._security_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if candidate.parent.name == "assets":
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            # HTML, the service worker and its registration script must always be
            # re-fetched. A stale app shell can point at an obsolete JavaScript
            # bundle and make durable server data appear to have disappeared.
            self.send_header("Cache-Control", "no-store, max-age=0, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        self.end_headers()
        if not head_only:
            self.wfile.write(body)


def main() -> None:
    if SERVICE:
        threading.Thread(target=scheduler, name="delivery-sync", daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Delivery Tracker listening on :{PORT}; sync={'enabled' if SERVICE else 'disabled'}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
