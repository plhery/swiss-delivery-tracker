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

from .api_contract import STAGES
from .bounded_http import install_bounded_http
from .carrier_result import CarrierResult, normalize_carrier_result
from .carriers import (
    AUTOMATIC_CARRIER_IDS,
    CARRIER_NAMES,
    carrier_adapter,
    carrier_timezone,
    supports_swiss_post_handoff,
)
from .dachser import DachserTracker
from .dpd import DPDTracker
from .hermes import HermesTracker
from .planzer_shared import PlanzerSharedTracker
from .supabase_client import SupabaseServiceClient
from .ups import UPSTracker

MAX_PACKAGES_PER_OWNER_PER_SYNC = 5


class CarrierAdapter(Protocol):
    def fetch(
        self,
        carrier_id: str,
        tracking_number: str,
        tracking_url: str | None,
        dpd_postcode: str | None = None,
    ) -> CarrierResult: ...


class NotificationDispatcher(Protocol):
    def dispatch(self) -> Any: ...


class UpstreamTrackerAdapter:
    """Loads the pinned upstream tracker only in the production image."""

    def __init__(
        self,
        dpd_tracker: DPDTracker | None = None,
        dachser_tracker: DachserTracker | None = None,
        hermes_tracker: HermesTracker | None = None,
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
        self.dachser_tracker = dachser_tracker or DachserTracker()
        self.hermes_tracker = hermes_tracker or HermesTracker()
        self.planzer_shared_tracker = planzer_shared_tracker or PlanzerSharedTracker()
        self.ups_tracker = ups_tracker or UPSTracker()

    def fetch(
        self,
        carrier_id: str,
        tracking_number: str,
        tracking_url: str | None,
        dpd_postcode: str | None = None,
    ) -> CarrierResult:
        adapter = carrier_adapter(carrier_id)
        if adapter == "dpd":
            result = self.dpd_tracker.fetch(tracking_number, dpd_postcode)
        elif adapter == "dachser":
            if not tracking_url:
                raise ValueError("Dachser tracking requires its complete tracking URL")
            result = self.dachser_tracker.fetch(tracking_number, tracking_url)
        elif adapter == "hermes":
            result = self.hermes_tracker.fetch(tracking_number)
        elif adapter == "ups":
            result = self.ups_tracker.fetch(tracking_number)
        elif adapter == "planzer" and tracking_url:
            result = self.planzer_shared_tracker.fetch(tracking_number, tracking_url)
        else:
            carrier_name = CARRIER_NAMES.get(carrier_id)
            if not carrier_name:
                raise LookupError(f"Automatic tracking is not available for {carrier_id}")
            module = self.modules.get(carrier_name)
            if not module:
                raise LookupError(f"The upstream tracker has no {carrier_name} adapter")
            result = module.fetch(tracking_number)
        return normalize_carrier_result(result)


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
    value = " ".join(text.casefold().replace("_", " ").split())
    if "to be delivered" in value:
        return "in_transit"
    if any(word in value for word in ("return to sender", "returned", "retour")):
        return "returned"
    if any(
        word in value
        for word in (
            "not delivered",
            "could not be delivered",
            "unable to deliver",
            "delivery attempt",
            "failed",
            "unsuccessful",
            "missed delivery",
            "nicht zugestellt",
            "zustellung nicht möglich",
            "non livré",
            "livraison impossible",
            "échec de livraison",
            "mancata consegna",
        )
    ):
        return "failed_attempt"
    if any(word in value for word in ("delivered", "deposited", "zugestellt")):
        return "delivered"
    if any(word in value for word in ("ready for pickup", "ready for collection", "abholbereit")):
        return "ready_for_pickup"
    if any(word in value for word in ("out for delivery", "in delivery", "zustellung")):
        return "out_for_delivery"
    if any(word in value for word in ("customs", "custom clearance", "zoll")):
        return "customs"
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
    if any(
        word in value
        for word in ("announced", "registered", "label created", "information received")
    ):
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


def result_stage(result: CarrierResult) -> str | None:
    status = str(result.get("status") or "unknown")
    text = str(result.get("last_status_text") or "")
    mapping = {
        "pending": infer_stage(text, "pending"),
        "in_transit": infer_stage(text, "in_transit"),
        "out_for_delivery": infer_stage(text, "out_for_delivery"),
        "delivered": infer_stage(text, "delivered"),
        "exception": infer_stage(text, "failed_attempt"),
    }
    return mapping.get(status)


def result_has_update(result: CarrierResult) -> bool:
    """Return whether a carrier has announced a usable shipment state."""

    stage = result_stage(result)
    if stage and stage != "pending":
        return True
    for raw in result.get("events") or []:
        declared_stage = str(raw.get("stage") or "")
        if declared_stage in STAGES and declared_stage != "pending":
            return True
        description = str(raw.get("description") or "")
        if description and infer_stage(description, "pending") != "pending":
            return True
    return False


def result_timezone(carrier_id: str, result: CarrierResult) -> tzinfo:
    declared = result.get("timezone")
    if isinstance(declared, str) and 1 <= len(declared) <= 64:
        try:
            return ZoneInfo(declared)
        except (ValueError, ZoneInfoNotFoundError):
            pass
    try:
        configured_timezone = carrier_timezone(carrier_id)
        return timezone.utc if configured_timezone == "UTC" else ZoneInfo(configured_timezone)
    except (LookupError, ValueError, ZoneInfoNotFoundError):
        return timezone.utc


def event_timestamp(
    raw: Any,
    assumed_timezone: tzinfo = timezone.utc,
) -> str | None:
    if isinstance(raw, str) and raw.strip():
        value = raw.strip()
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=assumed_timezone)
            return parsed.astimezone(timezone.utc).isoformat()
        except ValueError:
            for fmt in (
                "%Y-%m-%d %H:%M:%S",
                "%Y-%m-%d %H:%M",
                "%d.%m.%Y %H:%M:%S",
                "%d.%m.%Y %H:%M",
                "%d/%m/%Y %H:%M:%S",
                "%d/%m/%Y %H:%M",
                "%Y-%m-%d",
                "%d.%m.%Y",
                "%d/%m/%Y",
            ):
                try:
                    parsed = datetime.strptime(value, fmt).replace(tzinfo=assumed_timezone)
                    return parsed.astimezone(timezone.utc).isoformat()
                except ValueError:
                    continue
    return None


def provider_event_id(carrier_id: str, raw_time: Any, location: str, description: str) -> str:
    material = json.dumps(
        [carrier_id, str(raw_time or ""), location.strip(), description.strip()],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return f"{carrier_id}:{hashlib.sha256(material.encode()).hexdigest()}"


def build_events(
    package: dict[str, Any],
    result: CarrierResult,
    _now: datetime,
    source_carrier_id: str | None = None,
) -> list[dict[str, Any]]:
    current = result_stage(result) or "in_transit"
    carrier_id = source_carrier_id or str(package.get("carrier") or "")
    assumed_timezone = result_timezone(carrier_id, result)
    rows: list[dict[str, Any]] = []
    for raw in result.get("events") or []:
        description = str(raw.get("description") or "Tracking update").strip()
        location = str(raw.get("location") or "").strip()
        raw_time = raw.get("time")
        occurred_at = event_timestamp(raw_time, assumed_timezone)
        if occurred_at is None:
            continue
        declared_stage = str(raw.get("stage") or "")
        rows.append(
            {
                "package_id": package["id"],
                "stage": (
                    declared_stage
                    if declared_stage in STAGES
                    else infer_stage(description, current)
                ),
                "description": description,
                "location": location or None,
                "occurred_at": occurred_at,
                "provider_event_id": provider_event_id(
                    carrier_id, raw_time, location, description
                ),
                "raw_data": raw,
            }
        )

    if not rows and current and result.get("last_status_text"):
        description = str(result["last_status_text"])
        raw_time = result.get("last_update")
        occurred_at = event_timestamp(raw_time, assumed_timezone)
        if occurred_at is None:
            return rows
        rows.append(
            {
                "package_id": package["id"],
                "stage": current,
                "description": description,
                "location": None,
                "occurred_at": occurred_at,
                "provider_event_id": provider_event_id(
                    carrier_id, raw_time, "", description
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
        if package.get("carrier") not in AUTOMATIC_CARRIER_IDS:
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
            carrier_id = str(package["carrier"])
            result, source_carrier_id, swiss_post_ready = self._fetch_result(
                package, carrier_id
            )
            events = build_events(package, result, now, source_carrier_id)
            self.client.insert_events(events)
            reported_stage = result_stage(result)
            latest_event = (
                max(events, key=lambda event: str(event["occurred_at"])) if events else None
            )
            # Carrier summaries are occasionally missing or lag behind their event
            # history. Keep the denormalized package stage aligned with the newest
            # event because scheduling and automatic archiving rely on this column.
            stage = str(latest_event["stage"]) if latest_event else reported_stage
            has_update = bool(
                (stage and stage != "pending")
                or any(event["stage"] != "pending" for event in events)
            )
            handoff = supports_swiss_post_handoff(str(package["tracking_number"]))
            # Once Swiss Post has accepted the identifier, a temporarily sparse
            # response must not send the parcel back to Cainiao or to "waiting".
            known_update = has_update or bool(handoff and swiss_post_ready)
            carrier_data = {
                key: value
                for key, value in result.items()
                if key not in {"events"} and value is not None
            }
            if handoff:
                carrier_data.update(
                    {
                        "active_tracking_carrier": source_carrier_id,
                        "swiss_post_ready": swiss_post_ready,
                    }
                )
            values: dict[str, Any] = {
                "last_synced_at": now.isoformat(),
                "sync_status": "ok" if known_update else "waiting",
                "sync_error": None,
                "last_status_text": result.get("last_status_text") or None,
                "expected_delivery": str(result["expected_delivery"])
                if result.get("expected_delivery")
                else None,
                "carrier_data": carrier_data,
            }
            if stage and (has_update or not swiss_post_ready):
                values["current_stage"] = stage
            self.client.update_package(package["id"], values)
            return "updated" if known_update else "waiting"
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

    def _fetch_result(
        self,
        package: dict[str, Any],
        carrier_id: str,
    ) -> tuple[CarrierResult, str, bool | None]:
        """Select Cainiao until Swiss Post announces a Swiss-issued tracked letter."""

        tracking_number = str(package["tracking_number"])
        if not supports_swiss_post_handoff(tracking_number):
            result = self.adapter.fetch(
                carrier_id,
                tracking_number,
                package.get("tracking_url"),
                package.get("dpd_postcode"),
            )
            return normalize_carrier_result(result), carrier_id, None

        carrier_data = package.get("carrier_data")
        swiss_post_was_ready = bool(
            isinstance(carrier_data, dict)
            and carrier_data.get("swiss_post_ready") is True
        )
        if swiss_post_was_ready:
            result = self.adapter.fetch("swiss-post", tracking_number, None, None)
            return normalize_carrier_result(result), "swiss-post", True

        try:
            swiss_post_result = normalize_carrier_result(
                self.adapter.fetch("swiss-post", tracking_number, None, None)
            )
            if result_has_update(swiss_post_result):
                return swiss_post_result, "swiss-post", True
        except Exception:
            # Cainiao can still cover the international leg while Swiss Post is
            # unavailable. If Cainiao also fails, its error is persisted below.
            pass

        cainiao_result = self.adapter.fetch("aliexpress", tracking_number, None, None)
        return normalize_carrier_result(cainiao_result), "aliexpress", False


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
