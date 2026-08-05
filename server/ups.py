"""UPS tracking through its public web application with browser fallback."""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from http.cookiejar import Cookie, CookieJar
from http.cookies import CookieError, SimpleCookie
from threading import RLock
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urlsplit
from urllib.request import Request, urlopen


UPS_TRACKING_BASE = "https://www.ups.com/track"
UPS_STATUS_API = "https://webapis.ups.com/track/api/Track/GetStatus?loc=en_US"
DEFAULT_TIMEOUT = 90
DEFAULT_DIRECT_TIMEOUT = 20
MAX_RESPONSE_BYTES = 10_000_000
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:147.0) "
    "Gecko/20100101 Firefox/147.0"
)


def tracking_url(tracking_number: str) -> str:
    return (
        f"{UPS_TRACKING_BASE}?loc=en_US&tracknum={quote(tracking_number)}"
        "&requester=ST/trackdetails"
    )


def _clean(value: Any) -> str:
    return " ".join(str(value or "").split())


class _UPSSessionRejected(RuntimeError):
    """UPS returned a response that indicates the web session is not trusted."""


class _UPSHTTPSession:
    """An in-memory UPS cookie jar used for direct page and API requests."""

    def __init__(self, timeout: int, runner: Callable[..., Any] | None = None) -> None:
        self.timeout = timeout
        self.user_agent = DEFAULT_USER_AGENT
        self.cookies = CookieJar()
        self.runner = runner or subprocess.run

    def fetch_page(self, url: str) -> str:
        body = self._curl(
            url,
            "UPS tracking page",
            headers={
                "Accept": (
                    "text/html,application/xhtml+xml,application/xml;q=0.9,"
                    "*/*;q=0.8"
                ),
                "Accept-Language": "en-US,en;q=0.9",
                "DNT": "1",
                "Pragma": "no-cache",
                "Sec-Fetch-Dest": "document",
                "Sec-Fetch-Mode": "navigate",
                "Sec-Fetch-Site": "none",
                "Sec-GPC": "1",
                "Upgrade-Insecure-Requests": "1",
                "User-Agent": self.user_agent,
            },
            rejection_statuses={401, 403, 419, 429},
        )
        return body.decode(errors="replace")

    def fetch_status(self, tracking_number: str) -> dict[str, Any]:
        token = self.xsrf_token()
        if not token:
            raise _UPSSessionRejected("The UPS session has no XSRF token")

        client_url = tracking_url(tracking_number)
        post_data = json.dumps(
            {
                "Locale": "en_US",
                "TrackingNumber": [tracking_number.lower()],
                "isBarcodeScanned": False,
                "Requester": "st/trackdetails",
                "ClientUrl": client_url,
                "returnToValue": "",
                "AssociatedBcdnNumber": None,
            },
            separators=(",", ":"),
        ).encode()
        raw = self._curl(
            UPS_STATUS_API,
            "UPS status API",
            headers={
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "en-US,en;q=0.9",
                "Content-Type": "application/json",
                "DNT": "1",
                "Origin": "https://www.ups.com",
                "Referer": client_url,
                "Sec-Fetch-Dest": "empty",
                "Sec-Fetch-Mode": "cors",
                "Sec-Fetch-Site": "same-site",
                "Sec-GPC": "1",
                "User-Agent": self.user_agent,
                "X-XSRF-TOKEN": token,
            },
            method="POST",
            body=post_data,
            rejection_statuses={401, 403, 419, 429},
        )
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise _UPSSessionRejected("UPS returned an invalid tracking response") from exc
        if not isinstance(payload, dict):
            raise _UPSSessionRejected("UPS returned an invalid tracking response")
        return payload

    def seed_browser_cookies(
        self, cookies: list[dict[str, Any]], user_agent: Any = None
    ) -> None:
        """Import a TRAWL browser jar without depending on its Redis cache."""
        browser_user_agent = _clean(user_agent)
        if browser_user_agent:
            self.user_agent = browser_user_agent
        self.cookies.clear()

        for item in cookies:
            if not isinstance(item, dict):
                continue
            name = _clean(item.get("name"))
            value = str(item.get("value") or "")
            domain = _clean(item.get("domain")).lower()
            if not name or not self._valid_cookie_domain(domain):
                continue

            path = _clean(item.get("path")) or "/"
            if not path.startswith("/"):
                path = "/"
            raw_expires = item.get("expires")
            try:
                expires_value = float(raw_expires)
            except (TypeError, ValueError):
                expires_value = -1
            self._set_cookie(
                name=name,
                value=value,
                domain=domain,
                domain_specified=True,
                path=path,
                secure=bool(item.get("secure")),
                expires=int(expires_value) if expires_value > 0 else None,
                http_only=bool(item.get("httpOnly")),
            )

    def xsrf_token(self) -> str:
        cookie_header = self._cookie_header(UPS_STATUS_API)
        for part in cookie_header.split(";"):
            name, separator, value = part.strip().partition("=")
            if separator and name == "X-XSRF-TOKEN-ST":
                return unquote(value)
        return ""

    def _curl(
        self,
        url: str,
        description: str,
        *,
        headers: dict[str, str],
        method: str = "GET",
        body: bytes | None = None,
        rejection_statuses: set[int] | None = None,
    ) -> bytes:
        request_headers = dict(headers)
        cookie_header = self._cookie_header(url)
        if cookie_header:
            request_headers["Cookie"] = cookie_header

        connect_timeout = max(1, min(self.timeout, 10))
        config = [
            "silent",
            "show-error",
            "location",
            "compressed",
            "http1.1",
            f"connect-timeout = {connect_timeout}",
            f"max-time = {self.timeout}",
            f"max-filesize = {MAX_RESPONSE_BYTES}",
            'dump-header = "/dev/stderr"',
            'write-out = "%{stderr}__UPS_CURL_STATUS__:%{http_code}"',
            f"url = {self._curl_value(url)}",
        ]
        if method != "GET":
            config.append(f"request = {self._curl_value(method)}")
        for name, value in request_headers.items():
            header = f"{name}: {value}"
            if "\r" in header or "\n" in header:
                raise ValueError("UPS request headers must not contain newlines")
            config.append(f"header = {self._curl_value(header)}")
        if body is not None:
            config.append(f"data-binary = {self._curl_value(body.decode())}")

        try:
            response = self.runner(
                ["curl", "--config", "-"],
                input=("\n".join(config) + "\n").encode(),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=self.timeout + 5,
                check=False,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as exc:
            raise RuntimeError(f"{description} is unavailable") from exc
        response_body = bytes(response.stdout or b"")
        response_headers = bytes(response.stderr or b"")
        if response.returncode != 0:
            raise RuntimeError(f"{description} is unavailable")
        statuses = re.findall(rb"__UPS_CURL_STATUS__:(\d{3})", response_headers)
        if not statuses:
            raise RuntimeError(f"{description} returned an invalid HTTP response")
        status = int(statuses[-1])
        self._store_response_cookies(response_headers, url)
        if status in (rejection_statuses or set()):
            raise _UPSSessionRejected(f"{description} returned HTTP {status}")
        if not 200 <= status < 300:
            raise RuntimeError(f"{description} returned HTTP {status}")
        if len(response_body) > MAX_RESPONSE_BYTES:
            raise RuntimeError(f"{description} returned an unexpectedly large response")
        return response_body

    def _store_response_cookies(self, response_headers: bytes, url: str) -> None:
        host = (urlsplit(url).hostname or "").lower()
        if not self._valid_cookie_domain(host):
            return
        now = int(time.time())
        for raw_line in response_headers.splitlines():
            if not raw_line.lower().startswith(b"set-cookie:"):
                continue
            raw_cookie = raw_line.split(b":", 1)[1].strip().decode("latin-1")
            parsed = SimpleCookie()
            try:
                parsed.load(raw_cookie)
            except CookieError:
                continue
            for morsel in parsed.values():
                domain_attribute = _clean(morsel["domain"]).lower()
                domain = domain_attribute or host
                if not self._valid_cookie_domain(domain):
                    continue
                path = _clean(morsel["path"]) or "/"
                expires = self._cookie_expiry(morsel["max-age"], morsel["expires"], now)
                if expires is not None and expires <= now:
                    self._remove_cookie(morsel.key, domain, path)
                    continue
                self._set_cookie(
                    name=morsel.key,
                    value=morsel.value,
                    domain=domain,
                    domain_specified=bool(domain_attribute),
                    path=path,
                    secure=bool(morsel["secure"]),
                    expires=expires,
                    http_only=bool(morsel["httponly"]),
                )
        self.cookies.clear_expired_cookies()

    @staticmethod
    def _cookie_expiry(max_age: str, expires: str, now: int) -> int | None:
        if max_age:
            try:
                return now + int(max_age)
            except ValueError:
                pass
        if expires:
            try:
                parsed = parsedate_to_datetime(expires)
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                return int(parsed.timestamp())
            except (TypeError, ValueError, OverflowError):
                pass
        return None

    def _set_cookie(
        self,
        *,
        name: str,
        value: str,
        domain: str,
        domain_specified: bool,
        path: str,
        secure: bool,
        expires: int | None,
        http_only: bool,
    ) -> None:
        self._remove_cookie(name, domain, path)
        rest = {"HttpOnly": None} if http_only else {}
        self.cookies.set_cookie(
            Cookie(
                version=0,
                name=name,
                value=value,
                port=None,
                port_specified=False,
                domain=domain,
                domain_specified=domain_specified,
                domain_initial_dot=domain.startswith("."),
                path=path,
                path_specified=True,
                secure=secure,
                expires=expires,
                discard=expires is None,
                comment=None,
                comment_url=None,
                rest=rest,
                rfc2109=False,
            )
        )

    def _remove_cookie(self, name: str, domain: str, path: str) -> None:
        bare_domain = domain.lstrip(".")
        for cookie in list(self.cookies):
            if (
                cookie.name == name
                and cookie.domain.lstrip(".") == bare_domain
                and cookie.path == path
            ):
                self.cookies.clear(cookie.domain, cookie.path, cookie.name)

    def _cookie_header(self, url: str) -> str:
        request = Request(url)
        self.cookies.add_cookie_header(request)
        return request.get_header("Cookie") or ""

    @staticmethod
    def _valid_cookie_domain(domain: str) -> bool:
        bare_domain = domain.lstrip(".")
        return bare_domain == "ups.com" or bare_domain.endswith(".ups.com")

    @staticmethod
    def _curl_value(value: str) -> str:
        escaped = (
            value.replace("\\", "\\\\")
            .replace('"', '\\"')
            .replace("\r", "\\r")
            .replace("\n", "\\n")
        )
        return f'"{escaped}"'


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
        timeout: int = DEFAULT_TIMEOUT,
        direct_timeout: int = DEFAULT_DIRECT_TIMEOUT,
        session_factory: Callable[[int], _UPSHTTPSession] | None = None,
    ) -> None:
        self.trawl_url = (
            trawl_url if trawl_url is not None else os.environ.get("FLARESOLVERR_URL", "")
        ).strip()
        self.timeout = timeout
        self.direct_timeout = max(1, min(timeout, direct_timeout))
        self.session_factory = session_factory or _UPSHTTPSession
        self.session: _UPSHTTPSession | None = None
        self.lock = RLock()

    def fetch(self, tracking_number: str) -> dict[str, Any]:
        number = tracking_number.upper()
        if not re.fullmatch(r"1Z[A-Z0-9]{16}", number):
            raise ValueError("UPS tracking numbers must start with 1Z and contain 18 characters")
        with self.lock:
            return self._fetch_locked(number)

    def _fetch_locked(self, number: str) -> dict[str, Any]:
        if self.session:
            try:
                return self._api_result(number, self.session)
            except _UPSSessionRejected:
                # UPS may refresh XSRF and Akamai cookies on the tracking page.
                # Retry that lightweight refresh before asking for a new browser.
                try:
                    self.session.fetch_page(tracking_url(number))
                    return self._api_result(number, self.session)
                except _UPSSessionRejected:
                    self.session = None

        direct_session = self.session_factory(self.direct_timeout)
        direct_page: str | None = None
        direct_error: Exception | None = None
        try:
            direct_page = direct_session.fetch_page(tracking_url(number))
            if not direct_session.xsrf_token():
                raise RuntimeError("UPS challenged the direct tracking session")
            result = self._api_result(number, direct_session)
            self.session = direct_session
            return result
        except (LookupError, RuntimeError, ValueError) as exc:
            direct_error = exc

        if not self.trawl_url:
            if direct_page:
                try:
                    return self._rendered_result(direct_page, number)
                except (LookupError, RuntimeError, ValueError):
                    pass
            raise LookupError(
                "UPS challenged direct tracking; configure FLARESOLVERR_URL "
                "for browser fallback"
            ) from direct_error

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
        browser_cookies = bootstrap.get("cookies")
        if not isinstance(browser_cookies, list):
            browser_cookies = []

        browser_session = self.session_factory(self.direct_timeout)
        browser_session.seed_browser_cookies(
            browser_cookies,
            bootstrap.get("userAgent"),
        )
        browser_error: Exception | None = None
        if browser_session.xsrf_token():
            try:
                result = self._api_result(number, browser_session)
                self.session = browser_session
                return result
            except _UPSSessionRejected as exc:
                browser_error = exc
            except (LookupError, RuntimeError, ValueError) as exc:
                # The browser session itself may still be useful when UPS's
                # structured endpoint has an unrelated transient failure.
                self.session = browser_session
                browser_error = exc

        try:
            return self._rendered_result(page, number)
        except (LookupError, RuntimeError, ValueError) as exc:
            if browser_error:
                raise RuntimeError(
                    "UPS rejected the browser-established session"
                ) from browser_error
            raise RuntimeError("TRAWL did not establish a usable UPS session") from exc

    def _api_result(self, number: str, session: _UPSHTTPSession) -> dict[str, Any]:
        result = parse_tracking_response(session.fetch_status(number), number)
        result["tracking_url"] = tracking_url(number)
        result["tracking_source"] = "structured-web-response"
        return result

    @staticmethod
    def _rendered_result(page: str, number: str) -> dict[str, Any]:
        result = parse_tracking_html(page, number)
        result["tracking_url"] = tracking_url(number)
        result["tracking_source"] = "rendered-page"
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
