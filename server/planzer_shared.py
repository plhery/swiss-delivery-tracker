"""Planzer Group shared-link tracking pages.

These links are capability URLs: the ``accessKey`` query parameter grants access
to a server-rendered tracking page.  Keep URL validation here next to the fetcher
so API input and scheduled synchronization use the same narrow contract.
"""

from __future__ import annotations

import re
import urllib.error
import urllib.request
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse


PLANZER_SHARED_HOST = "trackandtrace.planzergroup.com"
PLANZER_SHARED_PATH = re.compile(r"^/shared/sendungen/([^/]+)/?$")
PLANZER_ACCESS_KEY = re.compile(r"^[A-Za-z0-9_-]{32,256}$")


def normalize_tracking_number(raw: str) -> str:
    return re.sub(r"[\s.\-]", "", raw).upper()


def is_planzer_shared_tracking_number(raw: str) -> bool:
    """Return whether *raw* has Planzer's ``999.90.########`` shape."""

    return bool(re.fullmatch(r"99990\d{8}", normalize_tracking_number(raw)))


def validate_planzer_shared_url(raw_url: str, tracking_number: str) -> str:
    """Validate and return a Planzer capability URL without exposing its key."""

    url = raw_url.strip()
    if not 1 <= len(url) <= 4096:
        raise ValueError("Paste the complete Planzer tracking URL")

    try:
        parsed = urlparse(url)
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Paste a valid Planzer tracking URL") from exc

    if (
        parsed.scheme != "https"
        or (parsed.hostname or "").casefold() != PLANZER_SHARED_HOST
        or parsed.username is not None
        or parsed.password is not None
        or port not in (None, 443)
        or parsed.fragment
    ):
        raise ValueError(
            f"Planzer shared links must use https://{PLANZER_SHARED_HOST}"
        )

    path_match = PLANZER_SHARED_PATH.fullmatch(unquote(parsed.path))
    if not path_match:
        raise ValueError("Paste a Planzer shared shipment URL")
    if normalize_tracking_number(path_match.group(1)) != normalize_tracking_number(
        tracking_number
    ):
        raise ValueError("The Planzer URL belongs to a different tracking number")

    access_keys = parse_qs(parsed.query, keep_blank_values=True).get("accessKey", [])
    if len(access_keys) != 1 or not PLANZER_ACCESS_KEY.fullmatch(access_keys[0]):
        raise ValueError("The Planzer URL must include its accessKey")
    return url


@dataclass
class _RouteStep:
    label: str | None = None
    reached: bool = False
    timestamp: str | None = None


class _PlanzerSharedParser(HTMLParser):
    """Read Planzer's responsive five-step shipment route."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.div_depth = 0
        self.step_depth: int | None = None
        self.step: _RouteStep | None = None
        self.steps: list[_RouteStep] = []
        self.timestamps: list[str] = []

    @staticmethod
    def _attributes(attrs: list[tuple[str, str | None]]) -> dict[str, str]:
        return {key: value or "" for key, value in attrs}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = self._attributes(attrs)
        classes = set(attributes.get("class", "").split())

        if tag == "div":
            self.div_depth += 1
            if self.step is None and "text-center" in classes:
                self.step = _RouteStep()
                self.step_depth = self.div_depth

        if tag == "time" and attributes.get("datetime"):
            timestamp = attributes["datetime"].strip()
            self.timestamps.append(timestamp)
            if self.step is not None and self.step.timestamp is None:
                self.step.timestamp = timestamp

        if (
            tag == "span"
            and self.step is not None
            and "tooltip-target" in classes
        ):
            # Bootstrap moves ``title`` to ``data-original-title`` when it
            # initializes.  Scheduled sync sees the raw, pre-JavaScript HTML.
            label = attributes.get("data-original-title") or attributes.get("title")
            if label:
                self.step.label = label.strip()
                self.step.reached = "text-primary" in classes

    def handle_endtag(self, tag: str) -> None:
        if tag != "div":
            return
        if self.step is not None and self.step_depth == self.div_depth:
            if self.step.label:
                self.steps.append(self.step)
            self.step = None
            self.step_depth = None
        self.div_depth = max(0, self.div_depth - 1)


_CORE_STAGES = (
    "registered",
    "accepted",
    "in_transit",
    "out_for_delivery",
    "delivered",
)

_EVENT_DESCRIPTIONS = {
    "registered": "Shipment registered by Planzer",
    "accepted": "Shipment accepted from the sender",
    "in_transit": "Shipment at the transfer depot",
    "out_for_delivery": "Out for delivery",
    "delivered": "Delivered",
}


def _label_stage(label: str) -> str | None:
    value = label.casefold()
    matches = (
        ("delivered", ("ausgeliefert", "delivered", "livré", "livrée", "consegnat")),
        (
            "out_for_delivery",
            ("in auslieferung", "out for delivery", "en livraison", "in consegna"),
        ),
        (
            "in_transit",
            (
                "umschlaglager",
                "transfer depot",
                "transshipment",
                "plateforme",
                "trasbordo",
            ),
        ),
        ("accepted", ("abholung", "collection", "collecte", "ritiro")),
        ("registered", ("erfasst", "recorded", "enregistr", "registrat")),
    )
    for stage, needles in matches:
        if any(needle in value for needle in needles):
            return stage
    return None


def parse_tracking_html(html: str, tracking_number: str) -> dict[str, Any]:
    parser = _PlanzerSharedParser()
    parser.feed(html)

    # The same route is rendered for desktop, tablet and mobile.  Keep the first
    # instance of each label and use its route position as a localization fallback.
    unique_steps: list[_RouteStep] = []
    labels_seen: set[str] = set()
    for step in parser.steps:
        key = (step.label or "").casefold()
        if not key or key in labels_seen:
            continue
        labels_seen.add(key)
        unique_steps.append(step)

    if len(unique_steps) < len(_CORE_STAGES):
        raise ValueError(
            "The Planzer shared link did not return tracking details; check its accessKey"
        )

    events: list[dict[str, str]] = []
    current_stage: str | None = None
    current_label = ""
    for index, step in enumerate(unique_steps[: len(_CORE_STAGES)]):
        stage = _label_stage(step.label or "") or _CORE_STAGES[index]
        if not step.reached:
            continue
        current_stage = stage
        current_label = step.label or _EVENT_DESCRIPTIONS[stage]
        events.append(
            {
                "time": step.timestamp or "",
                "location": "",
                "description": _EVENT_DESCRIPTIONS[stage],
            }
        )

    if current_stage is None:
        raise ValueError(
            "The Planzer shared link did not return tracking details; check its accessKey"
        )

    status = {
        "registered": "pending",
        "accepted": "in_transit",
        "in_transit": "in_transit",
        "out_for_delivery": "out_for_delivery",
        "delivered": "delivered",
    }[current_stage]
    valid_dates = sorted(
        {
            timestamp[:10]
            for timestamp in parser.timestamps
            if re.match(r"^\d{4}-\d{2}-\d{2}", timestamp)
        }
    )
    expected_delivery = valid_dates[-1] if valid_dates else None

    return {
        "status": status,
        "last_status_text": current_label,
        "last_update": events[-1]["time"] or None,
        "expected_delivery": expected_delivery,
        "events": list(reversed(events)),
        "tracking_number": normalize_tracking_number(tracking_number),
    }


class PlanzerSharedTracker:
    def __init__(self, timeout: int = 15) -> None:
        self.timeout = timeout

    def fetch(self, tracking_number: str, tracking_url: str) -> dict[str, Any]:
        url = validate_planzer_shared_url(tracking_url, tracking_number)
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "de-CH,de;q=0.9,en;q=0.8",
                "User-Agent": "SwissDeliveryTracker/1.0",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = response.read(2_000_001)
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"Planzer shared tracking returned HTTP {exc.code}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError("Planzer shared tracking is unreachable") from exc
        if len(body) > 2_000_000:
            raise RuntimeError("Planzer shared tracking returned an unexpectedly large page")
        return parse_tracking_html(body.decode("utf-8", errors="replace"), tracking_number)
