"""Validate Supabase access tokens and create row-level-security clients."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable
from uuid import UUID

from .supabase_client import SupabaseUserClient


class SupabaseAuthError(ValueError):
    """Raised when a request has no valid Supabase user session."""


@dataclass(frozen=True)
class SupabaseUser:
    id: str
    email: str | None
    authenticated_at: datetime | None = None
    session_id: str | None = None


INTERACTIVE_AUTH_METHODS = frozenset(
    {"magiclink", "oauth", "otp", "password", "sso/saml", "totp"}
)


class SupabaseAuthenticator:
    """Ask Supabase Auth to validate bearer tokens, with a short local cache."""

    def __init__(
        self,
        url: str,
        publishable_key: str,
        *,
        timeout: int = 5,
        cache_seconds: float = 60,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not url.strip() or not publishable_key.strip():
            raise ValueError("Supabase Auth requires a URL and publishable key")
        self.url = url.rstrip("/")
        self.publishable_key = publishable_key.strip()
        self.timeout = timeout
        self.cache_seconds = max(0, cache_seconds)
        self.clock = clock
        self._cache: dict[str, tuple[float, SupabaseUser]] = {}
        self._lock = threading.Lock()

    def validate(
        self,
        token: str | None,
        *,
        use_cache: bool = True,
    ) -> SupabaseUser:
        if not token or len(token) > 16_384:
            raise SupabaseAuthError("Supabase access token is missing or invalid")
        fingerprint = hashlib.sha256(token.encode("utf-8")).hexdigest()
        now = self.clock()
        if use_cache:
            with self._lock:
                cached = self._cache.get(fingerprint)
                if cached and cached[0] > now:
                    return cached[1]

        request = urllib.request.Request(
            f"{self.url}/auth/v1/user",
            headers={
                "Accept": "application/json",
                "apikey": self.publishable_key,
                "Authorization": f"Bearer {token}",
            },
            method="GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = json.loads(response.read())
        except (
            json.JSONDecodeError,
            OSError,
            TypeError,
            urllib.error.HTTPError,
            urllib.error.URLError,
        ) as exc:
            raise SupabaseAuthError("Supabase access token is invalid") from exc

        try:
            user_id = str(UUID(payload["id"]))
        except (KeyError, TypeError, ValueError) as exc:
            raise SupabaseAuthError("Supabase returned an invalid user") from exc
        if payload.get("is_anonymous") is True:
            raise SupabaseAuthError("Anonymous Supabase users are not accepted")
        email = payload.get("email")
        authenticated_at, session_id = self._session_claims(token, user_id)
        user = SupabaseUser(
            user_id,
            email if isinstance(email, str) else None,
            authenticated_at,
            session_id,
        )
        with self._lock:
            if len(self._cache) >= 256:
                self._cache = {
                    key: value for key, value in self._cache.items() if value[0] > now
                }
                if len(self._cache) >= 256:
                    self._cache.pop(next(iter(self._cache)))
            self._cache[fingerprint] = (now + self.cache_seconds, user)
        return user

    @staticmethod
    def _session_claims(token: str, user_id: str) -> tuple[datetime | None, str | None]:
        """Read session-bound claims after Supabase Auth has validated the JWT."""
        parts = token.split(".")
        if len(parts) != 3:
            return None, None
        try:
            encoded = parts[1].encode("ascii")
            padding = b"=" * ((4 - len(encoded) % 4) % 4)
            claims = json.loads(
                base64.b64decode(encoded + padding, altchars=b"-_", validate=True)
            )
        except (UnicodeEncodeError, UnicodeDecodeError, binascii.Error, json.JSONDecodeError):
            return None, None
        if not isinstance(claims, dict) or claims.get("sub") != user_id:
            return None, None

        raw_session_id = claims.get("session_id")
        try:
            session_id = str(UUID(raw_session_id))
        except (TypeError, ValueError):
            session_id = None

        authenticated_at = None
        methods = claims.get("amr")
        if isinstance(methods, list):
            timestamps: list[datetime] = []
            for method in methods:
                if not isinstance(method, dict) or method.get("method") not in INTERACTIVE_AUTH_METHODS:
                    continue
                timestamp = method.get("timestamp")
                if isinstance(timestamp, bool) or not isinstance(timestamp, (int, float)):
                    continue
                try:
                    timestamps.append(datetime.fromtimestamp(timestamp, timezone.utc))
                except (OverflowError, OSError, ValueError):
                    continue
            authenticated_at = max(timestamps, default=None)
        return authenticated_at, session_id

    def user_client(self, token: str) -> SupabaseUserClient:
        return SupabaseUserClient(self.url, self.publishable_key, token)
