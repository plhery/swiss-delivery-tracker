"""Serve the PWA and run scheduled carrier synchronization in one container."""

from __future__ import annotations

import base64
import binascii
import hashlib
import ipaddress
import json
import mimetypes
import os
import re
import socket
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, cast
from urllib.parse import parse_qs, unquote, urlparse
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .api_contract import CARRIER_IDS
from .carriers import normalize_carrier_inputs
from .push import (
    CompositePushNotificationService,
    NativePushNotificationService,
    PushNotificationService,
)
from .rate_limit import RateLimiter
from .supabase_auth import SupabaseAuthenticator, SupabaseAuthError, SupabaseUser
from .supabase_client import SupabaseError, SupabaseServiceClient, SupabaseUserClient
from .tracking_sync import TrackingSyncService

DIST = Path(os.environ.get("STATIC_DIR", "/app/dist")).resolve()
API_CONTRACT = Path(
    os.environ.get(
        "API_CONTRACT_PATH",
        str(Path(__file__).resolve().parents[1] / "contracts" / "openapi.json"),
    )
).resolve()
PORT = int(os.environ.get("PORT", "3000"))
SYNC_TIMEZONE = ZoneInfo("Europe/Zurich")
MAX_JSON_BODY = 16_384
AUTO_ARCHIVE_DAYS = 60
MAX_USER_SYNC_JOBS = 5
RECENT_AUTH_MAX_AGE = timedelta(minutes=10)
VALID_CARRIERS = CARRIER_IDS
NOTIFICATION_STAGES = frozenset(
    {
        "registered",
        "accepted",
        "in_transit",
        "customs",
        "out_for_delivery",
        "failed_attempt",
        "ready_for_pickup",
        "delivered",
        "returned",
    }
)
PREAUTH_REQUEST_LIMIT = 300
PREAUTH_REQUEST_WINDOW = 60.0
MAX_HTTP_WORKERS = max(8, int(os.environ.get("MAX_HTTP_WORKERS", "64")))
REQUEST_SOCKET_TIMEOUT = max(5, int(os.environ.get("REQUEST_SOCKET_TIMEOUT", "15")))
PUSH_ENDPOINT_HOSTS = frozenset(
    {
        "android.googleapis.com",
        "fcm.googleapis.com",
        "push.services.mozilla.com",
        "updates.push.services.mozilla.com",
        "web.push.apple.com",
    }
)
PUSH_ENDPOINT_HOST_SUFFIXES = (".notify.windows.com",)


def parse_trusted_proxy_networks(
    value: str | None = None,
) -> tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...]:
    raw = os.environ.get("TRUSTED_PROXY_NETWORKS", "") if value is None else value
    networks: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = []
    for item in raw.split(","):
        if item := item.strip():
            networks.append(ipaddress.ip_network(item, strict=False))
    return tuple(networks)


TRUSTED_PROXY_NETWORKS = parse_trusted_proxy_networks()


def log_event(event: str, **fields: object) -> None:
    """Write one privacy-safe structured event for container log collectors."""
    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "event": event,
        **fields,
    }
    print(json.dumps(payload, separators=(",", ":"), default=str), flush=True)


def api_rate_policy(method: str, path: str) -> tuple[str, int, float]:
    if path == "/api/sync" or path.endswith("/sync"):
        return "sync", 12, 300
    if method in {"GET", "HEAD"}:
        return "read", 240, 60
    return "write", 60, 60


def sync_job_response(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row.get("id"),
        "status": row.get("state"),
        "packageId": row.get("package_id"),
        "requestedAt": row.get("requested_at"),
        "startedAt": row.get("started_at"),
        "completedAt": row.get("completed_at"),
        "result": row.get("result"),
        "error": row.get("last_error"),
    }


def public_supabase_origin() -> str | None:
    raw_url = os.environ.get("SUPABASE_PUBLIC_URL", "").strip()
    if not raw_url:
        raw_url = os.environ.get("SUPABASE_URL", "").strip()
    parsed = urlparse(raw_url)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username
        or parsed.password
    ):
        return None
    return f"{parsed.scheme}://{parsed.netloc}"


def build_authenticator() -> SupabaseAuthenticator | None:
    url = os.environ.get("SUPABASE_URL", "").strip()
    publishable_key = os.environ.get("SUPABASE_PUBLISHABLE_KEY", "").strip()
    if not publishable_key:
        publishable_key = os.environ.get("SUPABASE_ANON_KEY", "").strip()
    if not url and not publishable_key:
        return None
    if not url or not publishable_key:
        raise RuntimeError("SUPABASE_URL and a Supabase publishable key are required")
    return SupabaseAuthenticator(url, publishable_key)


def build_service() -> TrackingSyncService | None:
    url = os.environ.get("SUPABASE_URL", "")
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not all((url, service_key)):
        return None
    client = SupabaseServiceClient(url, service_key)
    public_key = os.environ.get("VAPID_PUBLIC_KEY", "").strip()
    private_key = os.environ.get("VAPID_PRIVATE_KEY", "").strip()
    web_notifier = None
    if public_key and private_key:
        web_notifier = PushNotificationService(
            client,
            public_key,
            private_key,
            os.environ.get("VAPID_SUBJECT", "https://delivery.plhery.com"),
        )
    apns_values = {
        "team_id": os.environ.get("APNS_TEAM_ID", "").strip(),
        "key_id": os.environ.get("APNS_KEY_ID", "").strip(),
        "private_key": os.environ.get("APNS_PRIVATE_KEY", "").strip(),
        "bundle_id": os.environ.get("APNS_BUNDLE_ID", "").strip(),
    }
    if any(apns_values.values()) and not all(apns_values.values()):
        raise RuntimeError(
            "APNS_TEAM_ID, APNS_KEY_ID, APNS_PRIVATE_KEY and APNS_BUNDLE_ID are all required"
        )
    native_notifier = (
        NativePushNotificationService(
            client,
            apns_values["team_id"],
            apns_values["key_id"],
            apns_values["private_key"],
            apns_values["bundle_id"],
        )
        if all(apns_values.values())
        else None
    )
    notifier: (
        PushNotificationService
        | NativePushNotificationService
        | CompositePushNotificationService
        | None
    )
    if web_notifier and native_notifier:
        notifier = CompositePushNotificationService(web_notifier, native_notifier)
    else:
        notifier = web_notifier or native_notifier
    return TrackingSyncService(client, notifier=notifier)


def web_push_notifier() -> PushNotificationService | Any | None:
    notifier = SERVICE.notifier if SERVICE else None
    if isinstance(notifier, CompositePushNotificationService):
        return notifier.web
    if isinstance(notifier, PushNotificationService):
        return notifier
    # Keep test doubles and older injected service objects compatible.
    if notifier is not None and isinstance(getattr(notifier, "public_key", None), str):
        return notifier
    return None


def native_push_notifier() -> NativePushNotificationService | None:
    notifier = SERVICE.notifier if SERVICE else None
    if isinstance(notifier, CompositePushNotificationService):
        return notifier.native
    if isinstance(notifier, NativePushNotificationService):
        return notifier
    return None


STATE: dict[str, object] = {
    "last_scheduled_sync": None,
    "next_scheduled_sync": None,
    "last_summary": None,
    "last_error": None,
    "last_auto_archived": 0,
    "worker_heartbeat": None,
}


@dataclass(frozen=True)
class QueuedSyncJob:
    id: str
    queued: bool


class SyncJobQueue:
    """Claim and run durable, leased sync work away from request threads."""

    def __init__(self, service: TrackingSyncService, poll_interval: float = 1.0) -> None:
        self.service = service
        self.poll_interval = poll_interval
        self.worker_id = f"{socket.gethostname()}:{os.getpid()}:{uuid4().hex[:12]}"
        self._lock = threading.Lock()
        self._wake = threading.Event()
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

    def enqueue_all(self) -> QueuedSyncJob:
        row, queued = self.service.client.enqueue_sync_job(scheduled=True)
        self.start()
        self._wake.set()
        return QueuedSyncJob(str(row["id"]), queued)

    def enqueue_package(
        self, package: dict[str, object], user_id: str
    ) -> QueuedSyncJob:
        row, queued = self.service.client.enqueue_sync_job(
            user_id=user_id,
            package_id=str(package["id"]),
        )
        self.start()
        self._wake.set()
        return QueuedSyncJob(str(row["id"]), queued)

    def pending_count(self, user_id: str | None = None) -> int:
        return self.service.client.pending_sync_job_count(user_id)

    def _run(self) -> None:
        while True:
            STATE["worker_heartbeat"] = time.time()
            if not self._process_next():
                self._wake.wait(self.poll_interval)
                self._wake.clear()

    def _process_next(self) -> bool:
        try:
            job = self.service.client.claim_sync_job(self.worker_id)
        except Exception as exc:
            STATE["last_error"] = exc.__class__.__name__
            log_event("sync_claim_failed", error_type=exc.__class__.__name__)
            return False
        if not job:
            return False

        job_id = str(job["id"])
        kind = str(job["kind"])
        try:
            if kind == "package":
                package = self.service.client.get_package(str(job["package_id"]))
                if not package:
                    raise RuntimeError("Package no longer exists")
                summary = self.service.sync_package(package)
                archived = 0
            else:
                summary = self.service.sync()
                archived = self.service.client.archive_delivered_before(
                    datetime.now(timezone.utc) - timedelta(days=AUTO_ARCHIVE_DAYS)
                )
                STATE.update(
                    last_scheduled_sync=time.time(),
                    last_auto_archived=archived,
                )
            result = {**summary.to_dict(), "auto_archived": archived}
            self.service.client.finish_sync_job(
                job_id,
                self.worker_id,
                result=result,
            )
            STATE.update(last_summary=result, last_error=None)
            log_event("sync_job_completed", job_id=job_id, kind=kind)
        except Exception as exc:
            error_type = exc.__class__.__name__
            STATE["last_error"] = error_type
            log_event(
                "sync_job_failed",
                job_id=job_id,
                kind=kind,
                error_type=error_type,
            )
            try:
                self.service.client.finish_sync_job(
                    job_id,
                    self.worker_id,
                    error="Tracking refresh failed. Try again.",
                )
            except Exception as finish_exc:
                log_event(
                    "sync_job_finish_failed",
                    job_id=job_id,
                    error_type=finish_exc.__class__.__name__,
                )
        return True


SERVICE = build_service()
SYNC_JOBS: SyncJobQueue | None = SyncJobQueue(SERVICE) if SERVICE else None
AUTHENTICATOR = build_authenticator()
RATE_LIMITER = RateLimiter()


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
    return max(
        1.0, (candidate.astimezone(timezone.utc) - current.astimezone(timezone.utc)).total_seconds()
    )


def scheduler() -> None:
    time.sleep(8)
    while SERVICE:
        try:
            sync_jobs(SERVICE).enqueue_all()
            STATE["last_error"] = None
        except Exception as exc:
            STATE["last_error"] = exc.__class__.__name__
            log_event("scheduled_sync_enqueue_failed", error_type=exc.__class__.__name__)
        delay = seconds_until_next_sync()
        STATE["next_scheduled_sync"] = time.time() + delay
        time.sleep(delay)


def start_immediate_sync(
    service: TrackingSyncService,
    package: dict[str, object],
    user_id: str,
) -> QueuedSyncJob:
    """Queue the first carrier lookup without delaying the create response."""
    return sync_jobs(service).enqueue_package(package, user_id)


class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    """Thread-per-request server with bounded admission and slow-client timeouts."""

    daemon_threads = True

    def __init__(
        self,
        server_address: tuple[str, int],
        request_handler_class: type[BaseHTTPRequestHandler],
        *,
        max_workers: int = MAX_HTTP_WORKERS,
    ) -> None:
        self._request_slots = threading.BoundedSemaphore(max(1, max_workers))
        super().__init__(server_address, request_handler_class)

    def get_request(self) -> tuple[Any, Any]:
        request, client_address = super().get_request()
        request.settimeout(REQUEST_SOCKET_TIMEOUT)
        return request, client_address

    def process_request(self, request: Any, client_address: Any) -> None:
        if not self._request_slots.acquire(blocking=False):
            try:
                request.sendall(
                    b"HTTP/1.1 503 Service Unavailable\r\n"
                    b"Connection: close\r\nContent-Length: 0\r\n\r\n"
                )
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._request_slots.release()
            raise

    def process_request_thread(self, request: Any, client_address: Any) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._request_slots.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "DeliveryTracker/3"
    auth_user: SupabaseUser | None = None
    user_client: SupabaseUserClient | None = None
    access_token: str | None = None
    request_id = "unassigned"

    def handle_one_request(self) -> None:
        self.request_id = uuid4().hex
        self.request_started_at = time.monotonic()
        super().handle_one_request()

    def log_message(self, format: str, *args: object) -> None:
        del format
        status = str(args[1]) if len(args) > 1 else None
        route = urlparse(getattr(self, "path", "")).path
        route = re.sub(
            r"/[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}",
            "/:id",
            route,
        )
        duration_ms = round(
            (time.monotonic() - getattr(self, "request_started_at", time.monotonic()))
            * 1000,
            1,
        )
        log_event(
            "http_request",
            request_id=self.request_id,
            method=getattr(self, "command", None),
            route=route or None,
            status=status,
            duration_ms=duration_ms,
        )

    def _json(
        self,
        status: int,
        payload: object,
        *,
        headers: dict[str, str] | None = None,
    ) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._security_headers()
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def _security_headers(self) -> None:
        self.send_header("X-Request-ID", self.request_id)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Strict-Transport-Security", "max-age=31536000")
        connect_sources = "'self'"
        if supabase_origin := public_supabase_origin():
            connect_sources = f"{connect_sources} {supabase_origin}"
        self.send_header(
            "Content-Security-Policy",
            f"default-src 'self'; base-uri 'none'; connect-src {connect_sources}; "
            "font-src 'self'; form-action 'self'; frame-ancestors 'none'; "
            "img-src 'self'; manifest-src 'self'; object-src 'none'; "
            "script-src 'self'; style-src 'self'; worker-src 'self'",
        )
        self.send_header(
            "Permissions-Policy",
            "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
        )

    def _authorize_api(self, path: str) -> bool:
        if not path.startswith("/api/") or path == "/api/openapi.json":
            return True
        authorization = self.headers.get("Authorization", "")
        scheme, separator, raw_token = authorization.partition(" ")
        token = raw_token.strip() if scheme.lower() == "bearer" and separator else ""
        client_ip = self._client_ip()
        credential = hashlib.sha256(token.encode()).hexdigest()[:24] if token else None
        retry_after = RATE_LIMITER.retry_after(
            f"preauth-client:{client_ip}",
            limit=PREAUTH_REQUEST_LIMIT * 3,
            window=PREAUTH_REQUEST_WINDOW,
        )
        if not retry_after and credential:
            retry_after = RATE_LIMITER.retry_after(
                f"preauth-credential:{credential}",
                limit=PREAUTH_REQUEST_LIMIT,
                window=PREAUTH_REQUEST_WINDOW,
            )
        if retry_after:
            self._json(
                HTTPStatus.TOO_MANY_REQUESTS,
                {"error": "Too many authentication attempts. Try again shortly."},
                headers={"Retry-After": str(retry_after)},
            )
            return False
        if AUTHENTICATOR is None:
            self._json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"error": "Supabase authentication is not configured"},
            )
            return False
        if not token:
            self._json(HTTPStatus.UNAUTHORIZED, {"error": "Authentication is required"})
            return False
        try:
            self.auth_user = AUTHENTICATOR.validate(token)
            bucket, limit, window = api_rate_policy(self.command, path)
            retry_after = RATE_LIMITER.retry_after(
                f"{self.auth_user.id}:{bucket}",
                limit=limit,
                window=window,
            )
            if retry_after:
                self._json(
                    HTTPStatus.TOO_MANY_REQUESTS,
                    {"error": "Too many requests. Try again shortly."},
                    headers={"Retry-After": str(retry_after)},
                )
                return False
            self.user_client = AUTHENTICATOR.user_client(token)
            self.access_token = token
        except SupabaseAuthError:
            self._json(HTTPStatus.UNAUTHORIZED, {"error": "Authentication is required"})
            return False
        return True

    def _client_ip(self) -> str:
        peer = str(self.client_address[0]) if self.client_address else "unknown"
        try:
            peer_address = ipaddress.ip_address(peer)
        except ValueError:
            return peer
        if not any(peer_address in network for network in TRUSTED_PROXY_NETWORKS):
            return peer
        forwarded = self.headers.get("CF-Connecting-IP", "").strip()
        if not forwarded:
            forwarded = self.headers.get("X-Forwarded-For", "").partition(",")[0].strip()
        try:
            return str(ipaddress.ip_address(forwarded))
        except ValueError:
            return peer

    def _user_database(self) -> SupabaseUserClient:
        if self.user_client is None:
            raise RuntimeError("Authenticated database client is unavailable")
        return self.user_client

    def _current_user(self) -> SupabaseUser:
        if self.auth_user is None:
            raise RuntimeError("Authenticated user is unavailable")
        return self.auth_user

    def _database_failure(self, error: SupabaseError) -> None:
        if error.status in {HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN}:
            self._json(HTTPStatus.UNAUTHORIZED, {"error": "Authentication is required"})
            return
        self._json(
            HTTPStatus.BAD_GATEWAY,
            {"error": "The delivery database is temporarily unavailable"},
        )

    def do_GET(self) -> None:  # noqa: N802
        parsed_url = urlparse(self.path)
        path = parsed_url.path
        if not self._authorize_api(path):
            return
        if path == "/api/openapi.json":
            try:
                self._json(200, json.loads(API_CONTRACT.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError):
                self._json(503, {"error": "The API contract is unavailable"})
            return
        if path == "/health":
            healthy = SERVICE is not None
            self._json(200 if healthy else 503, {"ok": healthy})
            return
        if path == "/api/account/export":
            if not SERVICE:
                self._json(503, {"error": "The delivery database is not configured"})
                return
            try:
                user = self._current_user()
                self._json(
                    200,
                    {
                        "exportedAt": datetime.now(timezone.utc).isoformat(),
                        "account": {"id": user.id, "email": user.email},
                        "packages": self._user_database().list_packages(include_archived=True),
                    },
                    headers={
                        "Content-Disposition": 'attachment; filename="swiss-delivery-tracker-export.json"'
                    },
                )
            except SupabaseError as exc:
                self._database_failure(exc)
            return
        if path == "/api/packages":
            if not SERVICE:
                self._json(503, {"error": "The delivery database is not configured"})
                return
            try:
                include_archived = parse_qs(parsed_url.query).get("includeArchived") == ["true"]
                self._json(
                    200,
                    {
                        "packages": self._user_database().list_packages(
                            include_archived=include_archived
                        )
                    },
                )
            except SupabaseError as exc:
                self._database_failure(exc)
            return
        sync_job_match = re.fullmatch(r"/api/sync/jobs/([^/]+)", path)
        if sync_job_match:
            if not SERVICE:
                self._json(503, {"error": "The delivery database is not configured"})
                return
            try:
                job_id = str(UUID(sync_job_match.group(1)))
                row = SERVICE.client.get_sync_job(job_id, self._current_user().id)
                if not row:
                    self._json(404, {"error": "Sync job not found"})
                    return
                self._json(200, sync_job_response(row))
            except ValueError:
                self._json(400, {"error": "Invalid sync job id"})
            except SupabaseError as exc:
                self._database_failure(exc)
            return
        if path == "/api/push/config":
            notifier = web_push_notifier()
            self._json(
                200,
                {
                    "available": notifier is not None,
                    "publicKey": notifier.public_key if notifier else None,
                },
            )
            return
        if path == "/api/push/preferences":
            if not SERVICE:
                self._json(503, {"error": "The delivery database is not configured"})
                return
            try:
                row = self._user_database().get_notification_preferences()
                self._json(200, self._notification_preferences_response(row))
            except SupabaseError as exc:
                self._database_failure(exc)
            return
        self._serve_static(path)

    def do_HEAD(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if not self._authorize_api(path):
            return
        if path == "/health":
            self.send_response(200 if SERVICE else 503)
            self._security_headers()
            self.end_headers()
            return
        self._serve_static(path, head_only=True)

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if not self._authorize_api(path):
            return
        if not SERVICE:
            self._json(503, {"error": "The delivery database is not configured"})
            return

        if path == "/api/sync":
            try:
                jobs = sync_jobs(SERVICE)
                queued = False
                job_ids: list[str] = []
                user_id = self._current_user().id
                for owned_package in self._user_database().list_active_packages()[
                    :MAX_USER_SYNC_JOBS
                ]:
                    job = jobs.enqueue_package(owned_package, user_id)
                    queued = job.queued or queued
                    if job.id not in job_ids:
                        job_ids.append(job.id)
                self._json(
                    HTTPStatus.ACCEPTED,
                    {
                        "queued": queued,
                        "pending": jobs.pending_count(user_id),
                        "jobIds": job_ids,
                    },
                )
            except SupabaseError as exc:
                self._database_failure(exc)
            return

        package_sync = re.fullmatch(r"/api/packages/([^/]+)/sync", path)
        if package_sync:
            try:
                package_id = str(UUID(package_sync.group(1)))
                sync_package_row = self._user_database().get_package(package_id)
                if not sync_package_row:
                    self._json(404, {"error": "Package not found"})
                    return
                jobs = sync_jobs(SERVICE)
                user_id = self._current_user().id
                job = jobs.enqueue_package(sync_package_row, user_id)
                self._json(
                    HTTPStatus.ACCEPTED,
                    {
                        "queued": job.queued,
                        "pending": jobs.pending_count(user_id),
                        "jobIds": [job.id],
                    },
                )
            except ValueError:
                self._json(400, {"error": "Invalid package id"})
            except SupabaseError as exc:
                self._database_failure(exc)
            return

        package_restore = re.fullmatch(r"/api/packages/([^/]+)/restore", path)
        if package_restore:
            try:
                package_id = str(UUID(package_restore.group(1)))
                client = self._user_database()
                restore_package_row = client.get_package(package_id)
                if not restore_package_row:
                    self._json(404, {"error": "Package not found"})
                    return
                client.restore_package(package_id)
                restored = client.get_package(package_id)
                self._json(200, restored or {**restore_package_row, "archived_at": None})
            except ValueError:
                self._json(400, {"error": "Invalid package id"})
            except SupabaseError as exc:
                if exc.code == "P0001":
                    self._json(409, {"error": "Your delivery box has reached its parcel limit"})
                else:
                    self._database_failure(exc)
            return

        if path == "/api/push/subscriptions":
            notifier = web_push_notifier()
            if not notifier:
                self._json(503, {"error": "Push notifications are not configured"})
                return
            try:
                endpoint, p256dh, auth = self._push_subscription(self._read_json())
                subscription = SERVICE.client.upsert_push_subscription(
                    self._current_user().id,
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
                self._database_failure(exc)
            return

        if path == "/api/push/devices":
            notifier = native_push_notifier()
            if not notifier:
                self._json(503, {"error": "Native push notifications are not configured"})
                return
            try:
                token, environment, locale, device_name, send_test = self._native_push_device(
                    self._read_json()
                )
                device = SERVICE.client.upsert_native_push_device(
                    self._current_user().id,
                    token,
                    environment,
                    locale,
                    device_name,
                )
                test_sent = False
                if send_test:
                    try:
                        notifier.send_test(device)
                        test_sent = True
                    except Exception:
                        pass
                self._json(HTTPStatus.CREATED, {"ok": True, "testSent": test_sent})
            except ValueError as exc:
                self._json(400, {"error": str(exc)})
            except SupabaseError as exc:
                self._database_failure(exc)
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
            raw_dpd_postcode = payload.get("dpdPostcode", "")
            if (
                not isinstance(raw_tracking, str)
                or not isinstance(label, str)
                or not isinstance(carrier, str)
                or not isinstance(raw_tracking_url, str)
                or not isinstance(raw_dpd_postcode, str)
            ):
                raise ValueError(
                    "Tracking number, label, carrier, tracking URL and postcode must be text"
                )
            tracking_number = re.sub(r"[\s.\-]", "", raw_tracking).upper()
            if not 4 <= len(tracking_number) <= 40:
                raise ValueError("Enter a tracking number between 4 and 40 characters")
            if not re.fullmatch(r"[A-Z0-9]+", tracking_number) or not re.search(
                r"\d", tracking_number
            ):
                raise ValueError(
                    "Tracking numbers must use letters and numbers and include a digit"
                )
            if len(label) > 80:
                raise ValueError("Parcel names can be at most 80 characters")
            if carrier not in VALID_CARRIERS:
                raise ValueError("Choose a supported carrier")
            # Quickpac and Swiss Post both use 18-digit Swiss-style barcodes.
            # Correct stale clients that still classify every such code as Swiss Post.
            if re.fullmatch(r"44\d{16}", tracking_number):
                carrier = "quickpac"
            tracking_url = raw_tracking_url.strip() or None
            dpd_postcode = raw_dpd_postcode.strip() or None
            tracking_url, dpd_postcode = normalize_carrier_inputs(
                carrier,
                tracking_number,
                tracking_url or "",
                dpd_postcode or "",
            )
            client = self._user_database()
            created_package = client.create_package(
                tracking_number,
                label.strip(),
                carrier,
                tracking_url,
                dpd_postcode,
            )
            created_job_ids: list[str] = []
            try:
                job = start_immediate_sync(
                    SERVICE,
                    created_package,
                    self._current_user().id,
                )
                created_job_ids.append(job.id)
            except SupabaseError:
                SERVICE.client.update_package(
                    str(created_package["id"]),
                    {
                        "sync_status": "error",
                        "sync_error": "The first tracking check could not be queued. Try again shortly.",
                    },
                )
            self._json(
                HTTPStatus.CREATED,
                {"package": created_package, "jobIds": created_job_ids},
            )
        except ValueError as exc:
            self._json(400, {"error": str(exc)})
        except SupabaseError as exc:
            if exc.code == "P0001":
                self._json(409, {"error": "Your delivery box has reached its parcel limit"})
            elif exc.status == HTTPStatus.CONFLICT:
                self._json(409, {"error": "This tracking number is already in your delivery box"})
            else:
                self._database_failure(exc)

    def do_DELETE(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if not self._authorize_api(path):
            return
        if not SERVICE:
            self._json(503, {"error": "The delivery database is not configured"})
            return
        if path == "/api/account":
            try:
                payload = self._read_json()
                confirmation = payload.get("confirmation")
                user = self._current_user()
                if (
                    not isinstance(confirmation, str)
                    or not user.email
                    or confirmation.strip().casefold() != user.email.casefold()
                ):
                    raise ValueError("Type your account email exactly to confirm deletion")
                if AUTHENTICATOR is None or self.access_token is None:
                    self._json(
                        HTTPStatus.UNAUTHORIZED,
                        {"error": "Sign in again before permanently deleting your account"},
                    )
                    return
                # This service-role operation must not rely on the short identity
                # cache or on the account-global user.last_sign_in_at value. Recheck
                # the token and use the current session's interactive AMR timestamp.
                try:
                    fresh_user = AUTHENTICATOR.validate(self.access_token, use_cache=False)
                except SupabaseAuthError:
                    self._json(
                        HTTPStatus.UNAUTHORIZED,
                        {"error": "Sign in again before permanently deleting your account"},
                    )
                    return
                if fresh_user.id != user.id or fresh_user.session_id is None:
                    self._json(
                        HTTPStatus.UNAUTHORIZED,
                        {"error": "Sign in again before permanently deleting your account"},
                    )
                    return
                last_sign_in = fresh_user.authenticated_at
                age = (
                    datetime.now(timezone.utc) - last_sign_in if last_sign_in is not None else None
                )
                if age is None or age < -timedelta(minutes=1) or age > RECENT_AUTH_MAX_AGE:
                    self._json(
                        HTTPStatus.UNAUTHORIZED,
                        {"error": "Sign in again before permanently deleting your account"},
                    )
                    return
                SERVICE.client.delete_auth_user(fresh_user.id)
                self._json(200, {"ok": True})
            except ValueError as exc:
                self._json(400, {"error": str(exc)})
            except SupabaseError as exc:
                self._database_failure(exc)
            return
        if path == "/api/push/subscriptions":
            try:
                payload = self._read_json()
                endpoint = payload.get("endpoint")
                if not isinstance(endpoint, str) or not self._valid_push_endpoint(endpoint):
                    raise ValueError("Send a valid push endpoint")
                SERVICE.client.delete_push_subscription(
                    self._current_user().id,
                    endpoint,
                )
                self._json(200, {"ok": True})
            except ValueError as exc:
                self._json(400, {"error": str(exc)})
            except SupabaseError as exc:
                self._database_failure(exc)
            return
        if path == "/api/push/devices":
            try:
                token, _environment, _locale, _device_name, _send_test = (
                    self._native_push_device(
                        self._read_json(), registration=False
                    )
                )
                SERVICE.client.delete_native_push_device(
                    self._current_user().id,
                    token,
                )
                self._json(200, {"ok": True})
            except ValueError as exc:
                self._json(400, {"error": str(exc)})
            except SupabaseError as exc:
                self._database_failure(exc)
            return
        if not path.startswith("/api/packages/"):
            self._json(404, {"error": "Not found"})
            return
        package_permanent = re.fullmatch(r"/api/packages/([^/]+)/permanent", path)
        if package_permanent:
            try:
                package_id = str(UUID(package_permanent.group(1)))
                client = self._user_database()
                package = client.get_package(package_id)
                if not package:
                    self._json(404, {"error": "Package not found"})
                    return
                if not client.delete_package(package_id):
                    self._json(404, {"error": "Package not found"})
                    return
                self._json(200, {"ok": True})
            except ValueError:
                self._json(400, {"error": "Invalid package id"})
            except SupabaseError as exc:
                self._database_failure(exc)
            return
        try:
            package_id = str(UUID(path.removeprefix("/api/packages/")))
            client = self._user_database()
            if not client.get_package(package_id):
                self._json(404, {"error": "Package not found"})
                return
            client.archive_package(package_id)
            self._json(200, {"ok": True})
        except ValueError:
            self._json(400, {"error": "Invalid package id"})
        except SupabaseError as exc:
            self._database_failure(exc)

    def do_PATCH(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if not self._authorize_api(path):
            return
        if not SERVICE:
            self._json(503, {"error": "The delivery database is not configured"})
            return
        if path == "/api/push/preferences":
            try:
                stages, quiet_start, quiet_end, timezone_name = (
                    self._notification_preferences(self._read_json())
                )
                row = self._user_database().set_notification_preferences(
                    stages,
                    quiet_start,
                    quiet_end,
                    timezone_name,
                )
                self._json(200, self._notification_preferences_response(row))
            except ValueError as exc:
                self._json(400, {"error": str(exc)})
            except SupabaseError as exc:
                self._database_failure(exc)
            return

        package_notifications = re.fullmatch(
            r"/api/packages/([^/]+)/notifications", path
        )
        if package_notifications:
            try:
                package_id = str(UUID(package_notifications.group(1)))
                muted = self._read_json().get("muted")
                if not isinstance(muted, bool):
                    raise ValueError("Muted must be true or false")
                client = self._user_database()
                client.update_package(package_id, {"notifications_muted": muted})
                package = client.get_package(package_id)
                if not package:
                    self._json(404, {"error": "Package not found"})
                    return
                self._json(200, package)
            except ValueError as exc:
                self._json(400, {"error": str(exc)})
            except SupabaseError as exc:
                if exc.status == HTTPStatus.NOT_FOUND:
                    self._json(404, {"error": "Package not found"})
                else:
                    self._database_failure(exc)
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
            client = self._user_database()
            client.update_package(package_id, {"label": label.strip()})
            package = client.get_package(package_id)
            if not package:
                self._json(404, {"error": "Package not found"})
                return
            self._json(200, package)
        except ValueError as exc:
            self._json(400, {"error": str(exc)})
        except SupabaseError as exc:
            self._database_failure(exc)

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
        p256dh = keys.get("p256dh")
        auth = keys.get("auth")
        if not isinstance(p256dh, str) or not isinstance(auth, str):
            raise ValueError("Send valid push encryption keys")
        try:
            public_key = cls._decode_base64url(p256dh)
            auth_secret = cls._decode_base64url(auth)
        except (ValueError, binascii.Error):
            raise ValueError("Send valid push encryption keys") from None
        if len(public_key) != 65 or public_key[0] != 4 or len(auth_secret) != 16:
            raise ValueError("Send valid push encryption keys")
        return endpoint, p256dh, auth

    @staticmethod
    def _native_push_device(
        payload: dict[str, object], *, registration: bool = True
    ) -> tuple[str, str, str, str | None, bool]:
        token = payload.get("token")
        if not isinstance(token, str):
            raise ValueError("Send a valid APNs device token")
        token = token.strip().casefold()
        if (
            not 32 <= len(token) <= 512
            or len(token) % 2 != 0
            or not re.fullmatch(r"[0-9a-f]+", token)
        ):
            raise ValueError("Send a valid APNs device token")
        if not registration:
            return token, "production", "en", None, False

        environment = payload.get("environment")
        locale = payload.get("locale")
        device_name = payload.get("deviceName")
        send_test = payload.get("sendTest")
        if environment not in {"development", "production"}:
            raise ValueError("Choose a valid APNs environment")
        if locale not in {"en", "de", "fr", "it"}:
            raise ValueError("Choose a supported notification locale")
        if not isinstance(send_test, bool):
            raise ValueError("SendTest must be true or false")
        if device_name is not None and not isinstance(device_name, str):
            raise ValueError("Device name must be text")
        cleaned_name = device_name.strip() if isinstance(device_name, str) else None
        if cleaned_name and len(cleaned_name) > 100:
            raise ValueError("Device name can be at most 100 characters")
        return token, environment, locale, cleaned_name or None, send_test

    @staticmethod
    def _notification_preferences(
        payload: dict[str, object],
    ) -> tuple[list[str], str | None, str | None, str]:
        raw_stages = payload.get("enabledStages")
        quiet_start = payload.get("quietHoursStart")
        quiet_end = payload.get("quietHoursEnd")
        timezone_name = payload.get("timezone")
        if (
            not isinstance(raw_stages, list)
            or not raw_stages
            or len(raw_stages) > len(NOTIFICATION_STAGES)
            or any(not isinstance(stage, str) for stage in raw_stages)
        ):
            raise ValueError("Choose at least one notification event")
        stages = cast(list[str], raw_stages)
        if len(set(stages)) != len(stages) or not set(stages) <= NOTIFICATION_STAGES:
            raise ValueError("Choose valid notification events")
        if (quiet_start is None) != (quiet_end is None):
            raise ValueError("Set both quiet-hour times or turn quiet hours off")
        for value in (quiet_start, quiet_end):
            if value is not None and (
                not isinstance(value, str)
                or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value)
            ):
                raise ValueError("Use valid quiet-hour times")
        if quiet_start is not None and quiet_start == quiet_end:
            raise ValueError("Quiet hours must have different start and end times")
        if not isinstance(timezone_name, str) or not 1 <= len(timezone_name) <= 64:
            raise ValueError("Use a valid timezone")
        try:
            ZoneInfo(timezone_name)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError("Use a valid timezone") from None
        return stages, cast(str | None, quiet_start), cast(str | None, quiet_end), timezone_name

    @staticmethod
    def _notification_preferences_response(row: dict[str, Any]) -> dict[str, Any]:
        def short_time(value: object) -> str | None:
            return value[:5] if isinstance(value, str) else None

        return {
            "enabledStages": row.get("enabled_stages", []),
            "quietHoursStart": short_time(row.get("quiet_hours_start")),
            "quietHoursEnd": short_time(row.get("quiet_hours_end")),
            "timezone": row.get("timezone", "Europe/Zurich"),
        }

    @staticmethod
    def _decode_base64url(value: str) -> bytes:
        if not value or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
            raise ValueError("Invalid base64url value")
        padding = b"=" * ((4 - len(value) % 4) % 4)
        return base64.b64decode(value.encode() + padding, altchars=b"-_", validate=True)

    @staticmethod
    def _valid_push_endpoint(endpoint: str) -> bool:
        if not 1 <= len(endpoint) <= 4096:
            return False
        try:
            parsed = urlparse(endpoint)
            port = parsed.port
        except ValueError:
            return False
        hostname = (parsed.hostname or "").rstrip(".").casefold()
        allowed_host = hostname in PUSH_ENDPOINT_HOSTS or any(
            hostname.endswith(suffix) for suffix in PUSH_ENDPOINT_HOST_SUFFIXES
        )
        return (
            parsed.scheme == "https"
            and allowed_host
            and port in {None, 443}
            and parsed.username is None
            and parsed.password is None
            and not parsed.fragment
        )

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
        sync_jobs(SERVICE).start()
        threading.Thread(target=scheduler, name="delivery-sync", daemon=True).start()
    server = BoundedThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log_event(
        "server_started",
        port=PORT,
        sync_enabled=SERVICE is not None,
        trusted_proxy_networks=len(TRUSTED_PROXY_NETWORKS),
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
