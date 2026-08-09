"""Durable Web Push and APNs delivery for newly discovered tracking events."""

from __future__ import annotations

import base64
import json
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

import httpx
import requests
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from pywebpush import webpush

from .supabase_client import SupabaseServiceClient

STAGE_LABELS = {
    "pending": "Not announced yet",
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

NATIVE_COPY = {
    "en": {
        "test_title": "Notifications are on",
        "test_body": "Swiss Delivery Tracker will alert this iPhone when tracking changes.",
        "update": "Parcel update",
        **STAGE_LABELS,
    },
    "de": {
        "test_title": "Benachrichtigungen sind aktiv",
        "test_body": "Swiss Delivery Tracker meldet Änderungen an Sendungen auf diesem iPhone.",
        "update": "Paketaktualisierung",
        "pending": "Noch nicht angekündigt",
        "registered": "Sendung angekündigt",
        "accepted": "Paket angenommen",
        "in_transit": "Paket unterwegs",
        "customs": "Beim Zoll",
        "out_for_delivery": "In Zustellung",
        "ready_for_pickup": "Abholbereit",
        "delivered": "Zugestellt",
        "failed_attempt": "Zustellversuch fehlgeschlagen",
        "returned": "Rücksendung an Absender",
    },
    "fr": {
        "test_title": "Les notifications sont activées",
        "test_body": "Swiss Delivery Tracker signalera les changements de suivi sur cet iPhone.",
        "update": "Mise à jour du colis",
        "pending": "Pas encore annoncé",
        "registered": "Envoi annoncé",
        "accepted": "Colis accepté",
        "in_transit": "Colis en transit",
        "customs": "À la douane",
        "out_for_delivery": "En cours de livraison",
        "ready_for_pickup": "Prêt à être retiré",
        "delivered": "Livré",
        "failed_attempt": "Échec de la tentative de livraison",
        "returned": "Retour à l’expéditeur",
    },
    "it": {
        "test_title": "Le notifiche sono attive",
        "test_body": "Swiss Delivery Tracker segnalerà le modifiche di tracciamento su questo iPhone.",
        "update": "Aggiornamento del pacco",
        "pending": "Non ancora annunciato",
        "registered": "Spedizione annunciata",
        "accepted": "Pacco accettato",
        "in_transit": "Pacco in transito",
        "customs": "Alla dogana",
        "out_for_delivery": "In consegna",
        "ready_for_pickup": "Pronto per il ritiro",
        "delivered": "Consegnato",
        "failed_attempt": "Tentativo di consegna non riuscito",
        "returned": "Restituzione al mittente",
    },
}


def notification_text(value: object, limit: int) -> str:
    """Collapse untrusted carrier whitespace and keep push payloads bounded."""

    cleaned = " ".join(str(value or "").split())
    if len(cleaned) <= limit:
        return cleaned
    return f"{cleaned[: limit - 1].rstrip()}…"


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
                "body": "Swiss Delivery Tracker will alert this device when tracking changes.",
                "tag": "parcel-post-ready",
                "data": {"url": "/"},
            },
        )

    def _send(
        self, row: dict[str, Any], payload: dict[str, Any] | None = None
    ) -> None:
        with requests.Session() as session:
            # A push service never needs to redirect delivery to another origin.
            # Refusing redirects prevents a permitted public endpoint from being
            # used as a trampoline into an internal HTTP service.
            session.max_redirects = 0
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
                requests_session=session,
            )

    @staticmethod
    def _payload(row: dict[str, Any]) -> dict[str, Any]:
        stage = STAGE_LABELS.get(str(row.get("stage")), "Tracking update")
        location = notification_text(row.get("location"), 140)
        return {
            "title": notification_text(row.get("label") or "Parcel update", 80),
            "body": notification_text(
                f"{stage} · {location}" if location else stage, 220
            ),
            "icon": "/icons/icon-192.png",
            "badge": "/icons/icon-192.png",
            "tag": f"parcel-{row['package_id']}",
            "data": {"url": f"/?parcel={row['package_id']}"},
        }

    @staticmethod
    def _status_code(exc: Exception) -> int | None:
        response = getattr(exc, "response", None)
        return getattr(response, "status_code", None) or getattr(exc, "status_code", None)


class APNsError(RuntimeError):
    def __init__(self, status_code: int, reason: str = "") -> None:
        super().__init__(reason or f"APNs returned HTTP {status_code}")
        self.status_code = status_code
        self.reason = reason


class NativePushNotificationService:
    """Send account-owned notification rows through Apple's HTTP/2 provider API."""

    _EXPIRED_REASONS = frozenset({"BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"})

    def __init__(
        self,
        client: SupabaseServiceClient,
        team_id: str,
        key_id: str,
        private_key: str,
        bundle_id: str,
        sender: Callable[..., Any] | None = None,
        now: Callable[[], float] = time.time,
    ) -> None:
        self.client = client
        self.team_id = team_id
        self.key_id = key_id
        self.bundle_id = bundle_id
        self._http_client: httpx.Client | None = None
        if sender is not None:
            self.sender = sender
        else:
            self._http_client = httpx.Client(
                http2=True, follow_redirects=False, timeout=15
            )
            self.sender = self._http_client.post
        self.now = now
        normalized_key = private_key.replace("\\n", "\n").strip().encode()
        loaded_key = serialization.load_pem_private_key(normalized_key, password=None)
        if not isinstance(loaded_key, ec.EllipticCurvePrivateKey) or not isinstance(
            loaded_key.curve, ec.SECP256R1
        ):
            raise ValueError("APNS_PRIVATE_KEY must be a P-256 private key")
        self._private_key = loaded_key
        self._cached_token: tuple[str, int] | None = None
        self._token_lock = threading.Lock()

    def dispatch(self) -> PushSummary:
        grouped: dict[tuple[str, str], list[dict[str, Any]]] = {}
        for row in self.client.list_pending_native_push_notifications():
            key = (str(row["device_id"]), str(row["package_id"]))
            grouped.setdefault(key, []).append(row)

        summary = PushSummary()
        for (device_id, _package_id), events in grouped.items():
            summary.attempted += 1
            newest = max(events, key=lambda event: str(event.get("event_created_at") or ""))
            try:
                self._send(newest)
                self.client.record_native_push_deliveries(
                    device_id, [str(event["event_id"]) for event in events]
                )
                self.client.update_native_push_device(
                    device_id,
                    {
                        "last_success_at": datetime.now(timezone.utc).isoformat(),
                        "last_error": None,
                    },
                )
                summary.sent += 1
            except Exception as exc:  # one iPhone must never stop the other devices
                if self._is_expired(exc):
                    self.client.update_native_push_device(
                        device_id,
                        {
                            "disabled_at": datetime.now(timezone.utc).isoformat(),
                            "last_error": "APNs device token expired",
                        },
                    )
                    summary.expired += 1
                else:
                    self.client.update_native_push_device(
                        device_id, {"last_error": "APNs delivery failed"}
                    )
                    summary.failed += 1
        return summary

    def send_test(self, device: dict[str, Any]) -> None:
        copy = self._copy(device)
        self._send(
            device,
            self._payload(
                title=copy["test_title"],
                body=copy["test_body"],
                parcel_id=None,
            ),
        )

    def _send(
        self, row: dict[str, Any], payload: dict[str, Any] | None = None
    ) -> None:
        environment = str(row.get("environment") or "production")
        host = (
            "api.sandbox.push.apple.com"
            if environment == "development"
            else "api.push.apple.com"
        )
        package_id = str(row.get("package_id") or "")
        headers = {
            "authorization": f"bearer {self._provider_token()}",
            "apns-topic": self.bundle_id,
            "apns-push-type": "alert",
            "apns-priority": "10",
            "apns-expiration": str(int(self.now()) + 86_400),
        }
        if package_id:
            headers["apns-collapse-id"] = package_id[:64]
        response = self.sender(
            f"https://{host}/3/device/{row['token']}",
            headers=headers,
            json=payload or self._event_payload(row),
            timeout=15,
        )
        status_code = int(getattr(response, "status_code", 0))
        if status_code == 200:
            return
        reason = ""
        try:
            response_payload = response.json()
            if isinstance(response_payload, dict):
                reason = str(response_payload.get("reason") or "")
        except (ValueError, TypeError):
            pass
        raise APNsError(status_code, reason)

    def _event_payload(self, row: dict[str, Any]) -> dict[str, Any]:
        copy = self._copy(row)
        stage = copy.get(str(row.get("stage")), copy["update"])
        location = notification_text(row.get("location"), 140)
        body = notification_text(
            f"{stage} · {location}" if location else stage, 220
        )
        return self._payload(
            title=notification_text(row.get("label") or copy["update"], 80),
            body=body,
            parcel_id=str(row["package_id"]),
        )

    @staticmethod
    def _payload(title: str, body: str, parcel_id: str | None) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "aps": {
                "alert": {"title": title, "body": body},
                "sound": "default",
                "badge": 1,
            }
        }
        if parcel_id:
            payload["aps"]["thread-id"] = parcel_id
            payload["parcel_id"] = parcel_id
        return payload

    @staticmethod
    def _copy(row: dict[str, Any]) -> dict[str, str]:
        locale = str(row.get("locale") or "en").split("-", 1)[0].casefold()
        return NATIVE_COPY.get(locale, NATIVE_COPY["en"])

    def _provider_token(self) -> str:
        issued_at = int(self.now())
        with self._token_lock:
            if self._cached_token and issued_at - self._cached_token[1] < 50 * 60:
                return self._cached_token[0]
            header = self._base64url(
                json.dumps(
                    {"alg": "ES256", "kid": self.key_id}, separators=(",", ":")
                ).encode()
            )
            claims = self._base64url(
                json.dumps(
                    {"iss": self.team_id, "iat": issued_at}, separators=(",", ":")
                ).encode()
            )
            signing_input = f"{header}.{claims}".encode()
            der_signature = self._private_key.sign(
                signing_input, ec.ECDSA(hashes.SHA256())
            )
            r, s = decode_dss_signature(der_signature)
            signature = self._base64url(r.to_bytes(32, "big") + s.to_bytes(32, "big"))
            token = f"{header}.{claims}.{signature}"
            self._cached_token = (token, issued_at)
            return token

    @staticmethod
    def _base64url(value: bytes) -> str:
        return base64.urlsafe_b64encode(value).rstrip(b"=").decode()

    @classmethod
    def _is_expired(cls, exc: Exception) -> bool:
        return isinstance(exc, APNsError) and (
            exc.status_code == 410 or exc.reason in cls._EXPIRED_REASONS
        )


class CompositePushNotificationService:
    """Expose both browser and native channels as one sync dispatcher."""

    def __init__(
        self,
        web: PushNotificationService | None,
        native: NativePushNotificationService | None,
    ) -> None:
        self.web = web
        self.native = native

    def dispatch(self) -> PushSummary:
        combined = PushSummary()
        for service in (self.web, self.native):
            if service is None:
                continue
            summary = service.dispatch()
            combined.attempted += summary.attempted
            combined.sent += summary.sent
            combined.failed += summary.failed
            combined.expired += summary.expired
        return combined
