"""UPS tracking through TRAWL's browser-backed public web application."""

from __future__ import annotations

import html as html_module
import json
import os
import re
from datetime import date, datetime, timedelta, timezone
from html.parser import HTMLParser
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urlsplit
from urllib.request import Request, urlopen

from redis import Redis
from redis.exceptions import RedisError


UPS_TRACKING_BASE = "https://www.ups.com/track"
UPS_STATUS_API = "https://webapis.ups.com/track/api/Track/GetStatus?loc=en_US"
DEFAULT_TIMEOUT = 90
MAX_RESPONSE_BYTES = 10_000_000
TRAWL_WEB_SESSION_KEY = "session:www.ups.com"
TRAWL_API_SESSION_KEY = "session:webapis.ups.com"


def tracking_url(tracking_number: str) -> str:
    return (
        f"{UPS_TRACKING_BASE}?loc=en_US&tracknum={quote(tracking_number)}"
        "&requester=ST/trackdetails"
    )


def _clean(value: Any) -> str:
    return " ".join(str(value or "").split())


class SessionBridge(Protocol):
    def copy(self, source: str, destination: str) -> bool: ...


class RedisSessionBridge:
    """Copy TRAWL sessions across UPS hostnames while preserving their TTL."""

    def __init__(self, redis_url: str) -> None:
        parsed = urlsplit(redis_url)
        if parsed.scheme not in {"redis", "rediss"} or not parsed.netloc:
            raise ValueError("TRAWL_REDIS_URL must be a Redis URL")
        self.client = Redis.from_url(
            redis_url,
            socket_connect_timeout=5,
            socket_timeout=5,
            health_check_interval=30,
        )

    def copy(self, source: str, destination: str) -> bool:
        try:
            return bool(self.client.copy(source, destination, replace=True))
        except RedisError as exc:
            raise RuntimeError("The TRAWL session cache is unavailable") from exc


class _UPSPageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.depth = 0
        self.ignored_depth: int | None = None
        self.captures: list[dict[str, Any]] = []
        self.values: dict[str, list[str]] = {}
        self.visible_text: list[str] = []
        self.tracking_numbers: set[str] = set()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.depth += 1
        attributes = dict(attrs)
        if tag in {"script", "style", "noscript"}:
            self.ignored_depth = self.depth
            return

        element_id = attributes.get("id") or ""
        if element_id.casefold().startswith("stapp"):
            self.captures.append({"depth": self.depth, "id": element_id, "parts": []})

        if tag == "meta" and (attributes.get("name") or "").casefold() in {
            "stapp-tracknum",
            "appvars.trk_tracknum",
        }:
            number = _clean(attributes.get("content")).upper()
            if number:
                self.tracking_numbers.add(number)

    def handle_data(self, data: str) -> None:
        if self.ignored_depth is not None:
            return
        value = _clean(data)
        if not value:
            return
        self.visible_text.append(value)
        for capture in self.captures:
            capture["parts"].append(value)

    def handle_endtag(self, tag: str) -> None:
        if self.ignored_depth == self.depth:
            self.ignored_depth = None

        for capture in [item for item in self.captures if item["depth"] == self.depth]:
            value = _clean(" ".join(capture["parts"]))
            if value:
                self.values.setdefault(capture["id"], []).append(value)
            self.captures.remove(capture)
        self.depth -= 1


class _PreformattedJSONParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.pre_depth = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "pre":
            self.pre_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag == "pre" and self.pre_depth:
            self.pre_depth -= 1

    def handle_data(self, data: str) -> None:
        if self.pre_depth:
            self.parts.append(data)


def _status(text: str, *, has_events: bool = False) -> str:
    value = text.casefold()
    if any(
        phrase in value
        for phrase in (
            "return to sender",
            "returned",
            "delivery attempted",
            "we missed you",
            "not delivered",
            "exception",
            "action required",
        )
    ):
        return "exception"
    if any(phrase in value for phrase in ("delivered", "left at")):
        return "delivered"
    if "out for delivery" in value:
        return "out_for_delivery"
    if any(
        phrase in value
        for phrase in (
            "on the way",
            "in transit",
            "we have your package",
            "first ups possession",
            "departed",
            "arrived",
            "processing at ups facility",
        )
    ) or has_events:
        return "in_transit"
    if any(
        phrase in value
        for phrase in ("label created", "manifest upload", "shipment ready for ups")
    ):
        return "pending"
    return "unknown"


def _without_icons(value: str) -> str:
    return _clean(re.sub(r"\b(?:check_circle|content_copy|expand_more|check)\b", " ", value))


def parse_tracking_html(page: str, tracking_number: str) -> dict[str, Any]:
    """Parse the rendered UPS summary as a fallback when its JSON call changes."""
    parser = _UPSPageParser()
    parser.feed(page)
    visible = " ".join(parser.visible_text)
    expected_number = tracking_number.upper()

    if expected_number not in visible.upper() and expected_number not in parser.tracking_numbers:
        raise LookupError("UPS did not return the requested parcel")
    if re.search(r"could not locate|invalid tracking|not valid tracking", visible, re.I):
        return {
            "status": "unknown",
            "last_status_text": "UPS could not locate the shipment",
            "last_update": None,
            "expected_delivery": None,
            "events": [],
        }

    status_text = _without_icons((parser.values.get("stApp_nameKey") or [""])[-1])
    progress = _without_icons((parser.values.get("stApp_shpmtProgress") or [""])[-1])
    current_status = _status(f"{status_text} {progress}")
    if not status_text:
        status_text = progress or "Tracking information received"

    location = _clean((parser.values.get("stApp_deliveredToAddress") or [""])[-1])
    if not location:
        city = _clean((parser.values.get("stApp_txtAddress") or [""])[-1])
        country = _clean((parser.values.get("stApp_txtCountry") or [""])[-1])
        location = _clean(f"{city} {country}")

    events = []
    if current_status != "unknown":
        events.append({"time": "", "location": location, "description": status_text})
    return {
        "status": current_status,
        "last_status_text": status_text,
        "last_update": None,
        "expected_delivery": None,
        "events": events,
    }


def _json_from_browser_page(page: str) -> dict[str, Any]:
    try:
        value = json.loads(page)
    except json.JSONDecodeError:
        parser = _PreformattedJSONParser()
        parser.feed(page)
        raw = html_module.unescape("".join(parser.parts)).strip()
        if not raw:
            raise RuntimeError("TRAWL did not return the UPS status response")
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RuntimeError("UPS returned an invalid tracking response") from exc
    if not isinstance(value, dict):
        raise RuntimeError("UPS returned an invalid tracking response")
    return value


def _activity_time(activity: dict[str, Any]) -> str:
    gmt_date = _clean(activity.get("gmtDate"))
    gmt_time = _clean(activity.get("gmtTime"))
    if re.fullmatch(r"\d{8}", gmt_date) and re.fullmatch(r"\d{2}:\d{2}:\d{2}", gmt_time):
        return (
            datetime.strptime(f"{gmt_date} {gmt_time}", "%Y%m%d %H:%M:%S")
            .replace(tzinfo=timezone.utc)
            .isoformat()
        )

    local_date = _clean(activity.get("date"))
    local_time = re.sub(r"\.M\.", "M", _clean(activity.get("time")), flags=re.I)
    offset = _clean(activity.get("gmtOffset"))
    if local_date and local_time and re.fullmatch(r"[+-]\d{2}:\d{2}", offset):
        try:
            parsed = datetime.strptime(f"{local_date} {local_time}", "%m/%d/%Y %I:%M %p")
            sign = 1 if offset.startswith("+") else -1
            hours, minutes = (int(part) for part in offset[1:].split(":"))
            return parsed.replace(
                tzinfo=timezone(sign * timedelta(hours=hours, minutes=minutes))
            ).isoformat()
        except ValueError:
            pass
    return _clean(f"{local_date} {local_time}")


_MONTHS = {
    "jan": 1,
    "feb": 2,
    "mar": 3,
    "apr": 4,
    "may": 5,
    "jun": 6,
    "jul": 7,
    "aug": 8,
    "sep": 9,
    "oct": 10,
    "nov": 11,
    "dec": 12,
}


def _expected_delivery(detail: dict[str, Any], today: date) -> str | None:
    value = detail.get("scheduledDeliveryDateDetail")
    if not isinstance(value, dict):
        return None
    month_key = _clean(value.get("monthCMSKey")).rsplit(".", 1)[-1].casefold()
    day_value = _clean(value.get("dayNum"))
    try:
        candidate = date(today.year, _MONTHS[month_key], int(day_value))
    except (KeyError, TypeError, ValueError):
        return None
    if candidate < today - timedelta(days=7):
        candidate = candidate.replace(year=candidate.year + 1)
    return candidate.isoformat()


def parse_tracking_response(
    payload: dict[str, Any], tracking_number: str, *, today: date | None = None
) -> dict[str, Any]:
    if str(payload.get("statusCode") or "") != "200":
        message = _clean(payload.get("statusText")) or "UPS tracking is unavailable"
        raise RuntimeError(message)

    details = payload.get("trackDetails")
    if not isinstance(details, list) or not details:
        return {
            "status": "unknown",
            "last_status_text": "UPS could not locate the shipment",
            "last_update": None,
            "expected_delivery": None,
            "events": [],
        }

    expected_number = tracking_number.upper()
    detail = next(
        (
            item
            for item in details
            if isinstance(item, dict)
            and _clean(item.get("trackingNumber") or item.get("requestedTrackingNumber")).upper()
            == expected_number
        ),
        details[0],
    )
    if not isinstance(detail, dict):
        raise RuntimeError("UPS returned an invalid tracking response")
    returned_number = _clean(detail.get("trackingNumber") or detail.get("requestedTrackingNumber"))
    if returned_number and returned_number.upper() != expected_number:
        raise LookupError("UPS did not return the requested parcel")

    error_text = _clean(detail.get("errorText"))
    if detail.get("errorCode") or error_text:
        return {
            "status": "unknown",
            "last_status_text": error_text or "UPS could not locate the shipment",
            "last_update": None,
            "expected_delivery": None,
            "events": [],
        }

    events: list[dict[str, str]] = []
    activities = detail.get("shipmentProgressActivities")
    if isinstance(activities, list):
        for activity in activities:
            if not isinstance(activity, dict):
                continue
            milestone = activity.get("milestoneName")
            milestone_name = _clean(milestone.get("name")) if isinstance(milestone, dict) else ""
            description = _clean(activity.get("activityScan")) or milestone_name
            additional = _clean(activity.get("activityAdditionalDescription"))
            if additional and additional.casefold() not in description.casefold():
                description = _clean(f"{description} — {additional}")
            if not description:
                continue
            events.append(
                {
                    "time": _activity_time(activity),
                    "location": _clean(activity.get("location")),
                    "description": description,
                }
            )

    current_milestone = detail.get("currentMilestone")
    current_name = (
        _clean(current_milestone.get("name")) if isinstance(current_milestone, dict) else ""
    )
    status_text = (
        events[0]["description"]
        if events
        else _clean(detail.get("packageStatus") or detail.get("simplifiedText"))
        or current_name
        or "Tracking information received"
    )
    progress_type = _clean(detail.get("progressBarType"))
    status_by_progress = {
        "manifestupload": "pending",
        "firstupspossession": "in_transit",
        "intransit": "in_transit",
        "outfordelivery": "out_for_delivery",
        "delivered": "delivered",
        "exception": "exception",
    }
    current_status = status_by_progress.get(progress_type.casefold()) or _status(
        " ".join(
            (
                _clean(detail.get("packageStatus")),
                _clean(detail.get("simplifiedText")),
                current_name,
                status_text,
            )
        ),
        has_events=bool(events),
    )
    return {
        "status": current_status,
        "last_status_text": status_text,
        "last_update": events[0]["time"] if events else None,
        "expected_delivery": _expected_delivery(detail, today or date.today()),
        "events": events,
    }


class UPSTracker:
    def __init__(
        self,
        trawl_url: str | None = None,
        redis_url: str | None = None,
        timeout: int = DEFAULT_TIMEOUT,
        session_bridge: SessionBridge | None = None,
    ) -> None:
        self.trawl_url = (
            trawl_url if trawl_url is not None else os.environ.get("FLARESOLVERR_URL", "")
        ).strip()
        cache_url = (
            redis_url if redis_url is not None else os.environ.get("TRAWL_REDIS_URL", "")
        ).strip()
        self.session_bridge = session_bridge or (
            RedisSessionBridge(cache_url) if cache_url else None
        )
        self.timeout = timeout
        self.xsrf_token: str | None = None

    def fetch(self, tracking_number: str) -> dict[str, Any]:
        number = tracking_number.upper()
        if not re.fullmatch(r"1Z[A-Z0-9]{16}", number):
            raise ValueError("UPS tracking numbers must start with 1Z and contain 18 characters")
        if not self.trawl_url:
            raise LookupError("UPS requires TRAWL; configure FLARESOLVERR_URL")

        if self.xsrf_token:
            try:
                return self._api_result(number, self.xsrf_token)
            except (LookupError, RuntimeError, ValueError):
                self.xsrf_token = None

        bootstrap = self._trawl_request(
            {
                "url": tracking_url(number),
                "skipHttp": True,
                "maxTier": 3,
                "maxTimeout": self.timeout * 1000,
            }
        )
        page = bootstrap.get("html")
        if not isinstance(page, str):
            raise RuntimeError("TRAWL returned an invalid UPS page")

        token = next(
            (
                unquote(str(cookie.get("value") or ""))
                for cookie in bootstrap.get("cookies") or []
                if isinstance(cookie, dict) and cookie.get("name") == "X-XSRF-TOKEN-ST"
            ),
            "",
        )
        if token and self.session_bridge:
            try:
                copied = self.session_bridge.copy(TRAWL_WEB_SESSION_KEY, TRAWL_API_SESSION_KEY)
                if copied:
                    self.xsrf_token = token
                    return self._api_result(number, token)
            except RuntimeError:
                pass

        result = parse_tracking_html(page, number)
        result["tracking_url"] = tracking_url(number)
        result["tracking_source"] = "rendered-page"
        return result

    def _api_result(self, number: str, token: str) -> dict[str, Any]:
        client_url = tracking_url(number)
        post_data = json.dumps(
            {
                "Locale": "en_US",
                "TrackingNumber": [number.lower()],
                "isBarcodeScanned": False,
                "Requester": "st/trackdetails",
                "ClientUrl": client_url,
                "returnToValue": "",
                "AssociatedBcdnNumber": None,
            },
            separators=(",", ":"),
        )
        response = self._trawl_request(
            {
                "url": UPS_STATUS_API,
                "skipHttp": True,
                "maxTier": 3,
                "maxTimeout": self.timeout * 1000,
                "method": "POST",
                "body": post_data,
                "headers": {
                    "Accept": "application/json, text/plain, */*",
                    "Content-Type": "application/json",
                    "Origin": "https://www.ups.com",
                    "Referer": client_url,
                    "X-XSRF-TOKEN": token,
                },
            }
        )
        page = response.get("html")
        if not isinstance(page, str):
            raise RuntimeError("TRAWL returned an invalid UPS status response")
        result = parse_tracking_response(_json_from_browser_page(page), number)
        result["tracking_url"] = client_url
        result["tracking_source"] = "structured-web-response"
        return result

    def _trawl_request(self, payload: dict[str, Any]) -> dict[str, Any]:
        endpoint = self.trawl_url.rstrip("/")
        for suffix in ("/v1", "/scrape"):
            if endpoint.endswith(suffix):
                endpoint = endpoint[: -len(suffix)]
        endpoint += "/scrape"
        parsed = urlsplit(endpoint)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("FLARESOLVERR_URL must be an HTTP(S) URL")

        request = Request(
            endpoint,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=self.timeout + 15) as response:
                body = response.read(MAX_RESPONSE_BYTES + 1)
        except HTTPError as exc:
            body = exc.read(MAX_RESPONSE_BYTES)
            try:
                error = json.loads(body).get("message") or json.loads(body).get("error")
            except (AttributeError, json.JSONDecodeError):
                error = None
            detail = _clean(error) or f"HTTP {exc.code}"
            raise RuntimeError(f"TRAWL could not fetch UPS: {detail}") from exc
        except URLError as exc:
            raise RuntimeError("TRAWL is unavailable while fetching UPS") from exc
        if len(body) > MAX_RESPONSE_BYTES:
            raise RuntimeError("TRAWL returned an unexpectedly large UPS response")
        try:
            result = json.loads(body)
        except json.JSONDecodeError as exc:
            raise RuntimeError("TRAWL returned an invalid UPS response") from exc
        if not isinstance(result, dict) or result.get("error"):
            raise RuntimeError(_clean(result.get("error")) or "TRAWL could not fetch UPS")
        if result.get("tier") not in {2, 3} or int(result.get("statusCode") or 0) != 200:
            raise RuntimeError("TRAWL did not solve the UPS page")
        return result
