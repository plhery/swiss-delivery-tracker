"""Durable Web Push notifications for newly discovered tracking events."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

from pywebpush import webpush

from .supabase_client import SupabaseServiceClient


STAGE_LABELS = {
    "registered": "Shipment announced",
    "accepted": "Parcel accepted",
    "in_transit": "Parcel in transit",
    "customs": "At customs",
    "out_for_delivery": "Out for delivery",
    "ready_for_pickup": "Ready for pickup",
    "delivered": "Delivered",
    "failed_attempt": "Delivery attempt failed",
    "returned": "Returning to sender",
}


@dataclass
class PushSummary:
    attempted: int = 0
    sent: int = 0
    failed: int = 0
    expired: int = 0


class PushNotificationService:
    def __init__(
        self,
        client: SupabaseServiceClient,
        public_key: str,
        private_key: str,
        subject: str,
        sender: Callable[..., Any] = webpush,
    ) -> None:
        self.client = client
        self.public_key = public_key
        self.private_key = private_key
        self.subject = subject
        self.sender = sender

    def dispatch(self) -> PushSummary:
        grouped: dict[tuple[str, str], list[dict[str, Any]]] = {}
        for row in self.client.list_pending_push_notifications():
            key = (str(row["subscription_id"]), str(row["package_id"]))
            grouped.setdefault(key, []).append(row)

        summary = PushSummary()
        for (subscription_id, _package_id), events in grouped.items():
            summary.attempted += 1
            newest = max(events, key=lambda event: str(event.get("event_created_at") or ""))
            try:
                self._send(newest)
                self.client.record_push_deliveries(
                    subscription_id, [str(event["event_id"]) for event in events]
                )
                self.client.update_push_subscription(
                    subscription_id,
                    {
                        "last_success_at": datetime.now(timezone.utc).isoformat(),
                        "last_error": None,
                    },
                )
                summary.sent += 1
            except Exception as exc:  # one device must never stop sync for the others
                status = self._status_code(exc)
                if status in {404, 410}:
                    self.client.update_push_subscription(
                        subscription_id,
                        {
                            "disabled_at": datetime.now(timezone.utc).isoformat(),
                            "last_error": "Push endpoint expired",
                        },
                    )
                    summary.expired += 1
                else:
                    self.client.update_push_subscription(
                        subscription_id, {"last_error": "Push delivery failed"}
                    )
                    summary.failed += 1
        return summary

    def send_test(self, subscription: dict[str, Any]) -> None:
        self._send(
            subscription,
            {
                "title": "Notifications are on",
                "body": "Parcel Post will alert this device when tracking changes.",
                "tag": "parcel-post-ready",
                "data": {"url": "/"},
            },
        )

    def _send(
        self, row: dict[str, Any], payload: dict[str, Any] | None = None
    ) -> None:
        self.sender(
            subscription_info={
                "endpoint": row["endpoint"],
                "keys": {"p256dh": row["p256dh"], "auth": row["auth"]},
            },
            data=json.dumps(payload or self._payload(row), ensure_ascii=False),
            vapid_private_key=self.private_key,
            vapid_claims={"sub": self.subject},
            ttl=86_400,
            timeout=15,
        )

    @staticmethod
    def _payload(row: dict[str, Any]) -> dict[str, Any]:
        stage = STAGE_LABELS.get(str(row.get("stage")), "Tracking update")
        location = str(row.get("location") or "").strip()
        return {
            "title": str(row.get("label") or "Parcel update"),
            "body": f"{stage} · {location}" if location else stage,
            "icon": "/icons/icon-192.png",
            "badge": "/icons/icon-192.png",
            "tag": f"parcel-{row['package_id']}",
            "data": {"url": f"/?parcel={row['package_id']}"},
        }

    @staticmethod
    def _status_code(exc: Exception) -> int | None:
        response = getattr(exc, "response", None)
        return getattr(response, "status_code", None) or getattr(exc, "status_code", None)
