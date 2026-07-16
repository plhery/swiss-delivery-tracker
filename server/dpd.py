"""DPD Switzerland tracking through the public myDPD page."""

from __future__ import annotations

import json
import os
import re
from datetime import datetime
from html.parser import HTMLParser
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo


DPD_TRACKING_BASE = "https://www.dpdgroup.com/ch/mydpd/my-parcels/incoming"
DEFAULT_TIMEOUT = 90
MAX_RESPONSE_BYTES = 10_000_000
ZURICH = ZoneInfo("Europe/Zurich")


class DPDChallengeError(RuntimeError):
    """The DPD page returned a Cloudflare browser challenge."""


def tracking_url(tracking_number: str, *, language: str | None = None) -> str:
    url = f"{DPD_TRACKING_BASE}?parcelNumber={quote(tracking_number)}"
    return f"{url}&lang={quote(language)}" if language else url


def _clean(value: str) -> str:
    return " ".join(value.split())


class _DPDPageParser(HTMLParser):
    """Extract the stable timeline classes from the server-rendered page."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.depth = 0
        self.ignored_depth: int | None = None
        self.visible_text: list[str] = []
        self.events: list[dict[str, str]] = []
        self.status_labels: list[str] = []
        self.current_event: dict[str, str] | None = None
        self.event_depth: int | None = None
        self.capture: tuple[str, int, list[str]] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.depth += 1
        attributes = dict(attrs)
        classes = set((attributes.get("class") or "").split())

        if tag in {"script", "style"}:
            self.ignored_depth = self.depth
            return

        if tag == "li" and "content-item-track" in classes:
            self.current_event = {}
            self.event_depth = self.depth

        if self.current_event is not None:
            if "entry-date" in classes:
                self.capture = ("date", self.depth, [])
            elif "entry-time" in classes:
                self.capture = ("clock", self.depth, [])
            elif "place-track" in classes:
                self.capture = ("location", self.depth, [])
            elif "entry-body" in classes:
                self.capture = ("description", self.depth, [])
        elif "gray-out" in classes:
            self.capture = ("status", self.depth, [])

    def handle_data(self, data: str) -> None:
        if self.ignored_depth is not None:
            return
        value = _clean(data)
        if not value:
            return
        self.visible_text.append(value)
        if self.capture is not None:
            self.capture[2].append(value)

    def handle_endtag(self, tag: str) -> None:
        if self.ignored_depth == self.depth:
            self.ignored_depth = None

        if self.capture is not None and self.capture[1] == self.depth:
            key, _, parts = self.capture
            value = _clean(" ".join(parts))
            if value:
                if key == "status":
                    self.status_labels.append(value)
                elif self.current_event is not None:
                    self.current_event[key] = value
            self.capture = None

        if (
            tag == "li"
            and self.current_event is not None
            and self.event_depth == self.depth
        ):
            if self.current_event.get("description"):
                self.events.append(self.current_event)
            self.current_event = None
            self.event_depth = None

        self.depth -= 1


def _event_time(date: str, clock: str) -> str:
    value = f"{date} {clock}".strip()
    try:
        return datetime.strptime(value, "%d.%m.%Y %H:%M").replace(tzinfo=ZURICH).isoformat()
    except ValueError:
        return value


def _status(text: str, has_events: bool) -> str:
    value = text.casefold()
    if any(
        word in value
        for word in ("failed", "not delivered", "unable", "problem", "retour", "returned")
    ):
        return "exception"
    if any(word in value for word in ("delivered", "zugestellt", "livré", "consegnato")):
        return "delivered"
    if any(
        word in value
        for word in (
            "out for delivery",
            "delivery today",
            "in zustellung",
            "en cours de livraison",
        )
    ):
        return "out_for_delivery"
    if has_events or any(
        word in value
        for word in ("handed to dpd", "on its way", "arrived", "depot", "network")
    ):
        return "in_transit"
    if any(
        word in value
        for word in ("data received", "information received", "announced", "übergeben")
    ):
        return "pending"
    return "unknown"


def parse_tracking_html(html: str, tracking_number: str) -> dict[str, Any]:
    if re.search(r"Just a moment|cf-mitigated|Enable JavaScript and cookies", html, re.I):
        raise DPDChallengeError("DPD returned a Cloudflare browser challenge")

    parser = _DPDPageParser()
    parser.feed(html)
    visible = " ".join(parser.visible_text)

    if tracking_number not in visible:
        raise LookupError("DPD did not return the requested parcel")
    if re.search(r"no parcel|not found|nicht gefunden|aucun colis", visible, re.I):
        return {
            "status": "unknown",
            "last_status_text": "No parcel found",
            "last_update": None,
            "expected_delivery": None,
            "events": [],
        }

    events = [
        {
            "time": _event_time(event.get("date", ""), event.get("clock", "")),
            "location": event.get("location", ""),
            "description": event["description"],
        }
        for event in parser.events
    ]
    status_text = (
        events[0]["description"]
        if events
        else parser.status_labels[-1] if parser.status_labels else "Tracking information received"
    )
    return {
        "status": _status(status_text, bool(events)),
        "last_status_text": status_text,
        "last_update": events[0]["time"] if events else None,
        "expected_delivery": None,
        "events": events,
    }


class DPDTracker:
    def __init__(self, flaresolverr_url: str | None = None, timeout: int = DEFAULT_TIMEOUT) -> None:
        self.flaresolverr_url = (
            flaresolverr_url
            if flaresolverr_url is not None
            else os.environ.get("FLARESOLVERR_URL", "")
        ).strip()
        self.timeout = timeout

    def fetch(self, tracking_number: str) -> dict[str, Any]:
        if not re.fullmatch(r"\d{14}", tracking_number):
            raise ValueError("DPD tracking numbers must contain 14 digits")

        url = tracking_url(tracking_number, language="en")
        if self.flaresolverr_url:
            html = self._flaresolverr_get(url)
        else:
            try:
                html = self._direct_get(url)
            except DPDChallengeError as exc:
                raise LookupError(
                    "DPD requires a browser challenge solver; configure FLARESOLVERR_URL"
                ) from exc
        result = parse_tracking_html(html, tracking_number)
        result["tracking_url"] = tracking_url(tracking_number)
        return result

    def _direct_get(self, url: str) -> str:
        request = Request(
            url,
            headers={
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "en-CH,en;q=0.9",
                "User-Agent": (
                    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "Chrome/140 Safari/537.36"
                ),
            },
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                body = response.read(MAX_RESPONSE_BYTES + 1)
                if len(body) > MAX_RESPONSE_BYTES:
                    raise RuntimeError("DPD response was unexpectedly large")
                return body.decode(response.headers.get_content_charset() or "utf-8", "replace")
        except HTTPError as exc:
            body = exc.read(MAX_RESPONSE_BYTES).decode("utf-8", "replace")
            if exc.code == 403 and (
                exc.headers.get("cf-mitigated") == "challenge"
                or re.search(r"Just a moment|Enable JavaScript and cookies", body, re.I)
            ):
                raise DPDChallengeError("DPD returned a Cloudflare browser challenge") from exc
            raise RuntimeError(f"DPD returned HTTP {exc.code}") from exc
        except URLError as exc:
            raise RuntimeError(f"DPD is unreachable: {exc.reason}") from exc

    def _flaresolverr_get(self, url: str) -> str:
        endpoint = self.flaresolverr_url.rstrip("/")
        if not endpoint.endswith("/v1"):
            endpoint += "/v1"
        parsed = urlsplit(endpoint)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("FLARESOLVERR_URL must be an HTTP(S) URL")

        payload = json.dumps(
            {"cmd": "request.get", "url": url, "maxTimeout": self.timeout * 1000}
        ).encode()
        request = Request(
            endpoint,
            data=payload,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=self.timeout + 10) as response:
                body = response.read(MAX_RESPONSE_BYTES + 1)
        except (HTTPError, URLError) as exc:
            raise RuntimeError("FlareSolverr could not fetch DPD") from exc
        if len(body) > MAX_RESPONSE_BYTES:
            raise RuntimeError("FlareSolverr response was unexpectedly large")

        try:
            result = json.loads(body)
            solution = result["solution"]
            html = solution["response"]
            status = int(solution["status"])
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise RuntimeError("FlareSolverr returned an invalid response") from exc
        if result.get("status") != "ok" or status != 200 or not isinstance(html, str):
            raise RuntimeError("FlareSolverr did not solve the DPD page")
        return html
