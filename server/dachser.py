"""Privacy-safe tracking for Dachser Customer Iberia capability links.

The public detail URL contains credentials that grant access to a shipment. The
JSON endpoint behind that page also returns sender and recipient details, so the
adapter deliberately copies only normalized shipment status fields and never
returns the source document.
"""

from __future__ import annotations

import json
import re
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime
from typing import Any
from urllib.parse import parse_qsl, unquote, urlparse, urlunparse
from zoneinfo import ZoneInfo

DACHSER_HOST = "customeriberia.dachser.com"
DACHSER_PAGE_PATH = "/customerarea/utilidades/seguimiento-publico/detalle"
DACHSER_API_PATH = "/api/utilidades/seguimiento-publico/detalle"
MAX_DACHSER_RESPONSE_BYTES = 2_000_000
MADRID = ZoneInfo("Europe/Madrid")

_ALLOWED_QUERY_KEYS = frozenset(
    {
        "hash",
        "cliente",
        "numeroUnico",
        "referencia",
        "fecha",
        "clave",
        "user",
        "idioma",
        "expedicion",
        "tipoMail",
        "error",
        "origen",
        "usuario",
    }
)
_CAPABILITY_VALUE = re.compile(r"^[A-Za-z0-9_-]{4,256}$")
_CONTROL_CHARACTER = re.compile(r"[\x00-\x1f\x7f]")


def normalize_tracking_number(raw: object) -> str:
    return re.sub(r"[\s.\-]", "", str(raw or "")).upper()


def validate_dachser_tracking_url(raw_url: str, tracking_number: str) -> str:
    """Validate a Dachser capability URL and return it without exposing its key."""

    url = raw_url.strip()
    if not 1 <= len(url) <= 4096:
        raise ValueError("Paste the complete Dachser tracking URL")

    try:
        parsed = urlparse(url)
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Paste a valid Dachser tracking URL") from exc

    if (
        parsed.scheme != "https"
        or (parsed.hostname or "").casefold() != DACHSER_HOST
        or parsed.username is not None
        or parsed.password is not None
        or port not in (None, 443)
        or parsed.fragment
    ):
        raise ValueError(f"Dachser links must use https://{DACHSER_HOST}")
    if unquote(parsed.path) not in {DACHSER_PAGE_PATH, f"{DACHSER_PAGE_PATH}/"}:
        raise ValueError("Paste a Dachser public shipment detail URL")

    pairs = parse_qsl(parsed.query, keep_blank_values=True)
    values: dict[str, str] = {}
    for name, value in pairs:
        if name not in _ALLOWED_QUERY_KEYS:
            raise ValueError("The Dachser URL contains an unsupported parameter")
        if name in values:
            raise ValueError("The Dachser URL contains a duplicate parameter")
        if not value or len(value) > 256 or _CONTROL_CHARACTER.search(value):
            raise ValueError("The Dachser URL contains an invalid parameter")
        values[name] = value

    unique_number = values.get("numeroUnico")
    if not unique_number:
        raise ValueError("The Dachser URL must include its shipment number")
    if normalize_tracking_number(unique_number) != normalize_tracking_number(tracking_number):
        raise ValueError("The Dachser URL belongs to a different tracking number")

    capability_hash = values.get("hash")
    capability_key = values.get("clave")
    capability_date = values.get("fecha")
    has_hash = bool(capability_hash and _CAPABILITY_VALUE.fullmatch(capability_hash))
    has_key = bool(
        capability_key
        and capability_date
        and _CAPABILITY_VALUE.fullmatch(capability_key)
        and re.fullmatch(r"\d{8}", capability_date)
    )
    if not (has_hash or has_key):
        raise ValueError("The Dachser URL must include its access parameters")
    return urlunparse(("https", DACHSER_HOST, parsed.path, "", parsed.query, ""))


def dachser_api_url(tracking_url: str, tracking_number: str) -> str:
    """Convert a validated customer-area URL to the matching JSON endpoint."""

    validated = validate_dachser_tracking_url(tracking_url, tracking_number)
    parsed = urlparse(validated)
    return urlunparse(("https", DACHSER_HOST, DACHSER_API_PATH, "", parsed.query, ""))


def _plain_text(raw: object) -> str:
    value = unicodedata.normalize("NFKD", str(raw or "").casefold())
    return "".join(character for character in value if not unicodedata.combining(character))


def _parse_datetime(raw: object) -> datetime | None:
    value = str(raw or "").strip()
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        parsed = None
        for date_format in (
            "%d/%m/%Y %H:%M:%S",
            "%d/%m/%Y %H:%M",
            "%d/%m/%Y",
            "%Y-%m-%d %H:%M:%S",
            "%Y-%m-%d %H:%M",
            "%Y-%m-%d",
        ):
            try:
                parsed = datetime.strptime(value, date_format)
                break
            except ValueError:
                continue
        if parsed is None:
            return None
    assert parsed is not None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=MADRID)
    return parsed


def _event_label(raw_description: object) -> tuple[str, str]:
    value = _plain_text(raw_description)
    rules = (
        (
            "failed_attempt",
            "Delivery attempt was unsuccessful",
            ("no entreg", "entrega fallida", "failed delivery", "unsuccessful"),
        ),
        (
            "returned",
            "Shipment returned",
            ("devol", "retorn", "return", "retour"),
        ),
        (
            "in_transit",
            "Delivery appointment updated",
            ("fecha de entrega", "cita", "appointment", "avis de livraison"),
        ),
        (
            "delivered",
            "Delivered",
            ("entregado", "entregada", "delivered", "zugestellt", "consegnat"),
        ),
        (
            "out_for_delivery",
            "Out for delivery",
            ("reparto", "proceso de entrega", "out for delivery", "in zustellung"),
        ),
        (
            "ready_for_pickup",
            "Ready for pickup",
            ("recogida", "ready for pickup", "ready for collection", "abholbereit"),
        ),
        (
            "customs",
            "Customs processing",
            ("aduana", "customs", "clearance", "zoll"),
        ),
        (
            "in_transit",
            "Shipment departed a Dachser facility",
            ("salida", "departed", "outbound"),
        ),
        (
            "in_transit",
            "Shipment arrived at a Dachser facility",
            ("llegada", "arrived", "inbound"),
        ),
        (
            "accepted",
            "Shipment accepted by Dachser",
            ("recogido", "aceptado", "picked up", "accepted"),
        ),
        (
            "registered",
            "Shipment registered by Dachser",
            ("registrado", "creado", "announced", "registered", "information received"),
        ),
    )
    for stage, description, needles in rules:
        if any(needle in value for needle in needles):
            return stage, description
    return "in_transit", "Dachser tracking update"


def _shipment_status(raw_status: object, has_events: bool) -> tuple[str, str]:
    value = _plain_text(raw_status)
    if any(
        needle in value
        for needle in (
            "no entreg",
            "incidencia",
            "averia",
            "failed",
            "problem",
            "devol",
            "return",
            "retour",
        )
    ):
        return "exception", "Shipment exception"
    if any(
        needle in value
        for needle in ("entregado", "entregada", "delivered", "zugestellt", "consegnat")
    ):
        return "delivered", "Delivered"
    if any(
        needle in value
        for needle in ("reparto", "proceso de entrega", "out for delivery", "in zustellung")
    ):
        return "out_for_delivery", "Out for delivery"
    if any(
        needle in value
        for needle in ("registrado", "creado", "announced", "registered", "information received")
    ):
        return "pending", "Shipment registered by Dachser"
    if value or has_events:
        return "in_transit", "In transit"
    return "unknown", "Tracking update unavailable"


def parse_tracking_response(payload: object, tracking_number: str) -> dict[str, Any]:
    """Reduce Dachser's response to non-personal shipment state."""

    if not isinstance(payload, dict):
        raise ValueError("Dachser returned an invalid tracking response")
    returned_number = payload.get("numUnico")
    if not returned_number:
        raise ValueError("Dachser did not return a shipment number")
    if normalize_tracking_number(returned_number) != normalize_tracking_number(tracking_number):
        raise ValueError("Dachser returned a different shipment")

    source_events = payload.get("incidenciaExpedicionData")
    event_rows = source_events if isinstance(source_events, list) else []
    events: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    for source_event in event_rows[:200]:
        if not isinstance(source_event, dict):
            continue
        occurred = _parse_datetime(source_event.get("fechaIncidencia"))
        if occurred is None:
            continue
        stage, description = _event_label(source_event.get("descripcionIncidencia"))
        timestamp = occurred.isoformat()
        identity = (timestamp, stage, description)
        if identity in seen:
            continue
        seen.add(identity)
        events.append(
            {
                "time": timestamp,
                "location": "",
                "stage": stage,
                "description": description,
            }
        )
    events.sort(key=lambda event: event["time"], reverse=True)

    status, status_text = _shipment_status(payload.get("estadoExpedicion"), bool(events))
    last_update = _parse_datetime(payload.get("fechaEstado"))
    if last_update is None and events:
        last_update = _parse_datetime(events[0]["time"])

    expected_delivery = None
    if status != "delivered":
        for field in ("fechaEntregaAplazada", "fCompromiso", "fechaPrimeraEntrega"):
            expected = _parse_datetime(payload.get(field))
            if expected is not None:
                expected_delivery = expected.date().isoformat()
                break

    return {
        "status": status,
        "last_status_text": status_text,
        "last_update": last_update.isoformat() if last_update else None,
        "expected_delivery": expected_delivery,
        "timezone": "Europe/Madrid",
        "events": events,
    }


class DachserTracker:
    def __init__(self, timeout: int = 15) -> None:
        self.timeout = timeout

    def fetch(self, tracking_number: str, tracking_url: str) -> dict[str, Any]:
        api_url = dachser_api_url(tracking_url, tracking_number)
        request = urllib.request.Request(
            api_url,
            headers={
                "Accept": "application/json",
                "Accept-Language": "en",
                "Referer": f"https://{DACHSER_HOST}{DACHSER_PAGE_PATH}",
                "User-Agent": "SwissDeliveryTracker/1.0",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = response.read(MAX_DACHSER_RESPONSE_BYTES + 1)
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"Dachser tracking returned HTTP {exc.code}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError("Dachser tracking is unreachable") from exc
        if len(body) > MAX_DACHSER_RESPONSE_BYTES:
            raise RuntimeError("Dachser tracking returned an unexpectedly large response")
        try:
            payload = json.loads(body.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("Dachser returned an invalid tracking response") from exc
        return parse_tracking_response(payload, tracking_number)
