"""Swiss Post tracking using the complete anonymous shipment-detail flow."""

from __future__ import annotations

import html
import http.cookiejar
import json
import re
import urllib.parse
import urllib.request
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any, cast

from .bounded_http import BoundedResponse
from .carrier_result import CarrierEvent, CarrierResult, CarrierStatus

_API_BASE = "https://service.post.ch/ekp-web/api"
_TRANSLATIONS_URL = (
    "https://service.post.ch/ekp-web/core/rest/translations/en/shipment-text-messages"
)
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "Chrome/121.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-CH,en;q=0.9",
    "Referer": "https://service.post.ch/ekp-web/ui/",
}
_STATUS_MAP = {
    "REPORTED": "pending",
    "REGISTERED": "pending",
    "TO_BE_DELIVERED": "in_transit",
    "IN_DELIVERY": "out_for_delivery",
    "DELIVERED": "delivered",
    "MISSED_DELIVERY": "exception",
    "NOT_DELIVERED": "exception",
    "RETURNED": "exception",
    "CUSTOMS": "in_transit",
}
_FALLBACK_EVENT_LABELS = {
    "600": "Your shipment will shortly be handed over to Swiss Post",
    "1003": "Loading into delivery vehicle",
    "1201": "Sorted for delivery",
    "1202": "Shipment was sorted",
}
_EVENT_STAGE_BY_CODE = {
    "600": "registered",
    "1003": "out_for_delivery",
    "1201": "in_transit",
    "1202": "in_transit",
    "3600": "returned",
    "4600": "delivered",
}
_STAGE_STATUS = {
    "registered": "pending",
    "accepted": "in_transit",
    "in_transit": "in_transit",
    "out_for_delivery": "out_for_delivery",
    "delivered": "delivered",
    "customs": "in_transit",
    "failed_attempt": "exception",
    "ready_for_pickup": "in_transit",
    "returned": "exception",
}


def _make_opener() -> Any:
    jar = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def _read_json(opener: Any, request: urllib.request.Request) -> Any:
    with BoundedResponse(opener.open(request, timeout=10)) as response:
        return json.loads(response.read().decode("utf-8", errors="replace"))


def _text(value: Any, limit: int = 500) -> str:
    return str(value or "").strip()[:limit]


def _date_part(value: Any) -> str | None:
    match = re.search(r"(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)", _text(value))
    return match.group(1) if match else None


def _clock_parts(value: Any) -> list[str]:
    if isinstance(value, dict):
        clocks: list[str] = []
        for key in ("start", "end", "from", "to"):
            clocks.extend(_clock_parts(value.get(key)))
        return clocks
    if isinstance(value, (list, tuple)):
        return [clock for item in value for clock in _clock_parts(item)]
    text = _text(value)
    timestamp_clock = re.search(r"T((?:[01]\d|2[0-3]):[0-5]\d)", text)
    if timestamp_clock:
        return [timestamp_clock.group(1)]
    clocks = [
        match.group(0)
        for match in re.finditer(r"(?<!\d)(?:[01]\d|2[0-3]):[0-5]\d", text)
    ]
    if len(clocks) > 1 and re.search(r"[+-](?:[01]\d|2[0-3]):[0-5]\d$", text):
        return clocks[:1]
    return clocks


def expected_delivery(item: dict[str, Any]) -> str | None:
    """Return the delivery date together with Swiss Post's available time slot."""

    interval = item.get("deliveryTimeInterval")
    delivery_range = item.get("deliveryRange")
    range_start = delivery_range.get("start") if isinstance(delivery_range, dict) else None
    range_end = delivery_range.get("end") if isinstance(delivery_range, dict) else None
    date = next(
        (
            parsed
            for raw in (
                item.get("calculatedDeliveryDate"),
                item.get("deliveryDate"),
                interval,
                range_start,
                range_end,
            )
            if (parsed := _date_part(raw))
        ),
        None,
    )
    if not date:
        return None

    clocks = _clock_parts(interval)
    if not clocks:
        return date
    if len(clocks) == 1 or clocks[0] == clocks[1]:
        return f"{date} {clocks[0]}"
    return f"{date} {clocks[0]}–{clocks[1]}"


def _translation_match(
    translations: dict[str, str],
    segments: list[str],
) -> str | None:
    best: tuple[int, str] | None = None
    for pattern, description in translations.items():
        pattern_segments = pattern.split(".")
        if len(pattern_segments) != len(segments):
            continue
        if not all(
            expected == "*" or expected == actual
            for expected, actual in zip(pattern_segments, segments, strict=True)
        ):
            continue
        score = sum(expected != "*" for expected in pattern_segments)
        if best is None or score > best[0]:
            best = (score, description)
    return best[1] if best else None


def _event_description(
    event: dict[str, Any],
    translations: dict[str, str],
    international_type: str,
) -> str:
    event_code = _text(event.get("eventCode"), 100)
    segments = [*event_code.split("."), international_type]
    description = _translation_match(translations, segments)

    sub_event_id = _text(event.get("subEventId"), 50)
    if sub_event_id:
        sub_segments = [*segments, sub_event_id]
        detail_code = _text(event.get("subEventDetailCode"), 50)
        if detail_code:
            sub_segments.append(detail_code)
        detail = _translation_match(translations, sub_segments)
        if detail and detail != description:
            description = f"{description} — {detail}" if description else detail

    external_metadata = event.get("externalMetadata")
    external_description = (
        _text(external_metadata.get("description"))
        if isinstance(external_metadata, dict)
        else ""
    )
    code = event_code.split(".")[-1]
    value = description or external_description or _FALLBACK_EVENT_LABELS.get(code) or event_code
    return html.unescape(re.sub(r"<[^>]*>", "", value)).strip()[:500] or "Tracking update"


def _event_location(event: dict[str, Any]) -> str:
    city = _text(event.get("city"), 100)
    postcode = _text(event.get("zip"), 30)
    return " ".join(part for part in (city, postcode) if part)[:160]


def _event_sort_key(event: CarrierEvent) -> float:
    try:
        parsed = datetime.fromisoformat(event.get("time", "").replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except ValueError:
        return float("-inf")


def parse_shipment(
    item: dict[str, Any],
    raw_events: list[Any],
    translations: dict[str, str] | None = None,
) -> CarrierResult:
    """Build the common carrier result without retaining shipment identity or addresses."""

    global_status = _text(item.get("globalStatus"), 100)
    status = _STATUS_MAP.get(global_status, "in_transit")
    international_type = (
        "IMPORT"
        if item.get("internationalImport")
        else "EXPORT"
        if item.get("internationalExport")
        else "INLAND"
    )
    dictionary = translations or {}
    events: list[CarrierEvent] = []
    for raw_event in raw_events[:100]:
        if not isinstance(raw_event, dict):
            continue
        timestamp = _text(raw_event.get("timestamp"), 100)
        event_code = _text(raw_event.get("eventCode"), 100)
        if not timestamp or not event_code:
            continue
        event: CarrierEvent = {
            "time": timestamp,
            "location": _event_location(raw_event),
            "description": _event_description(raw_event, dictionary, international_type),
            "provider_code": event_code,
        }
        stage = _EVENT_STAGE_BY_CODE.get(event_code.split(".")[-1])
        if stage:
            event["stage"] = stage
        events.append(event)
    events.sort(key=_event_sort_key, reverse=True)

    last_update: str | None
    if events:
        latest = events[0]
        last_status_text = latest["description"]
        if latest.get("stage") in _STAGE_STATUS:
            status = _STAGE_STATUS[latest["stage"]]
        last_update = latest["time"]
    else:
        last_status_text = global_status
        last_update = _text(item.get("lastEventDateTime"), 100) or None

    return {
        "status": cast(CarrierStatus, status),
        "last_status_text": last_status_text,
        "last_update": last_update,
        "expected_delivery": expected_delivery(item),
        "timezone": "Europe/Zurich",
        "global_status": global_status,
        "delivery_range": item.get("deliveryRange"),
        "delivery_time_interval": item.get("deliveryTimeInterval"),
        "events": events,
    }


class SwissPostTracker:
    def __init__(self, opener_factory: Callable[[], Any] = _make_opener) -> None:
        self.opener_factory = opener_factory
        self._translations: dict[str, str] | None = None
        self._translation_attempted = False

    def _load_translations(self, opener: Any) -> dict[str, str]:
        if self._translations is not None:
            return self._translations
        if self._translation_attempted:
            return {}
        self._translation_attempted = True
        try:
            payload = _read_json(
                opener,
                urllib.request.Request(_TRANSLATIONS_URL, headers=_HEADERS),
            )
            raw = payload.get("shipment-text--") if isinstance(payload, dict) else None
            if isinstance(raw, dict):
                self._translations = {
                    str(key): str(value)
                    for key, value in raw.items()
                    if isinstance(key, str) and isinstance(value, str)
                }
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        return self._translations or {}

    def fetch(self, tracking_number: str) -> CarrierResult:
        opener = self.opener_factory()
        headers = dict(_HEADERS)

        user_request = urllib.request.Request(f"{_API_BASE}/user", headers=headers)
        with BoundedResponse(opener.open(user_request, timeout=10)) as response:
            csrf = response.headers.get("x-csrf-token", "")
            user_payload = json.loads(
                response.read().decode("utf-8", errors="replace")
            )
        if not isinstance(user_payload, dict):
            raise ValueError("Swiss Post returned an invalid anonymous user response")
        user_id = _text(user_payload.get("userIdentifier"), 500)
        if not user_id:
            raise ValueError("Swiss Post did not return an anonymous user identifier")
        headers["x-csrf-token"] = csrf

        query = urllib.parse.urlencode({"userId": user_id})
        history_request = urllib.request.Request(
            f"{_API_BASE}/history?{query}",
            data=json.dumps({"searchQuery": tracking_number}).encode("utf-8"),
            headers={**headers, "Content-Type": "application/json"},
        )
        history_payload = _read_json(opener, history_request)
        hash_value = _text(
            history_payload.get("hash") if isinstance(history_payload, dict) else None,
            500,
        )
        if not hash_value:
            raise ValueError("Swiss Post did not return a shipment search identifier")

        detail_request = urllib.request.Request(
            f"{_API_BASE}/history/not-included/"
            f"{urllib.parse.quote(hash_value, safe='')}?{query}",
            headers=headers,
        )
        items = _read_json(opener, detail_request)
        if not isinstance(items, list) or not items or not isinstance(items[0], dict):
            return {
                "status": "unknown",
                "last_status_text": "",
                "last_update": None,
                "expected_delivery": None,
                "timezone": "Europe/Zurich",
                "events": [],
            }

        item = items[0]
        identity = _text(item.get("identity"), 500)
        raw_events: list[Any] = []
        if identity:
            try:
                events_request = urllib.request.Request(
                    f"{_API_BASE}/shipment/id/"
                    f"{urllib.parse.quote(identity, safe='')}/events",
                    headers=headers,
                )
                events_payload = _read_json(opener, events_request)
                if isinstance(events_payload, list):
                    raw_events = events_payload
            except (OSError, ValueError, json.JSONDecodeError):
                pass

        translations = self._load_translations(opener) if raw_events else {}
        return parse_shipment(item, raw_events, translations)
