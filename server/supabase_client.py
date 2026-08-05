"""Small service-role Supabase client built on the Python standard library."""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any


class SupabaseError(RuntimeError):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class SupabaseServiceClient:
    def __init__(self, url: str, service_role_key: str, timeout: int = 20):
        self.url = url.rstrip("/")
        self.service_role_key = service_role_key
        self.timeout = timeout

    def _request(
        self,
        path: str,
        *,
        method: str = "GET",
        body: Any = None,
        prefer: str | None = None,
    ) -> Any:
        headers = {
            "Accept": "application/json",
            "apikey": self.service_role_key,
            "Authorization": f"Bearer {self.service_role_key}",
        }
        data = None
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if prefer:
            headers["Prefer"] = prefer

        request = urllib.request.Request(
            f"{self.url}{path}", data=data, headers=headers, method=method
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = response.read()
                return json.loads(payload) if payload else None
        except urllib.error.HTTPError as exc:
            payload = exc.read().decode("utf-8", errors="replace")
            try:
                message = json.loads(payload).get("message") or payload
            except json.JSONDecodeError:
                message = payload
            raise SupabaseError(
                f"Supabase {method} {path} failed ({exc.code}): {message}",
                status=exc.code,
            ) from exc
        except urllib.error.URLError as exc:
            raise SupabaseError(f"Supabase is unreachable: {exc.reason}") from exc

    def list_packages(self, include_archived: bool = False) -> list[dict[str, Any]]:
        params = [
            (
                "select",
                "id,tracking_number,label,carrier,created_at,expected_delivery,"
                "last_status_text,last_synced_at,sync_status,sync_error,tracking_url,"
                "archived_at,tracking_events(id,package_id,stage,description,location,occurred_at)",
            ),
            ("order", "created_at.desc"),
        ]
        if not include_archived:
            params.append(("archived_at", "is.null"))
        query = urllib.parse.urlencode(params, safe="().,*")
        return self._request(f"/rest/v1/packages?{query}") or []

    def get_package(self, package_id: str) -> dict[str, Any] | None:
        params = [
            (
                "select",
                "id,tracking_number,label,carrier,created_at,expected_delivery,"
                "last_status_text,last_synced_at,sync_status,sync_error,tracking_url,"
                "archived_at,tracking_events(id,package_id,stage,description,location,occurred_at)",
            ),
            ("id", f"eq.{package_id}"),
            ("limit", "1"),
        ]
        query = urllib.parse.urlencode(params, safe="().,*")
        rows = self._request(f"/rest/v1/packages?{query}") or []
        return rows[0] if rows else None

    def create_package(
        self,
        tracking_number: str,
        label: str,
        carrier: str,
        tracking_url: str | None = None,
    ) -> dict[str, Any]:
        body = {
            "user_id": None,
            "tracking_number": tracking_number,
            "label": label,
            "carrier": carrier,
        }
        if tracking_url:
            body["tracking_url"] = tracking_url
        rows = self._request(
            "/rest/v1/packages",
            method="POST",
            body=body,
            prefer="return=representation",
        ) or []
        if not rows:
            raise SupabaseError("Supabase did not return the new package")
        package = self.get_package(str(rows[0]["id"]))
        if not package:
            raise SupabaseError("The new package could not be reloaded")
        return package

    def archive_package(self, package_id: str) -> None:
        self.update_package(
            package_id,
            {"archived_at": datetime.now(timezone.utc).isoformat()},
        )

    def restore_package(self, package_id: str) -> None:
        self.update_package(package_id, {"archived_at": None})

    def archive_delivered_before(self, cutoff: datetime) -> int:
        if cutoff.tzinfo is None:
            raise ValueError("Archive cutoff must include a timezone")
        params = [
            ("archived_at", "is.null"),
            ("current_stage", "eq.delivered"),
            ("last_synced_at", f"lt.{cutoff.astimezone(timezone.utc).isoformat()}"),
        ]
        query = urllib.parse.urlencode(params)
        rows = self._request(
            f"/rest/v1/packages?{query}",
            method="PATCH",
            body={"archived_at": datetime.now(timezone.utc).isoformat()},
            prefer="return=representation",
        ) or []
        return len(rows)

    def list_active_packages(self) -> list[dict[str, Any]]:
        params: list[tuple[str, str]] = [
            (
                "select",
                "id,user_id,tracking_number,label,carrier,current_stage,tracking_url,last_synced_at",
            ),
            ("archived_at", "is.null"),
            ("current_stage", "not.in.(delivered,returned)"),
            ("sync_status", "neq.unsupported"),
            ("order", "created_at.asc"),
        ]
        query = urllib.parse.urlencode(params, safe="().,*")
        return self._request(f"/rest/v1/packages?{query}") or []

    def update_package(self, package_id: str, values: dict[str, Any]) -> None:
        query = urllib.parse.urlencode({"id": f"eq.{package_id}"})
        self._request(
            f"/rest/v1/packages?{query}",
            method="PATCH",
            body=values,
            prefer="return=minimal",
        )

    def insert_events(self, events: list[dict[str, Any]]) -> None:
        if not events:
            return
        query = urllib.parse.urlencode(
            {"on_conflict": "package_id,provider_event_id"}, safe=","
        )
        self._request(
            f"/rest/v1/tracking_events?{query}",
            method="POST",
            body=events,
            prefer="resolution=ignore-duplicates,return=minimal",
        )

    def upsert_push_subscription(
        self, endpoint: str, p256dh: str, auth: str, user_agent: str | None
    ) -> dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        query = urllib.parse.urlencode({"on_conflict": "endpoint"})
        rows = self._request(
            f"/rest/v1/push_subscriptions?{query}",
            method="POST",
            body={
                "endpoint": endpoint,
                "p256dh": p256dh,
                "auth": auth,
                "user_agent": user_agent,
                "subscribed_at": now,
                "disabled_at": None,
                "last_error": None,
                "updated_at": now,
            },
            prefer="resolution=merge-duplicates,return=representation",
        ) or []
        if not rows:
            raise SupabaseError("Supabase did not return the push subscription")
        row = rows[0]
        if not isinstance(row, dict):
            raise SupabaseError("Supabase returned an invalid push subscription")
        return row

    def delete_push_subscription(self, endpoint: str) -> None:
        query = urllib.parse.urlencode({"endpoint": f"eq.{endpoint}"})
        self._request(
            f"/rest/v1/push_subscriptions?{query}",
            method="DELETE",
            prefer="return=minimal",
        )

    def list_pending_push_notifications(self) -> list[dict[str, Any]]:
        query = urllib.parse.urlencode(
            {
                "select": "*",
                "order": "event_created_at.asc",
                "limit": "1000",
            },
            safe="*,.",
        )
        return self._request(f"/rest/v1/pending_push_notifications?{query}") or []

    def record_push_deliveries(self, subscription_id: str, event_ids: list[str]) -> None:
        if not event_ids:
            return
        query = urllib.parse.urlencode(
            {"on_conflict": "subscription_id,event_id"}, safe=","
        )
        self._request(
            f"/rest/v1/push_deliveries?{query}",
            method="POST",
            body=[
                {"subscription_id": subscription_id, "event_id": event_id}
                for event_id in event_ids
            ],
            prefer="resolution=ignore-duplicates,return=minimal",
        )

    def update_push_subscription(
        self, subscription_id: str, values: dict[str, Any]
    ) -> None:
        query = urllib.parse.urlencode({"id": f"eq.{subscription_id}"})
        self._request(
            f"/rest/v1/push_subscriptions?{query}",
            method="PATCH",
            body={**values, "updated_at": datetime.now(timezone.utc).isoformat()},
            prefer="return=minimal",
        )
