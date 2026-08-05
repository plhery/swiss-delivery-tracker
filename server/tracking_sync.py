"""Carrier polling built around blue-plhery-assistant/swiss-delivery-tracker."""

from __future__ import annotations

import hashlib
import json
import threading
from collections import defaultdict, deque
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone, tzinfo
from typing import Any, Protocol
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .bounded_http import install_bounded_http
from .dpd import DPDTracker
from .planzer_shared import PlanzerSharedTracker
from .supabase_client import SupabaseServiceClient
from .ups import UPSTracker

CARRIER_NAMES = {
    "swiss-post": "Swiss Post",
    "quickpac": "Quickpac",
    "planzer": "Planzer",
    "aliexpress": "AliExpress",
    "sunyou": "SunYou",
    "hermes": "Hermes Einrichtungs-Service",
    "spring-gds": "Spring GDS",
    "postlogistics": "PostLogistics",
    "dpd": "DPD",
    "ups": "UPS",
}

ZURICH = ZoneInfo("Europe/Zurich")
CARRIER_TIMEZONES: dict[str, tzinfo] = {
    "swiss-post": ZURICH,
    "quickpac": ZURICH,
    "planzer": ZURICH,
    "hermes": ZURICH,
    "postlogistics": ZURICH,
    "dpd": ZURICH,
}
MAX_PACKAGES_PER_OWNER_PER_SYNC = 5


class CarrierAdapter(Protocol):
    def fetch(
        self,
        carrier_id: str,
        tracking_number: str,
        tracking_url: str | None,
        dpd_postcode: str | None = None,
    ) -> dict[str, Any]: ...


class NotificationDispatcher(Protocol):
    def dispatch(self) -> Any: ...


class UpstreamTrackerAdapter:
    """Loads the pinned upstream tracker only in the production image."""

    def __init__(
        self,
        dpd_tracker: DPDTracker | None = None,
        planzer_shared_tracker: PlanzerSharedTracker | None = None,
        ups_tracker: UPSTracker | None = None,
    ) -> None:
        from swiss_delivery_tracker import carriers as carrier_package
        from swiss_delivery_tracker.tracker import CARRIER_MODULES

        self.modules = CARRIER_MODULES
        install_bounded_http(carrier_package)
        for module in self.modules.values():
            install_bounded_http(module)
        self.dpd_tracker = dpd_tracker or DPDTracker()
        self.planzer_shared_tracker = planzer_shared_tracker or PlanzerSharedTracker()
        self.ups_tracker = ups_tracker or UPSTracker()

    def fetch(
        self,
        carrier_id: str,
        tracking_number: str,
        tracking_url: str | None,
        dpd_postcode: str | None = None,
    ) -> dict[str, Any]:
        if carrier_id == "dpd":
            return self.dpd_tracker.fetch(tracking_number, dpd_postcode)
        if carrier_id == "ups":
            return self.ups_tracker.fetch(tracking_number)
        if carrier_id == "planzer" and tracking_url:
            return self.planzer_shared_tracker.fetch(tracking_number, tracking_url)
        carrier_name = CARRIER_NAMES.get(carrier_id)
        if not carrier_name:
            raise LookupError(f"Automatic tracking is not available for {carrier_id}")
        module = self.modules.get(carrier_name)
        if not module:
            raise LookupError(f"The upstream tracker has no {carrier_name} adapter")
        result = (
            module.fetch(tracking_number, tracking_url)
            if carrier_name == "Dachser"
            else module.fetch(tracking_number)
        )
        if not isinstance(result, dict):
            raise ValueError(f"The {carrier_name} adapter returned an invalid response")
        return result


@dataclass
class SyncSummary:
    checked: int = 0
    updated: int = 0
    waiting: int = 0
    errors: int = 0
    unsupported: int = 0
    notifications_sent: int = 0
    notification_errors: int = 0
    subscriptions_expired: int = 0

    def to_dict(self) -> dict[str, int]:
        return {
            "checked": self.checked,
            "updated": self.updated,
            "waiting": self.waiting,
            "errors": self.errors,
            "unsupported": self.unsupported,
            "notifications_sent": self.notifications_sent,
            "notification_errors": self.notification_errors,
            "subscriptions_expired": self.subscriptions_expired,
        }


def infer_stage(text: str, fallback: str = "in_transit") -> str:
    value = text.casefold()
    if any(word in value for word in ("return to sender", "returned", "retour")):
        return "returned"
    if any(word in value for word in ("delivered", "deposited", "zugestellt")):
        return "delivered"
    if any(word in value for word in ("ready for pickup", "ready for collection", "abholbereit")):
        return "ready_for_pickup"
    if any(word in value for word in ("out for delivery", "in delivery", "zustellung")):
        return "out_for_delivery"
    if any(word in value for word in ("customs", "custom clearance", "zoll")):
        return "customs"
    if any(word in value for word in ("failed", "unsuccessful", "missed delivery", "not delivered")):
        return "failed_attempt"
    if any(
        word in value
        for word in (
            "accepted",
            "received at",
            "handed over",
            "handed to dpd",
            "parcel handed",
            "posted",
        )
    ):
        return "accepted"
    if any(word in value for word in ("announced", "registered", "label created", "information received")):
        return "registered"
    if any(
        word in value
        for word in (
            "transit",
            "sorted",
            "departed",
            "arrived",
            "transport",
            "delivery centre",
            "depot",
        )
    ):
        return "in_transit"
    return fallback


def result_stage(result: dict[str, Any]) -> str | None:
    status = str(result.get("status") or "unknown")
    text = str(result.get("last_status_text") or "")
    mapping = {
        "pending": infer_stage(text, "pending"),
        "in_transit": "in_transit",
        "out_for_delivery": "out_for_delivery",
        "delivered": "delivered",
        "exception": infer_stage(text, "failed_attempt"),
    }
    return mapping.get(status)


def result_timezone(carrier_id: str, result: dict[str, Any]) -> tzinfo:
    declared = result.get("timezone")
    if isinstance(declared, str) and 1 <= len(declared) <= 64:
        try:
            return ZoneInfo(declared)
        except (ValueError, ZoneInfoNotFoundError):
            pass
    return CARRIER_TIMEZONES.get(carrier_id, timezone.utc)


def event_timestamp(
    raw: Any,
    fallback: datetime,
    assumed_timezone: tzinfo = timezone.utc,
) -> str:
    if isinstance(raw, str) and raw.strip():
        value = raw.strip()
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=assumed_timezone)
            return parsed.astimezone(timezone.utc).isoformat()
        except ValueError:
            for fmt in ("%Y-%m-%d %H:%M", "%d.%m.%Y %H:%M", "%Y-%m-%d"):
                try:
                    parsed = datetime.strptime(value, fmt).replace(tzinfo=assumed_timezone)
                    return parsed.astimezone(timezone.utc).isoformat()
                except ValueError:
                    continue
    return fallback.isoformat()


def provider_event_id(carrier_id: str, raw_time: Any, location: str, description: str) -> str:
    material = json.dumps(
        [carrier_id, str(raw_time or ""), location.strip(), description.strip()],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return f"{carrier_id}:{hashlib.sha256(material.encode()).hexdigest()}"


def build_events(package: dict[str, Any], result: dict[str, Any], now: datetime) -> list[dict[str, Any]]:
    current = result_stage(result) or "in_transit"
    assumed_timezone = result_timezone(str(package.get("carrier") or ""), result)
    rows: list[dict[str, Any]] = []
    for raw in result.get("events") or []:
        description = str(raw.get("description") or "Tracking update").strip()
        location = str(raw.get("location") or "").strip()
        raw_time = raw.get("time")
        rows.append(
            {
                "package_id": package["id"],
                "stage": infer_stage(description, current),
                "description": description,
                "location": location or None,
                "occurred_at": event_timestamp(raw_time, now, assumed_timezone),
                "provider_event_id": provider_event_id(
                    package["carrier"], raw_time, location, description
                ),
                "raw_data": raw,
            }
        )

    if not rows and current and result.get("last_status_text"):
        description = str(result["last_status_text"])
        raw_time = result.get("last_update")
        rows.append(
            {
                "package_id": package["id"],
                "stage": current,
                "description": description,
                "location": None,
                "occurred_at": event_timestamp(raw_time, now, assumed_timezone),
                "provider_event_id": provider_event_id(
                    package["carrier"], raw_time, "", description
                ),
                "raw_data": {},
            }
        )
    return rows


class TrackingSyncService:
    def __init__(
        self,
        client: SupabaseServiceClient,
        adapter: CarrierAdapter | None = None,
        notifier: NotificationDispatcher | None = None,
        now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ) -> None:
        self.client = client
        self.adapter = adapter or UpstreamTrackerAdapter()
        self.notifier = notifier
        self.now = now
        self.lock = threading.Lock()

    def sync(self) -> SyncSummary:
        summary = SyncSummary()
        with self.lock:
            for package in fair_sync_packages(self.client.list_active_packages()):
                summary.checked += 1
                outcome = self._sync_package(package)
                setattr(summary, outcome, getattr(summary, outcome) + 1)
            self._dispatch_notifications(summary)
        return summary

    def sync_package(self, package: dict[str, Any]) -> SyncSummary:
        """Sync one newly created package without waiting for the scheduler."""
        summary = SyncSummary(checked=1)
        with self.lock:
            outcome = self._sync_package(package)
            setattr(summary, outcome, getattr(summary, outcome) + 1)
            self._dispatch_notifications(summary)
        return summary

    def _dispatch_notifications(self, summary: SyncSummary) -> None:
        if not self.notifier:
            return
        try:
            push = self.notifier.dispatch()
            summary.notifications_sent = push.sent
            summary.notification_errors = push.failed
            summary.subscriptions_expired = push.expired
        except Exception:
            summary.notification_errors += 1

    def _sync_package(self, package: dict[str, Any]) -> str:
        now = self.now()
        if package.get("carrier") not in CARRIER_NAMES:
            self.client.update_package(
                package["id"],
                {
                    "sync_status": "unsupported",
                    "sync_error": "Choose a carrier with an automatic adapter or use the carrier link.",
                    # No carrier request happened, so do not present this as a
                    # successful "last checked" time in the detail view.
                    "last_synced_at": None,
                },
            )
            return "unsupported"

        self.client.update_package(package["id"], {"sync_status": "syncing", "sync_error": None})
        try:
            if package["carrier"] == "dpd":
                result = self.adapter.fetch(
                    package["carrier"],
                    package["tracking_number"],
                    package.get("tracking_url"),
                    package.get("dpd_postcode"),
                )
            else:
                result = self.adapter.fetch(
                    package["carrier"],
                    package["tracking_number"],
                    package.get("tracking_url"),
                )
            events = build_events(package, result, now)
            self.client.insert_events(events)
            reported_stage = result_stage(result)
            latest_event = max(events, key=lambda event: str(event["occurred_at"])) if events else None
            # Carrier summaries are occasionally missing or lag behind their event
            # history. Keep the denormalized package stage aligned with the newest
            # event because scheduling and automatic archiving rely on this column.
            stage = str(latest_event["stage"]) if latest_event else reported_stage
            has_update = bool(
                (stage and stage != "pending")
                or any(event["stage"] != "pending" for event in events)
            )
            values: dict[str, Any] = {
                "last_synced_at": now.isoformat(),
                "sync_status": "ok" if has_update else "waiting",
                "sync_error": None,
                "last_status_text": result.get("last_status_text") or None,
                "expected_delivery": str(result["expected_delivery"])
                if result.get("expected_delivery")
                else None,
                "carrier_data": {
                    key: value
                    for key, value in result.items()
                    if key not in {"events"} and value is not None
                },
            }
            if stage:
                values["current_stage"] = stage
            self.client.update_package(package["id"], values)
            return "updated" if has_update else "waiting"
        except Exception as exc:  # carrier sites fail independently; keep polling the rest
            message = str(exc).strip() or exc.__class__.__name__
            if exc.__class__.__name__ == "JSONDecodeError":
                message = "The carrier returned a maintenance page instead of tracking data."
            self.client.update_package(
                package["id"],
                {
                    "last_synced_at": now.isoformat(),
                    "sync_status": "error",
                    "sync_error": message[:500],
                },
            )
            return "errors"


def fair_sync_packages(
    packages: list[dict[str, Any]],
    per_owner_limit: int = MAX_PACKAGES_PER_OWNER_PER_SYNC,
) -> list[dict[str, Any]]:
    """Round-robin work so one account cannot monopolize a scheduled run."""
    if per_owner_limit < 1:
        raise ValueError("Per-owner synchronization limits must be positive")
    grouped: dict[str, deque[dict[str, Any]]] = defaultdict(deque)
    for package in packages:
        owner = str(package.get("user_id") or f"legacy:{package.get('id')}")
        grouped[owner].append(package)

    ordered: list[dict[str, Any]] = []
    served: dict[str, int] = defaultdict(int)
    active = deque(grouped)
    while active:
        owner = active.popleft()
        rows = grouped[owner]
        if not rows or served[owner] >= per_owner_limit:
            continue
        ordered.append(rows.popleft())
        served[owner] += 1
        if rows and served[owner] < per_owner_limit:
            active.append(owner)
    return ordered
