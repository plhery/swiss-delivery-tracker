"""Small service-role Supabase client built on the Python standard library."""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


class SupabaseError(RuntimeError):
    pass


class SupabaseServiceClient:
    def __init__(self, url: str, anon_key: str, service_role_key: str, timeout: int = 20):
        self.url = url.rstrip("/")
        self.anon_key = anon_key
        self.service_role_key = service_role_key
        self.timeout = timeout

    def _request(
        self,
        path: str,
        *,
        method: str = "GET",
        body: Any = None,
        token: str | None = None,
        prefer: str | None = None,
    ) -> Any:
        headers = {
            "Accept": "application/json",
            "apikey": self.service_role_key,
            "Authorization": f"Bearer {token or self.service_role_key}",
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
            raise SupabaseError(f"Supabase {method} {path} failed ({exc.code}): {message}") from exc
        except urllib.error.URLError as exc:
            raise SupabaseError(f"Supabase is unreachable: {exc.reason}") from exc

    def auth_user(self, access_token: str) -> dict[str, Any]:
        request = urllib.request.Request(
            f"{self.url}/auth/v1/user",
            headers={
                "Accept": "application/json",
                "apikey": self.anon_key,
                "Authorization": f"Bearer {access_token}",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as exc:
            exc.read()
            raise SupabaseError("The delivery session is invalid or expired") from exc

    def list_active_packages(self, user_id: str | None = None) -> list[dict[str, Any]]:
        params: list[tuple[str, str]] = [
            (
                "select",
                "id,user_id,tracking_number,label,carrier,current_stage,tracking_url,last_synced_at",
            ),
            ("archived_at", "is.null"),
            ("current_stage", "not.in.(delivered,returned)"),
            ("order", "created_at.asc"),
        ]
        if user_id:
            params.append(("user_id", f"eq.{user_id}"))
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
