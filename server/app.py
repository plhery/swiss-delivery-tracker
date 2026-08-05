"""Serve the PWA and run scheduled carrier synchronization in one container."""

from __future__ import annotations

import json
import mimetypes
import os
import queue
import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse
from uuid import UUID
from zoneinfo import ZoneInfo

from .planzer_shared import (
    is_planzer_shared_tracking_number,
    validate_planzer_shared_url,
)
from .push import PushNotificationService
from .supabase_client import SupabaseError, SupabaseServiceClient
from .tracking_sync import TrackingSyncService


DIST = Path(os.environ.get("STATIC_DIR", "/app/dist")).resolve()
PORT = int(os.environ.get("PORT", "3000"))
SYNC_TIMEZONE = ZoneInfo("Europe/Zurich")
MAX_JSON_BODY = 16_384
VALID_CARRIERS = {
    "swiss-post", "quickpac", "planzer", "aliexpress", "sunyou", "hermes",
    "spring-gds", "postlogistics", "dachser", "dhl", "ups", "fedex", "dpd",
    "shipup", "intl-post", "unknown",
}


def build_service() -> TrackingSyncService | None:
    url = os.environ.get("SUPABASE_URL", "")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not all((url, service_key)):
        return None
    client = SupabaseServiceClient(url, service_key)
    public_key = os.environ.get("VAPID_PUBLIC_KEY", "").strip()
    private_key = os.environ.get("VAPID_PRIVATE_KEY", "").strip()
    notifier = None
    if public_key and private_key:
        notifier = PushNotificationService(
            client,
            public_key,
            private_key,
            os.environ.get("VAPID_SUBJECT", "https://delivery.plhery.com"),
        )
    return TrackingSyncService(client, notifier=notifier)


STATE: dict[str, object] = {
    "last_scheduled_sync": None,
    "next_scheduled_sync": None,
    "last_summary": None,
    "last_error": None,
}


class SyncQueueFull(RuntimeError):
    """Raised when the bounded background queue cannot accept more work."""


@dataclass(frozen=True)
class SyncJob:
    key: str
    package: dict[str, object] | None = None


class SyncJobQueue:
    """Run deduplicated sync requests away from HTTP request threads."""

    def __init__(self, service: TrackingSyncService, max_pending: int = 64) -> None:
        self.service = service
        self._queue: queue.Queue[SyncJob] = queue.Queue(maxsize=max_pending)
        self._queued: set[str] = set()
        self._lock = threading.Lock()
        self._started = False

    def start(self) -> None:
        with self._lock:
            if self._started:
                return
            self._started = True
            threading.Thread(
                target=self._run,
                name="delivery-sync-jobs",
                daemon=True,
            ).start()

    def enqueue_all(self) -> bool:
        return self._enqueue(SyncJob("all"))

    def enqueue_package(self, package: dict[str, object]) -> bool:
        return self._enqueue(SyncJob(f"package:{package['id']}", package))

    def pending_count(self) -> int:
        with self._lock:
            return len(self._queued)

    def _enqueue(self, job: SyncJob) -> bool:
        with self._lock:
            if job.key in self._queued:
                return False
            try:
                self._queue.put_nowait(job)
            except queue.Full as exc:
                raise SyncQueueFull("Too many tracking checks are already queued") from exc
            self._queued.add(job.key)
        self.start()
        return True

    def _run(self) -> None:
        while True:
            job = self._queue.get()
            try:
                summary = (
                    self.service.sync_package(job.package)
                    if job.package is not None
                    else self.service.sync()
                )
                STATE.update(last_summary=summary.to_dict(), last_error=None)
            except Exception as exc:
                STATE["last_error"] = str(exc)[:500]
            finally:
                with self._lock:
                    self._queued.discard(job.key)
                self._queue.task_done()


SERVICE = build_service()
SYNC_JOBS: SyncJobQueue | None = SyncJobQueue(SERVICE) if SERVICE else None


def sync_jobs(service: TrackingSyncService) -> SyncJobQueue:
    global SYNC_JOBS
    if SYNC_JOBS is None or (
        isinstance(SYNC_JOBS, SyncJobQueue) and SYNC_JOBS.service is not service
    ):
        SYNC_JOBS = SyncJobQueue(service)
    return SYNC_JOBS


def seconds_until_next_sync(now: datetime | None = None) -> float:
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        raise ValueError("Sync clock must include a timezone")
    local = current.astimezone(SYNC_TIMEZONE)
    if 8 <= local.hour < 22:
        minutes = 10 - (local.minute % 10)
        candidate = local.replace(second=0, microsecond=0) + timedelta(minutes=minutes)
    else:
        candidate = local.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    return max(1.0, (candidate.astimezone(timezone.utc) - current.astimezone(timezone.utc)).total_seconds())


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
        delay = seconds_until_next_sync()
        STATE["next_scheduled_sync"] = time.time() + delay
        time.sleep(delay)


def start_immediate_sync(
    service: TrackingSyncService, package: dict[str, object]
) -> None:
    """Queue the first carrier lookup without delaying the create response."""
    sync_jobs(service).enqueue_package(package)


class Handler(BaseHTTPRequestHandler):
    server_version = "DeliveryTracker/3"

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
        if path == "/reauth":
            # Cloudflare returns here after login. Serving a fresh document at
            # this distinct URL prevents Safari from restoring the page whose
            # React state still says that authentication is required.
            self._serve_static("/")
            return
        if path == "/health":
            healthy = SERVICE is not None
            pending_jobs = sync_jobs(SERVICE).pending_count() if SERVICE else 0
            self._json(
                200 if healthy else 503,
                {"ok": healthy, "pending_sync_jobs": pending_jobs, **STATE},
            )
            return
        if path == "/api/packages":
            if not SERVICE:
                self._json(503, {"error": "The delivery database is not configured"})
                return
            try:
                self._json(200, {"packages": SERVICE.client.list_packages()})
            except SupabaseError as exc:
                self._json(502, {"error": str(exc)})
            return
        if path == "/api/push/config":
            notifier = SERVICE.notifier if SERVICE else None
            self._json(
                200,
                {
                    "available": notifier is not None,
                    "publicKey": notifier.public_key if notifier else None,
                },
            )
            return
        self._serve_static(path)

    def do_HEAD(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/reauth":
            self._serve_static("/", head_only=True)
            return
        if path == "/health":
            self.send_response(200 if SERVICE else 503)
            self.end_headers()
            return
        self._serve_static(path, head_only=True)

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if not SERVICE:
            self._json(503, {"error": "The delivery database is not configured"})
            return

        if path == "/api/sync":
            try:
                jobs = sync_jobs(SERVICE)
                queued = jobs.enqueue_all()
                self._json(
                    HTTPStatus.ACCEPTED,
                    {"queued": queued, "pending": jobs.pending_count()},
                )
            except SyncQueueFull as exc:
                self._json(HTTPStatus.TOO_MANY_REQUESTS, {"error": str(exc)})
            return

        package_sync = re.fullmatch(r"/api/packages/([^/]+)/sync", path)
        if package_sync:
            try:
                package_id = str(UUID(package_sync.group(1)))
                package = SERVICE.client.get_package(package_id)
                if not package:
                    self._json(404, {"error": "Package not found"})
                    return
                jobs = sync_jobs(SERVICE)
                queued = jobs.enqueue_package(package)
                self._json(
                    HTTPStatus.ACCEPTED,
                    {"queued": queued, "pending": jobs.pending_count()},
                )
            except ValueError:
                self._json(400, {"error": "Invalid package id"})
            except SyncQueueFull as exc:
                self._json(HTTPStatus.TOO_MANY_REQUESTS, {"error": str(exc)})
            except SupabaseError as exc:
                self._json(502, {"error": str(exc)})
            return

        if path == "/api/push/subscriptions":
            notifier = SERVICE.notifier
            if not notifier:
                self._json(503, {"error": "Push notifications are not configured"})
                return
            try:
                endpoint, p256dh, auth = self._push_subscription(self._read_json())
                subscription = SERVICE.client.upsert_push_subscription(
                    endpoint,
                    p256dh,
                    auth,
                    (self.headers.get("User-Agent") or "")[:300] or None,
                )
                test_sent = True
                try:
                    notifier.send_test(subscription)
                except Exception:
                    test_sent = False
                self._json(HTTPStatus.CREATED, {"ok": True, "testSent": test_sent})
            except ValueError as exc:
                self._json(400, {"error": str(exc)})
            except SupabaseError as exc:
                self._json(502, {"error": str(exc)})
            return

        if path != "/api/packages":
            self._json(404, {"error": "Not found"})
            return

        try:
            payload = self._read_json()
            raw_tracking = payload.get("trackingNumber", "")
            label = payload.get("label", "")
            carrier = payload.get("carrier", "unknown")
            raw_tracking_url = payload.get("trackingUrl", "")
            if not all(
                isinstance(value, str)
                for value in (raw_tracking, label, carrier, raw_tracking_url)
            ):
                raise ValueError("Tracking number, label, carrier and tracking URL must be text")
            tracking_number = re.sub(r"[\s.\-]", "", raw_tracking).upper()
            if not 4 <= len(tracking_number) <= 40:
                raise ValueError("Enter a tracking number between 4 and 40 characters")
            if len(label) > 80:
                raise ValueError("Parcel names can be at most 80 characters")
            if carrier not in VALID_CARRIERS:
                raise ValueError("Choose a supported carrier")
            # Quickpac and Swiss Post both use 18-digit Swiss-style barcodes.
            # Correct stale clients that still classify every such code as Swiss Post.
            if re.fullmatch(r"44\d{16}", tracking_number):
                carrier = "quickpac"
            tracking_url = raw_tracking_url.strip() or None
            if carrier == "planzer" and is_planzer_shared_tracking_number(tracking_number):
                if not tracking_url:
                    raise ValueError(
                        "This Planzer tracking number requires its complete tracking URL"
                    )
                tracking_url = validate_planzer_shared_url(tracking_url, tracking_number)
            elif tracking_url:
                raise ValueError("A tracking URL is only used for Planzer shared shipments")
            package = SERVICE.client.create_package(
                tracking_number, label.strip(), carrier, tracking_url
            )
            try:
                start_immediate_sync(SERVICE, package)
            except SyncQueueFull:
                SERVICE.client.update_package(
                    str(package["id"]),
                    {
                        "sync_status": "error",
                        "sync_error": "The first tracking check could not be queued. Try again shortly.",
                    },
                )
            self._json(HTTPStatus.CREATED, package)
        except ValueError as exc:
            self._json(400, {"error": str(exc)})
        except SupabaseError as exc:
            if exc.status == HTTPStatus.CONFLICT:
                self._json(409, {"error": "This tracking number is already in your delivery box"})
            else:
                self._json(502, {"error": str(exc)})

    def do_DELETE(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if not SERVICE:
            self._json(503, {"error": "The delivery database is not configured"})
            return
        if path == "/api/push/subscriptions":
            try:
                payload = self._read_json()
                endpoint = payload.get("endpoint")
                if not isinstance(endpoint, str) or not self._valid_push_endpoint(endpoint):
                    raise ValueError("Send a valid push endpoint")
                SERVICE.client.delete_push_subscription(endpoint)
                self._json(200, {"ok": True})
            except ValueError as exc:
                self._json(400, {"error": str(exc)})
            except SupabaseError as exc:
                self._json(502, {"error": str(exc)})
            return
        if not path.startswith("/api/packages/"):
            self._json(404, {"error": "Not found"})
            return
        try:
            package_id = str(UUID(path.removeprefix("/api/packages/")))
            SERVICE.client.delete_package(package_id)
            self._json(200, {"ok": True})
        except ValueError:
            self._json(400, {"error": "Invalid package id"})
        except SupabaseError as exc:
            self._json(502, {"error": str(exc)})

    def do_PATCH(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if not SERVICE:
            self._json(503, {"error": "The delivery database is not configured"})
            return
        if not path.startswith("/api/packages/"):
            self._json(404, {"error": "Not found"})
            return
        try:
            package_id = str(UUID(path.removeprefix("/api/packages/")))
        except ValueError:
            self._json(400, {"error": "Invalid package id"})
            return
        try:
            payload = self._read_json()
            label = payload.get("label")
            if not isinstance(label, str):
                raise ValueError("Parcel name must be text")
            if len(label) > 80:
                raise ValueError("Parcel names can be at most 80 characters")
            SERVICE.client.update_package(package_id, {"label": label.strip()})
            package = SERVICE.client.get_package(package_id)
            if not package:
                self._json(404, {"error": "Package not found"})
                return
            self._json(200, package)
        except ValueError as exc:
            self._json(400, {"error": str(exc)})
        except SupabaseError as exc:
            self._json(502, {"error": str(exc)})

    def _read_json(self) -> dict[str, object]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("Invalid request size") from exc
        if length <= 0 or length > MAX_JSON_BODY:
            raise ValueError("Invalid request size")
        try:
            payload = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("Send a valid JSON object") from exc
        if not isinstance(payload, dict):
            raise ValueError("Send a valid JSON object")
        return payload

    @classmethod
    def _push_subscription(cls, payload: dict[str, object]) -> tuple[str, str, str]:
        endpoint = payload.get("endpoint")
        keys = payload.get("keys")
        if not isinstance(endpoint, str) or not cls._valid_push_endpoint(endpoint):
            raise ValueError("Send a valid push endpoint")
        if not isinstance(keys, dict):
            raise ValueError("Send valid push encryption keys")
        p256dh, auth = keys.get("p256dh"), keys.get("auth")
        if not all(isinstance(value, str) and 8 <= len(value) <= 512 for value in (p256dh, auth)):
            raise ValueError("Send valid push encryption keys")
        return endpoint, p256dh, auth

    @staticmethod
    def _valid_push_endpoint(endpoint: str) -> bool:
        if not 1 <= len(endpoint) <= 4096:
            return False
        parsed = urlparse(endpoint)
        return parsed.scheme == "https" and bool(parsed.netloc) and not parsed.username

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
