"""Typed, validated boundary for data returned by carrier adapters."""

from __future__ import annotations

from typing import Any, Literal, TypedDict, cast

CarrierStatus = Literal[
    "pending",
    "in_transit",
    "out_for_delivery",
    "delivered",
    "exception",
    "unknown",
]


class CarrierEvent(TypedDict, total=False):
    time: str
    location: str
    description: str
    stage: str


class CarrierResult(TypedDict, total=False):
    status: CarrierStatus
    last_status_text: str | None
    last_update: str | None
    expected_delivery: str | None
    timezone: str
    events: list[CarrierEvent]


_STATUSES = frozenset(
    {"pending", "in_transit", "out_for_delivery", "delivered", "exception", "unknown"}
)
_OPTIONAL_TEXT_FIELDS = ("last_status_text", "last_update", "expected_delivery", "timezone")
_EVENT_TEXT_FIELDS = ("time", "location", "description", "stage")


def normalize_carrier_result(value: object) -> CarrierResult:
    """Validate the common carrier shape while preserving adapter-specific metadata."""

    if not isinstance(value, dict):
        raise ValueError("The carrier adapter returned an invalid response")

    normalized: dict[str, Any] = dict(value)
    status = normalized.get("status", "unknown")
    normalized["status"] = status if isinstance(status, str) and status in _STATUSES else "unknown"

    for field in _OPTIONAL_TEXT_FIELDS:
        field_value = normalized.get(field)
        if field_value is not None and not isinstance(field_value, str):
            raise ValueError(f"The carrier adapter returned an invalid {field.replace('_', ' ')}")

    raw_events = normalized.get("events", [])
    if raw_events is None:
        raw_events = []
    if not isinstance(raw_events, list):
        raise ValueError("The carrier adapter returned invalid tracking events")

    events: list[CarrierEvent] = []
    for raw_event in raw_events:
        if not isinstance(raw_event, dict):
            raise ValueError("The carrier adapter returned an invalid tracking event")
        event = dict(raw_event)
        for field in _EVENT_TEXT_FIELDS:
            field_value = event.get(field)
            if field_value is not None and not isinstance(field_value, str):
                raise ValueError("The carrier adapter returned an invalid tracking event")
        events.append(cast(CarrierEvent, event))
    normalized["events"] = events
    return cast(CarrierResult, normalized)
