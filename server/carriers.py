"""Carrier capabilities generated from the public API contract."""

from __future__ import annotations

import re
from typing import Any, cast

from .api_contract import CARRIER_CAPABILITIES
from .dachser import validate_dachser_tracking_url
from .planzer_shared import validate_planzer_shared_url

_CARRIER_DEFINITIONS = cast(dict[str, dict[str, Any]], CARRIER_CAPABILITIES)

AUTOMATIC_CARRIER_IDS = frozenset(
    carrier_id
    for carrier_id, definition in _CARRIER_DEFINITIONS.items()
    if definition["tracking"]["mode"] == "automatic"
)

CARRIER_NAMES = {
    carrier_id: str(definition["tracking"].get("upstreamName") or definition["displayName"])
    for carrier_id, definition in _CARRIER_DEFINITIONS.items()
    if carrier_id in AUTOMATIC_CARRIER_IDS
}


def carrier_definition(carrier_id: str) -> dict[str, Any]:
    definition = _CARRIER_DEFINITIONS.get(carrier_id)
    if not isinstance(definition, dict):
        raise LookupError(f"Unknown carrier {carrier_id}")
    return definition


def carrier_timezone(carrier_id: str) -> str:
    return str(carrier_definition(carrier_id).get("timezone") or "UTC")


def carrier_adapter(carrier_id: str) -> str | None:
    adapter = carrier_definition(carrier_id)["tracking"].get("adapter")
    return str(adapter) if adapter else None


def active_requirements(carrier_id: str, tracking_number: str) -> tuple[dict[str, Any], ...]:
    requirements = carrier_definition(carrier_id)["tracking"].get("requirements") or ()
    return tuple(
        requirement
        for requirement in requirements
        if not requirement.get("whenTrackingNumber")
        or re.fullmatch(str(requirement["whenTrackingNumber"]), tracking_number)
    )


def normalize_carrier_inputs(
    carrier_id: str,
    tracking_number: str,
    tracking_url: str,
    dpd_postcode: str,
) -> tuple[str | None, str | None]:
    """Validate only the extra inputs declared by the carrier's capabilities."""

    supplied = {
        "trackingUrl": tracking_url.strip() or None,
        "dpdPostcode": dpd_postcode.strip() or None,
    }
    requirements = {
        item["field"]: item for item in active_requirements(carrier_id, tracking_number)
    }

    for field, value in supplied.items():
        if value is not None and field not in requirements:
            if field == "trackingUrl":
                raise ValueError("A tracking URL is not used for this carrier or tracking number")
            raise ValueError("A delivery postcode is only used for DPD")

    for field, requirement in requirements.items():
        value = supplied.get(field)
        if not value:
            if field == "trackingUrl":
                carrier_name = str(carrier_definition(carrier_id)["displayName"])
                raise ValueError(f"{carrier_name} requires its complete tracking URL")
            raise ValueError("DPD parcels require the four-digit delivery postcode")

        validator = requirement.get("validator")
        if validator == "planzerSharedUrl":
            supplied[field] = validate_planzer_shared_url(value, tracking_number)
        elif validator == "dachserCapabilityUrl":
            supplied[field] = validate_dachser_tracking_url(value, tracking_number)
        elif validator == "swissPostcode" and not re.fullmatch(r"\d{4}", value):
            raise ValueError("DPD parcels require the four-digit delivery postcode")
        elif validator not in {
            "planzerSharedUrl",
            "dachserCapabilityUrl",
            "swissPostcode",
        }:
            raise RuntimeError(f"Unknown carrier input validator: {validator}")

    return supplied["trackingUrl"], supplied["dpdPostcode"]
