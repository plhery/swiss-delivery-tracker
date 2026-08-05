"""DPD Switzerland tracking through myDPD's guest API and public page."""

from __future__ import annotations

import base64
import json
import os
import re
import secrets
import threading
import time
from datetime import datetime
from html.parser import HTMLParser
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


DPD_TRACKING_BASE = "https://www.dpdgroup.com/ch/mydpd/my-parcels/incoming"
DPD_FETCH_BASE = "https://www.dpdgroup.com/ch/mydpd/my-parcels/track"
DPD_API_BASE = "https://www.dpdgroup.com/concept/webservice"
DPD_OAUTH_URL = f"{DPD_API_BASE}/oauth/token?grant_type=client_credentials"
DPD_DETAILS_BASE = f"{DPD_API_BASE}/v10/parcels/details"

# Public, app-restricted identifiers shipped in myDPD Android 3.79.14. The
# rotating API credential itself is fetched from Remote Config and kept only in
# memory; it is never written to the repository, logs or carrier_data.
DPD_FIREBASE_PROJECT = "consignee-portal"
DPD_FIREBASE_PROJECT_NUMBER = "959401347543"
DPD_FIREBASE_APP_ID = "1:959401347543:android:8d1a84133332291109e392"
DPD_FIREBASE_API_KEY = "AIzaSyDHMkUNUyUwFrQzKJhdC_J-L7QEwNUzwrc"
DPD_ANDROID_PACKAGE = "com.dpdgroup.chatbot.lemny.prod"
DPD_ANDROID_CERT = "3872ACD98DE975F69C68CAF5119A5A1B2024B873"
DPD_CLIENT_VERSION = "3.79.14"
DPD_INSTALLATIONS_URL = (
    "https://firebaseinstallations.googleapis.com/v1/projects/"
    f"{DPD_FIREBASE_PROJECT}/installations"
)
DPD_REMOTE_CONFIG_URL = (
    "https://firebaseremoteconfig.googleapis.com/v1/projects/"
    f"{DPD_FIREBASE_PROJECT_NUMBER}/namespaces/firebase:fetch"
)
DEFAULT_TIMEOUT = 90
MAX_RESPONSE_BYTES = 10_000_000
ZURICH = ZoneInfo("Europe/Zurich")


class DPDChallengeError(RuntimeError):
    """The DPD page returned a Cloudflare browser challenge."""


class DPDAPIError(RuntimeError):
    """The undocumented myDPD guest API could not provide tracking data."""


class _DPDAPIHTTPError(DPDAPIError):
    def __init__(self, status: int, payload: dict[str, Any] | None = None) -> None:
        super().__init__(f"DPD guest API returned HTTP {status}")
        self.status = status
        self.payload = payload or {}


def tracking_url(tracking_number: str, *, language: str | None = None) -> str:
    url = f"{DPD_TRACKING_BASE}?parcelNumber={quote(tracking_number)}"
    return f"{url}&lang={quote(language)}" if language else url


def _fetch_url(tracking_number: str) -> str:
    return f"{DPD_FETCH_BASE}?lang=en&parcelNumber={quote(tracking_number)}"


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
        self.summary_events: list[dict[str, str]] = []
        self.summary_depth: int | None = None
        self.summary_row: tuple[int, list[str]] | None = None

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

        if tag == "div" and "parcelStatus" in classes:
            self.summary_depth = self.depth
        elif (
            tag == "div"
            and self.summary_depth is not None
            and self.summary_row is None
            and "row" in classes
        ):
            self.summary_row = (self.depth, [])

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
        if self.summary_row is not None:
            self.summary_row[1].append(value)
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

        if self.summary_row is not None and self.summary_row[0] == self.depth:
            _, parts = self.summary_row
            if parts:
                date = next(
                    (part for part in parts[1:] if re.fullmatch(r"\d{2}\.\d{2}\.\d{4}", part)),
                    "",
                )
                self.summary_events.append(
                    {"description": parts[0], "date": date, "clock": "", "location": ""}
                )
            self.summary_row = None

        if self.summary_depth == self.depth:
            self.summary_depth = None

        self.depth -= 1


def _event_time(date: str, clock: str) -> str:
    value = f"{date} {clock}".strip()
    formats = (
        ("%d.%m.%Y %H:%M:%S", "%d.%m.%Y %H:%M", "%d.%m.%Y")
        if clock
        else ("%d.%m.%Y",)
    )
    for date_format in formats:
        try:
            return datetime.strptime(value, date_format).replace(tzinfo=ZURICH).isoformat()
        except ValueError:
            continue
    return value


def _summary_events(events: list[dict[str, str]]) -> list[dict[str, str]]:
    """Keep dated summary steps and make their documented order deterministic."""
    offsets: dict[str, int] = {}
    dated: list[dict[str, str]] = []
    for event in events:
        date = event.get("date", "")
        if not date:
            continue
        offset = offsets.get(date, 0)
        offsets[date] = offset + 1
        dated.append(
            {
                **event,
                "clock": f"00:{offset // 60:02d}:{offset % 60:02d}",
            }
        )
    return list(reversed(dated))


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


_API_DESCRIPTION_LABELS = {
    "ORDER_CREATED": "Order created",
    "PARCEL_HANDED": "Parcel handed to DPD",
    "IN_TRANSIT": "Your parcel is on its way",
    "AT_DELIVERY_CENTER": "At delivery center",
    "RETURN_TO_SENDER": "Return to sender",
    "PARCEL_OUT_FOR_DELIVERY": "Parcel out for delivery",
    "AVAILABLE_FOR_COLLECTION": "Ready for collection",
    "UNSUCCESSFUL_DELIVERY_ATTEMPT": "Unsuccessful delivery attempt",
    "DELIVERED": "Delivered",
    "OTHER": "Other tracking update",
}


def _api_description(value: Any) -> str:
    key = _clean(str(value or "")).upper().replace(" ", "_")
    return _API_DESCRIPTION_LABELS.get(key, key.replace("_", " ").title())


def _api_status(description: Any, status_text: str, has_events: bool) -> str:
    key = str(description or "").upper()
    if key == "DELIVERED":
        return "delivered"
    if key in {"PARCEL_OUT_FOR_DELIVERY", "AVAILABLE_FOR_COLLECTION"}:
        return "out_for_delivery"
    if key in {"RETURN_TO_SENDER", "UNSUCCESSFUL_DELIVERY_ATTEMPT"}:
        return "exception"
    if key == "ORDER_CREATED":
        return "pending"
    if key in {"PARCEL_HANDED", "IN_TRANSIT", "AT_DELIVERY_CENTER"}:
        return "in_transit"
    return _status(status_text, has_events)


def _api_location(event: dict[str, Any]) -> str:
    city = _clean(str(event.get("city") or ""))
    country = _clean(
        str(
            event.get("country")
            or event.get("countryCode")
            or event.get("depotCountry")
            or ""
        )
    )
    if city and country and city.casefold() != country.casefold():
        return f"{city}, {country}"
    return city or country


def _api_event_time(date: Any, clock: Any = "", timezone_name: Any = None) -> str:
    date_text = _clean(str(date or ""))
    clock_text = _clean(str(clock or ""))
    value = f"{date_text}T{clock_text}" if clock_text else date_text
    if not value:
        return ""
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return f"{date_text} {clock_text}".strip()
    if parsed.tzinfo is None:
        zone = ZURICH
        zone_name = str(timezone_name or "")
        if re.fullmatch(r"[+-]\d{2}:\d{2}", zone_name):
            try:
                return datetime.fromisoformat(f"{value}{zone_name}").isoformat()
            except ValueError:
                pass
        elif zone_name:
            try:
                zone = ZoneInfo(zone_name)
            except ZoneInfoNotFoundError:
                pass
        parsed = parsed.replace(tzinfo=zone)
    return parsed.isoformat()


def _expected_delivery(payload: dict[str, Any]) -> str | None:
    raw_date = _clean(str(payload.get("deliveryDate") or ""))
    if not raw_date:
        return None
    date = raw_date[:10] if re.match(r"\d{4}-\d{2}-\d{2}", raw_date) else raw_date

    def short_time(value: Any) -> str:
        match = re.match(r"(\d{2}:\d{2})", _clean(str(value or "")))
        return match.group(1) if match else ""

    time_from = short_time(payload.get("deliveryTimeFrom"))
    time_to = short_time(payload.get("deliveryTimeTo"))
    if time_from and time_to:
        return f"{date} {time_from}–{time_to}"
    if time_from or time_to:
        return f"{date} {time_from or time_to}"
    return date


def parse_tracking_api(
    payload: dict[str, Any],
    tracking_number: str,
    *,
    postcode_verified: bool | None = None,
) -> dict[str, Any]:
    """Normalize a privacy-filtered subset of myDPD's parcel response."""
    if not isinstance(payload, dict):
        raise DPDAPIError("DPD guest API returned an invalid response")
    parcel_number = str(payload.get("parcelNumber") or payload.get("shipmentId") or "")
    if parcel_number != tracking_number:
        raise LookupError("DPD did not return the requested parcel")

    events: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    raw_events = payload.get("parcelEvents")
    if isinstance(raw_events, list):
        for raw in raw_events:
            if not isinstance(raw, dict):
                continue
            description = _clean(
                str(
                    raw.get("translation")
                    or raw.get("eventTypeText")
                    or _api_description(raw.get("eventType"))
                )
            )
            event = {
                "time": _api_event_time(raw.get("date"), raw.get("time")),
                "location": _api_location(raw),
                "description": description or "Tracking update",
            }
            identity = (event["time"], event["location"], event["description"])
            if identity not in seen:
                seen.add(identity)
                events.append(event)

    if not events:
        history = payload.get("parcelHistory")
        if isinstance(history, list):
            for raw in history:
                if not isinstance(raw, dict):
                    continue
                event = {
                    "time": _api_event_time(
                        raw.get("eventDateAndTime"),
                        timezone_name=raw.get("eventDateAndTimeZoneId"),
                    ),
                    "location": _api_location(raw),
                    "description": _api_description(raw.get("description")),
                }
                identity = (event["time"], event["location"], event["description"])
                if identity not in seen:
                    seen.add(identity)
                    events.append(event)

    current = payload.get("status")
    current = current if isinstance(current, dict) else {}
    current_description = current.get("description")
    status_text = (
        events[0]["description"]
        if events
        else _api_description(current_description) or "Tracking information received"
    )
    last_update = (
        events[0]["time"]
        if events
        else _api_event_time(
            current.get("eventDateAndTime"),
            timezone_name=current.get("eventDateAndTimeZoneId"),
        )
        or None
    )
    delivery_date = _clean(str(payload.get("deliveryDate") or "")) or None
    delivery_time_from = _clean(str(payload.get("deliveryTimeFrom") or "")) or None
    delivery_time_to = _clean(str(payload.get("deliveryTimeTo") or "")) or None
    result: dict[str, Any] = {
        "status": _api_status(current_description, status_text, bool(events)),
        "last_status_text": status_text,
        "last_update": last_update,
        "expected_delivery": _expected_delivery(payload),
        "events": events,
        "source": "mydpd_guest_api",
        "delivery_date": delivery_date,
        "delivery_time_from": delivery_time_from,
        "delivery_time_to": delivery_time_to,
        "is_predictive_date": bool(payload.get("isPredictiveDate")),
    }
    if postcode_verified is not None:
        result["dpd_postcode_verified"] = postcode_verified
    return result


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

    raw_events = parser.events or _summary_events(parser.summary_events)
    events = [
        {
            "time": _event_time(event.get("date", ""), event.get("clock", "")),
            "location": event.get("location", ""),
            "description": event["description"],
        }
        for event in raw_events
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
    def __init__(
        self,
        flaresolverr_url: str | None = None,
        timeout: int = DEFAULT_TIMEOUT,
        postcode: str | None = None,
        firebase_api_key: str | None = None,
    ) -> None:
        self.flaresolverr_url = (
            flaresolverr_url
            if flaresolverr_url is not None
            else os.environ.get("FLARESOLVERR_URL", "")
        ).strip()
        self.postcode = (
            postcode if postcode is not None else os.environ.get("DPD_POSTCODE", "")
        ).strip()
        self.firebase_api_key = (
            firebase_api_key
            if firebase_api_key is not None
            else os.environ.get("DPD_FIREBASE_API_KEY", DPD_FIREBASE_API_KEY)
        ).strip()
        self.timeout = timeout
        self._token_lock = threading.Lock()
        self._access_token_value = ""
        self._access_token_expires_at = 0.0
        self._basic_token = ""
        self._installation_fid = ""
        self._installation_token = ""
        self._installation_expires_at = 0.0

    def fetch(self, tracking_number: str) -> dict[str, Any]:
        if not re.fullmatch(r"\d{14}", tracking_number):
            raise ValueError("DPD tracking numbers must contain 14 digits")
        if self.postcode and not re.fullmatch(r"\d{4}", self.postcode):
            raise ValueError("DPD_POSTCODE must contain exactly 4 digits")

        api_error: Exception | None = None
        try:
            result = self._api_fetch(tracking_number)
        except (DPDAPIError, LookupError) as exc:
            api_error = exc
            result = self._page_fetch(tracking_number, api_error)
        result["tracking_url"] = tracking_url(tracking_number)
        return result

    def _page_fetch(
        self, tracking_number: str, api_error: Exception | None = None
    ) -> dict[str, Any]:
        url = _fetch_url(tracking_number)
        if self.flaresolverr_url:
            html = self._flaresolverr_get(url)
        else:
            try:
                html = self._direct_get(url)
            except DPDChallengeError as exc:
                prefix = "DPD guest API is unavailable and " if api_error else "DPD "
                raise LookupError(
                    f"{prefix}the web fallback requires a browser challenge solver; "
                    "configure FLARESOLVERR_URL"
                ) from exc
        return parse_tracking_html(html, tracking_number)

    def _api_fetch(self, tracking_number: str) -> dict[str, Any]:
        postcode_verified: bool | None = None
        try:
            payload = self._details_with_fresh_token(tracking_number, self.postcode or None)
            if self.postcode:
                postcode_verified = True
        except _DPDAPIHTTPError as exc:
            if not self.postcode or exc.status != 400:
                raise
            payload = self._details_with_fresh_token(tracking_number, None)
            postcode_verified = False
        return parse_tracking_api(
            payload,
            tracking_number,
            postcode_verified=postcode_verified,
        )

    def _details_with_fresh_token(
        self, tracking_number: str, postcode: str | None
    ) -> dict[str, Any]:
        for attempt in range(2):
            token = self._access_token()
            try:
                return self._parcel_details(tracking_number, postcode, token)
            except _DPDAPIHTTPError as exc:
                if exc.status != 401 or attempt:
                    raise
                self._invalidate_access_token()
        raise DPDAPIError("DPD guest API authentication failed")

    def _parcel_details(
        self, tracking_number: str, postcode: str | None, access_token: str
    ) -> dict[str, Any]:
        params = {
            "parcelType": "INCOMING",
            "businessUnit": "DPD-CH",
            "lang": "en",
            "continueWithoutVerification": "false" if postcode else "true",
        }
        if postcode:
            params["dataForVerification"] = postcode
        return self._request_json(
            f"{DPD_DETAILS_BASE}/{quote(tracking_number)}?{urlencode(params)}",
            data=b"",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": f"myDPD/{DPD_CLIENT_VERSION} (Android)",
            },
        )

    def _access_token(self) -> str:
        now = time.monotonic()
        if self._access_token_value and now < self._access_token_expires_at:
            return self._access_token_value
        with self._token_lock:
            now = time.monotonic()
            if self._access_token_value and now < self._access_token_expires_at:
                return self._access_token_value
            payload: dict[str, Any] | None = None
            for attempt in range(2):
                basic_token = self._basic_token or self._fetch_basic_token()
                try:
                    payload = self._request_json(
                        DPD_OAUTH_URL,
                        data=b"",
                        headers={
                            "Authorization": f"Basic {basic_token}",
                            "Accept": "application/json",
                            "Content-Type": "application/json",
                            "User-Agent": f"myDPD/{DPD_CLIENT_VERSION} (Android)",
                        },
                    )
                    break
                except _DPDAPIHTTPError as exc:
                    if exc.status not in {400, 401} or attempt:
                        raise
                    self._basic_token = ""
            token = str((payload or {}).get("access_token") or "")
            if not token:
                raise DPDAPIError("DPD guest API did not issue an access token")
            expires_in = self._duration_seconds((payload or {}).get("expires_in"), 3600)
            self._access_token_value = token
            self._access_token_expires_at = time.monotonic() + max(1, expires_in - 60)
            return token

    def _fetch_basic_token(self) -> str:
        if not self.firebase_api_key:
            raise DPDAPIError("DPD Firebase client configuration is missing")
        for attempt in range(2):
            fid, installation_token = self._firebase_installation()
            try:
                payload = self._request_json(
                    DPD_REMOTE_CONFIG_URL,
                    data={
                        "appId": DPD_FIREBASE_APP_ID,
                        "appInstanceId": fid,
                        "appInstanceIdToken": installation_token,
                        "languageCode": "en-US",
                        "countryCode": "CH",
                        "platformVersion": "36",
                        "appVersion": DPD_CLIENT_VERSION,
                        "packageName": DPD_ANDROID_PACKAGE,
                        "sdkVersion": "22.1.2",
                        "analyticsUserProperties": {},
                    },
                    headers=self._firebase_headers(
                        {"X-Goog-Firebase-Installations-Auth": installation_token}
                    ),
                )
                entries = payload.get("entries")
                token = str(
                    entries.get("basic_dpd_token")
                    if isinstance(entries, dict)
                    else ""
                )
                if not token:
                    raise DPDAPIError("myDPD Remote Config omitted its guest credential")
                self._basic_token = token
                return token
            except _DPDAPIHTTPError as exc:
                if exc.status not in {401, 403} or attempt:
                    raise
                self._invalidate_installation()
        raise DPDAPIError("myDPD Remote Config authentication failed")

    def _firebase_installation(self) -> tuple[str, str]:
        now = time.monotonic()
        if (
            self._installation_fid
            and self._installation_token
            and now < self._installation_expires_at
        ):
            return self._installation_fid, self._installation_token

        raw_fid = bytearray(secrets.token_bytes(17))
        raw_fid[0] = 0x70 | (raw_fid[0] & 0x0F)
        fid = base64.urlsafe_b64encode(bytes(raw_fid)).decode().rstrip("=")[:22]
        payload = self._request_json(
            DPD_INSTALLATIONS_URL,
            data={
                "fid": fid,
                "appId": DPD_FIREBASE_APP_ID,
                "authVersion": "FIS_v2",
                "sdkVersion": "a:18.0.0",
            },
            headers=self._firebase_headers(),
        )
        auth = payload.get("authToken")
        auth = auth if isinstance(auth, dict) else {}
        token = str(auth.get("token") or "")
        if not token:
            raise DPDAPIError("Firebase did not issue a myDPD installation token")
        expires_in = self._duration_seconds(auth.get("expiresIn"), 604800)
        self._installation_fid = str(payload.get("fid") or fid)
        self._installation_token = token
        self._installation_expires_at = time.monotonic() + max(1, expires_in - 300)
        return self._installation_fid, token

    def _firebase_headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "X-Goog-Api-Key": self.firebase_api_key,
            "X-Android-Package": DPD_ANDROID_PACKAGE,
            "X-Android-Cert": DPD_ANDROID_CERT,
        }
        headers.update(extra or {})
        return headers

    @staticmethod
    def _duration_seconds(value: Any, default: int) -> int:
        match = re.fullmatch(r"(\d+)s?", str(value or ""))
        return int(match.group(1)) if match else default

    def _invalidate_access_token(self) -> None:
        self._access_token_value = ""
        self._access_token_expires_at = 0.0

    def _invalidate_installation(self) -> None:
        self._installation_fid = ""
        self._installation_token = ""
        self._installation_expires_at = 0.0

    def _request_json(
        self,
        url: str,
        *,
        data: dict[str, Any] | bytes,
        headers: dict[str, str],
    ) -> dict[str, Any]:
        body = json.dumps(data).encode() if isinstance(data, dict) else data
        request = Request(url, data=body, headers=headers, method="POST")
        try:
            with urlopen(request, timeout=self.timeout) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
        except HTTPError as exc:
            raw = exc.read(MAX_RESPONSE_BYTES + 1)
            payload: dict[str, Any] | None = None
            try:
                decoded = json.loads(raw)
                payload = decoded if isinstance(decoded, dict) else None
            except (UnicodeDecodeError, json.JSONDecodeError):
                pass
            raise _DPDAPIHTTPError(exc.code, payload) from exc
        except URLError as exc:
            raise DPDAPIError(f"DPD guest API is unreachable: {exc.reason}") from exc
        if len(raw) > MAX_RESPONSE_BYTES:
            raise DPDAPIError("DPD guest API response was unexpectedly large")
        try:
            payload = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise DPDAPIError("DPD guest API returned invalid JSON") from exc
        if not isinstance(payload, dict):
            raise DPDAPIError("DPD guest API returned an invalid response")
        return payload

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
            raise RuntimeError("The browser challenge solver could not fetch DPD") from exc
        if len(body) > MAX_RESPONSE_BYTES:
            raise RuntimeError("The browser challenge solver response was unexpectedly large")

        try:
            result = json.loads(body)
            solution = result["solution"]
            html = solution["response"]
            status = int(solution["status"])
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise RuntimeError("The browser challenge solver returned an invalid response") from exc
        if (
            result.get("status") != "ok"
            or status not in {200, 302}
            or not isinstance(html, str)
        ):
            raise RuntimeError("The browser challenge solver did not solve the DPD page")
        return html
