"""Small Supabase PostgREST clients built on the Python standard library."""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any

from .carriers import AUTOMATIC_CARRIER_IDS


class SupabaseError(RuntimeError):
    def __init__(
        self,
        message: str,
        status: int | None = None,
        code: str | None = None,
    ):
        super().__init__(message)
        self.status = status
        self.code = code


class SupabaseClient:
    def __init__(
        self,
        url: str,
        api_key: str,
        *,
        access_token: str | None = None,
        timeout: int = 20,
    ):
        self.url = url.rstrip("/")
        self.api_key = api_key
        self.access_token = access_token or api_key
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
            "apikey": self.api_key,
            "Authorization": f"Bearer {self.access_token}",
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
                error = json.loads(payload)
                if isinstance(error, dict):
                    message = error.get("message") or payload
                    code = (
                        error.get("code")
                        if isinstance(error.get("code"), str)
                        else None
                    )
                else:
                    message = payload
                    code = None
            except json.JSONDecodeError:
                message = payload
                code = None
            raise SupabaseError(
                f"Supabase {method} {path} failed ({exc.code}): {message}",
                status=exc.code,
                code=code,
            ) from exc
        except urllib.error.URLError as exc:
            raise SupabaseError(f"Supabase is unreachable: {exc.reason}") from exc

    def list_packages(self, include_archived: bool = False) -> list[dict[str, Any]]:
        params = [
            (
                "select",
                "id,tracking_number,label,carrier,created_at,expected_delivery,"
                "last_status_text,last_synced_at,sync_status,sync_error,tracking_url,"
                "dpd_postcode,carrier_data,archived_at,notifications_muted,"
                "tracking_events(id,package_id,stage,description,location,occurred_at)",
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
                "dpd_postcode,carrier_data,archived_at,notifications_muted,"
                "tracking_events(id,package_id,stage,description,location,occurred_at)",
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
        dpd_postcode: str | None = None,
    ) -> dict[str, Any]:
        body = {
            "tracking_number": tracking_number,
            "label": label,
            "carrier": carrier,
        }
        if tracking_url:
            body["tracking_url"] = tracking_url
        if dpd_postcode:
            body["dpd_postcode"] = dpd_postcode
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

    def delete_archived_package(self, package_id: str) -> bool:
        query = urllib.parse.urlencode(
            {"id": f"eq.{package_id}", "archived_at": "not.is.null"}
        )
        rows = self._request(
            f"/rest/v1/packages?{query}",
            method="DELETE",
            prefer="return=representation",
        ) or []
        return len(rows) == 1

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
                "id,user_id,tracking_number,label,carrier,current_stage,tracking_url,"
                "dpd_postcode,last_synced_at,carrier_data",
            ),
            ("archived_at", "is.null"),
            (
                "or",
                "(current_stage.not.in.(delivered,returned),"
                "last_status_text.eq.TO_BE_DELIVERED)",
            ),
            ("carrier", f"in.({','.join(sorted(AUTOMATIC_CARRIER_IDS))})"),
            ("order", "last_synced_at.asc.nullsfirst,created_at.asc"),
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
            prefer="resolution=merge-duplicates,return=minimal",
        )

    def upsert_push_subscription(
        self,
        user_id: str,
        endpoint: str,
        p256dh: str,
        auth: str,
        user_agent: str | None,
    ) -> dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        query = urllib.parse.urlencode({"on_conflict": "endpoint"})
        rows = self._request(
            f"/rest/v1/push_subscriptions?{query}",
            method="POST",
            body={
                "user_id": user_id,
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

    def delete_push_subscription(self, user_id: str, endpoint: str) -> None:
        query = urllib.parse.urlencode(
            {"user_id": f"eq.{user_id}", "endpoint": f"eq.{endpoint}"}
        )
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

    def delete_auth_user(self, user_id: str) -> None:
        encoded_user_id = urllib.parse.quote(user_id, safe="")
        self._request(
            f"/auth/v1/admin/users/{encoded_user_id}",
            method="DELETE",
        )


class SupabaseServiceClient(SupabaseClient):
    """PostgREST client whose service-role token bypasses row-level security."""

    def __init__(self, url: str, service_role_key: str, timeout: int = 20):
        super().__init__(url, service_role_key, timeout=timeout)


class SupabaseUserClient(SupabaseClient):
    """PostgREST client scoped by a signed-in user's access token and RLS."""

    def __init__(
        self,
        url: str,
        publishable_key: str,
        access_token: str,
        timeout: int = 20,
    ):
        super().__init__(
            url,
            publishable_key,
            access_token=access_token,
            timeout=timeout,
        )

    def create_package(
        self,
        tracking_number: str,
        label: str,
        carrier: str,
        tracking_url: str | None = None,
        dpd_postcode: str | None = None,
    ) -> dict[str, Any]:
        row = self._request(
            "/rest/v1/rpc/create_owned_package",
            method="POST",
            body={
                "p_tracking_number": tracking_number,
                "p_label": label,
                "p_carrier": carrier,
                "p_tracking_url": tracking_url,
                "p_dpd_postcode": dpd_postcode,
            },
        )
        if isinstance(row, list) and len(row) == 1:
            row = row[0]
        if not isinstance(row, dict) or not row.get("id"):
            raise SupabaseError("Supabase did not return the new package")
        package = self.get_package(str(row["id"]))
        if not package:
            raise SupabaseError("The new package could not be reloaded")
        return package

    def update_package(self, package_id: str, values: dict[str, Any]) -> None:
        if set(values) == {"label"} and isinstance(values["label"], str):
            changed = self._request(
                "/rest/v1/rpc/rename_owned_package",
                method="POST",
                body={"p_package_id": package_id, "p_label": values["label"]},
            )
        elif set(values) == {"archived_at"}:
            changed = self._request(
                "/rest/v1/rpc/set_owned_package_archived",
                method="POST",
                body={
                    "p_package_id": package_id,
                    "p_archived": values["archived_at"] is not None,
                },
            )
        elif set(values) == {"notifications_muted"} and isinstance(
            values["notifications_muted"], bool
        ):
            changed = self._request(
                "/rest/v1/rpc/set_owned_package_notifications_muted",
                method="POST",
                body={
                    "p_package_id": package_id,
                    "p_muted": values["notifications_muted"],
                },
            )
        else:
            raise ValueError("User-scoped package updates must use an approved mutation")
        if changed is not True:
            raise SupabaseError("Package not found", status=404)

    def delete_archived_package(self, package_id: str) -> bool:
        deleted = self._request(
            "/rest/v1/rpc/delete_owned_archived_package",
            method="POST",
            body={"p_package_id": package_id},
        )
        return deleted is True

    def get_notification_preferences(self) -> dict[str, Any]:
        query = urllib.parse.urlencode(
            {
                "select": "enabled_stages,quiet_hours_start,quiet_hours_end,timezone",
                "limit": "1",
            },
            safe=",",
        )
        rows = self._request(f"/rest/v1/notification_preferences?{query}") or []
        if rows and isinstance(rows[0], dict):
            return rows[0]
        return {
            "enabled_stages": [
                "registered",
                "accepted",
                "in_transit",
                "customs",
                "out_for_delivery",
                "failed_attempt",
                "ready_for_pickup",
                "delivered",
                "returned",
            ],
            "quiet_hours_start": None,
            "quiet_hours_end": None,
            "timezone": "Europe/Zurich",
        }

    def set_notification_preferences(
        self,
        enabled_stages: list[str],
        quiet_hours_start: str | None,
        quiet_hours_end: str | None,
        timezone_name: str,
    ) -> dict[str, Any]:
        row = self._request(
            "/rest/v1/rpc/set_owned_notification_preferences",
            method="POST",
            body={
                "p_enabled_stages": enabled_stages,
                "p_quiet_hours_start": quiet_hours_start,
                "p_quiet_hours_end": quiet_hours_end,
                "p_timezone": timezone_name,
            },
        )
        if isinstance(row, list) and len(row) == 1:
            row = row[0]
        if not isinstance(row, dict):
            raise SupabaseError("Supabase did not return notification preferences")
        return row
