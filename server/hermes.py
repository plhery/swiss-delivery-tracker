"""Hermes Einrichtungs-Service tracking with corrected status semantics."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import quote

HERMES_API = "https://myhes.de/api/request/auftragsdaten"
MAX_HERMES_RESPONSE_BYTES = 2_000_000
DEFAULT_TIMEOUT = 15


def status_for_id(raw_status_id: object) -> str:
    """Map HES' ordered status bands without treating exceptions as delivered."""

    if not isinstance(raw_status_id, (str, bytes, bytearray, int, float)):
        return "pending"
    try:
        status_id = int(raw_status_id)
    except (TypeError, ValueError):
        return "pending"
    if status_id >= 50_000:
        return "exception"
    if status_id >= 40_000:
        return "delivered"
    if status_id >= 30_000:
        return "out_for_delivery"
    if status_id >= 20_000:
        return "in_transit"
    return "pending"


def event_stage_for_id(raw_status_id: object) -> str:
    status = status_for_id(raw_status_id)
    return "failed_attempt" if status == "exception" else status


def parse_tracking_response(payload: object) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("Hermes returned an invalid tracking response")
    body = payload.get("body", payload)
    if not isinstance(body, dict):
        raise ValueError("Hermes returned an invalid tracking response")
    order = body.get("auftragsdaten") or {}
    if not isinstance(order, dict):
        raise ValueError("Hermes returned an invalid tracking response")
    journey = order.get("statusjourneyDto") or {}
    if not isinstance(journey, dict):
        raise ValueError("Hermes returned an invalid tracking response")

    raw_events: list[dict[str, Any]] = []
    for key in ("auftragstatusdaten", "statusdaten"):
        values = journey.get(key) or []
        if isinstance(values, list):
            raw_events.extend(event for event in values if isinstance(event, dict))
    raw_events.sort(
        key=lambda event: str(event.get("sendungsstatusBuchungszeitpunkt") or ""),
        reverse=True,
    )
    events = [
        {
            "time": str(event.get("sendungsstatusBuchungszeitpunkt") or ""),
            "location": "",
            "description": str(event.get("sendungsstatus") or "Tracking update"),
            "stage": event_stage_for_id(event.get("sendungsstatusId")),
        }
        for event in raw_events
    ]
    status = status_for_id(raw_events[0].get("sendungsstatusId")) if raw_events else "pending"
    return {
        "status": status,
        "last_status_text": events[0]["description"] if events else "",
        "last_update": events[0]["time"] if events else None,
        "expected_delivery": order.get("lieferdatum") or order.get("hesBasicLieferterminZeit"),
        "timezone": "Europe/Zurich",
        "events": events,
    }


class HermesTracker:
    def __init__(self, timeout: int = DEFAULT_TIMEOUT) -> None:
        self.timeout = timeout

    def fetch(self, tracking_number: str) -> dict[str, Any]:
        request = urllib.request.Request(
            f"{HERMES_API}?parcelNumber={quote(tracking_number)}",
            headers={
                "Accept": "application/json",
                "User-Agent": "Mozilla/5.0 (compatible; SwissDeliveryTracker/1.0)",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read(MAX_HERMES_RESPONSE_BYTES + 1)
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
            raise RuntimeError("Hermes tracking is unavailable") from exc
        if len(raw) > MAX_HERMES_RESPONSE_BYTES:
            raise RuntimeError("Hermes returned an unexpectedly large response")
        try:
            payload = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("Hermes returned an invalid tracking response") from exc
        return parse_tracking_response(payload)
