"""Validate Cloudflare Access application tokens at the origin."""

from __future__ import annotations

from typing import Protocol

import jwt
from jwt import PyJWK, PyJWKClient
from jwt.exceptions import PyJWTError


class AccessValidationError(ValueError):
    """Raised when a request has no valid Cloudflare Access application token."""


class JwkClient(Protocol):
    def get_signing_key_from_jwt(self, token: str) -> PyJWK: ...


class CloudflareAccessValidator:
    """Verify Access JWT signatures and application-specific claims."""

    def __init__(
        self,
        team_domain: str,
        audience: str,
        *,
        jwk_client: JwkClient | None = None,
    ) -> None:
        domain = team_domain.strip().rstrip("/")
        if not domain.startswith("https://"):
            domain = f"https://{domain}"
        if not audience.strip():
            raise ValueError("Cloudflare Access audience cannot be empty")
        self.team_domain = domain
        self.audience = audience.strip()
        self.jwk_client = jwk_client or PyJWKClient(
            f"{self.team_domain}/cdn-cgi/access/certs",
            cache_keys=True,
        )

    def validate(self, token: str | None) -> dict[str, object]:
        if not token:
            raise AccessValidationError("Cloudflare Access token is missing")
        try:
            signing_key = self.jwk_client.get_signing_key_from_jwt(token)
            claims = jwt.decode(
                token,
                signing_key.key,
                algorithms=["RS256"],
                audience=self.audience,
                issuer=self.team_domain,
            )
        except (PyJWTError, OSError, ValueError) as exc:
            raise AccessValidationError("Cloudflare Access token is invalid") from exc
        if claims.get("type") != "app":
            raise AccessValidationError("Cloudflare Access token is not an application token")
        return claims
