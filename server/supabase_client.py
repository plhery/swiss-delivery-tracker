"""Small service-role Supabase client built on the Python standard library."""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
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

    def list_packages(self) -> list[dict[str, Any]]:
        params = [
            (
                "select",
                "id,tracking_number,label,carrier,created_at,expected_delivery,"
                "last_status_text,last_synced_at,sync_status,sync_error,"
                "tracking_events(id,package_id,stage,description,location,occurred_at)",
            ),
            ("archived_at", "is.null"),
            ("order", "created_at.desc"),
        ]
        query = urllib.parse.urlencode(params, safe="().,*")
        return self._request(f"/rest/v1/packages?{query}") or []

    def get_package(self, package_id: str) -> dict[str, Any] | None:
        params = [
            (
                "select",
                "id,tracking_number,label,carrier,created_at,expected_delivery,"
                "last_status_text,last_synced_at,sync_status,sync_error,"
                "tracking_events(id,package_id,stage,description,location,occurred_at)",
            ),
            ("id", f"eq.{package_id}"),
            ("limit", "1"),
        ]
        query = urllib.parse.urlencode(params, safe="().,*")
        rows = self._request(f"/rest/v1/packages?{query}") or []
        return rows[0] if rows else None

    def create_package(
        self, tracking_number: str, label: str, carrier: str
    ) -> dict[str, Any]:
        rows = self._request(
            "/rest/v1/packages",
            method="POST",
            body={
                "user_id": None,
                "tracking_number": tracking_number,
                "label": label,
                "carrier": carrier,
            },
            prefer="return=representation",
        ) or []
        if not rows:
            raise SupabaseError("Supabase did not return the new package")
        package = self.get_package(str(rows[0]["id"]))
        if not package:
            raise SupabaseError("The new package could not be reloaded")
        return package

    def delete_package(self, package_id: str) -> None:
        query = urllib.parse.urlencode({"id": f"eq.{package_id}"})
        self._request(
            f"/rest/v1/packages?{query}",
            method="DELETE",
            prefer="return=minimal",
        )

    def list_active_packages(self) -> list[dict[str, Any]]:
        params: list[tuple[str, str]] = [
            (
                "select",
                "id,user_id,tracking_number,label,carrier,current_stage,tracking_url,last_synced_at",
            ),
            ("archived_at", "is.null"),
            ("current_stage", "not.in.(delivered,returned)"),
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
