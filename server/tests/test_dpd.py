import json
import unittest
from email.message import Message
from io import BytesIO
from unittest.mock import patch
from urllib.error import HTTPError, URLError

from server.dpd import (
    DPDAPIError,
    DPDChallengeError,
    DPDTracker,
    _DPDAPIHTTPError,
    parse_tracking_api,
    parse_tracking_html,
    tracking_url,
)

TRACKING_NUMBER = "06086514587082"
TRACKING_HTML = f"""
<!doctype html>
<html lang="en">
  <body>
    <span>{TRACKING_NUMBER}</span>
    <span class="gray-out"><span>Parcel handed to DPD</span></span>
    <ul class="content-holder-track">
      <li class="content-item-track">
        <div class="timeline-entry">
          <div class="entry-header">
            <div class="time-track">
              <span class="entry-date">15.07.2026</span>,
              <span class="entry-time">20:44</span>
            </div>
            <div class="place-track"><span>Buchs, CH</span></div>
          </div>
          <div class="entry-body"><p>Your parcel arrived at our depot</p></div>
        </div>
      </li>
      <li class="content-item-track last">
        <div class="timeline-entry">
          <div class="entry-header">
            <div class="time-track">
              <span class="entry-date">15.07.2026</span>,
              <span class="entry-time">16:34</span>
            </div>
            <div class="place-track"><span>Rothenburg, CH</span></div>
          </div>
          <div class="entry-body"><p>Your parcel is on its way</p></div>
        </div>
      </li>
    </ul>
  </body>
</html>
"""

SUMMARY_HTML = f"""
<!doctype html>
<html lang="en">
  <body>
    <span>{TRACKING_NUMBER}</span>
    <span class="gray-out"><span>Delivered</span><span>16.07.2026</span></span>
    <div class="parcelStatus">
      <div class="row"><div class="col-xs-7"><span>Parcel handed to DPD</span></div><div class="col-xs-5"><span class="bolded inlineDate">15.07.2026</span></div></div>
      <div class="row"><div class="col-xs-7"><span>In transit</span></div><div class="col-xs-5"><span class="bolded inlineDate"></span></div></div>
      <div class="row"><div class="col-xs-7"><span>At delivery centre</span></div><div class="col-xs-5"><span class="bolded inlineDate">16.07.2026</span></div></div>
      <div class="row"><div class="col-xs-7"><span>Parcel out for delivery</span></div><div class="col-xs-5"><span class="bolded inlineDate">16.07.2026</span></div></div>
      <div class="row"><div class="col-xs-7"><span>Delivered</span></div><div class="col-xs-5"><span class="bolded inlineDate">16.07.2026</span></div></div>
    </div>
  </body>
</html>
"""

API_DETAIL = {
    "parcelNumber": TRACKING_NUMBER,
    "status": {
        "status": 4,
        "description": "PARCEL_OUT_FOR_DELIVERY",
        "eventDateAndTime": "2026-07-16T08:15:00",
        "eventDateAndTimeZoneId": "Europe/Zurich",
        "city": "Buchs",
        "countryCode": "CH",
    },
    "parcelEvents": [
        {
            "date": "2026-07-16",
            "time": "08:15:00",
            "city": "Buchs",
            "country": "CH",
            "translation": "Parcel out for delivery",
            "eventTypeText": "Delivery tour - Loaded",
        },
        {
            "date": "2026-07-16",
            "time": "08:15:00",
            "city": "Buchs",
            "country": "CH",
            "translation": "Parcel out for delivery",
            "eventTypeText": "Delivery tour - Loaded",
        },
        {
            "date": "2026-07-15",
            "time": "20:44:00",
            "city": "Rothenburg",
            "depotCountry": "CH",
            "translation": "Your parcel arrived at our depot",
        },
    ],
    "deliveryDate": "2026-07-16",
    "deliveryTimeFrom": "13:30:00",
    "deliveryTimeTo": "14:30:00",
    "isPredictiveDate": True,
    # The real response also contains receiver/sender data. The parser must not
    # copy any of it into carrier_data.
    "receiver": {"name": "Private recipient", "address": {"zipCode": "8000"}},
}

API_SUMMARY = {
    "parcelNumber": TRACKING_NUMBER,
    "status": {
        "status": 1,
        "description": "PARCEL_HANDED",
        "eventDateAndTime": "2026-07-15T20:44:00",
        "eventDateAndTimeZoneId": "+02:00",
        "city": "Buchs",
        "countryCode": "CH",
    },
    "parcelHistory": [
        {
            "status": 1,
            "description": "PARCEL_HANDED",
            "eventDateAndTime": "2026-07-15T20:44:00",
            "eventDateAndTimeZoneId": "+02:00",
            "city": "Buchs",
            "countryCode": "CH",
        }
    ],
}


class FakeResponse:
    def __init__(self, body: bytes, charset: str = "utf-8") -> None:
        self.body = body
        self.headers = Message()
        self.headers["Content-Type"] = f"text/html; charset={charset}"

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self, limit: int = -1) -> bytes:
        return self.body if limit < 0 else self.body[:limit]


class DPDParserTests(unittest.TestCase):
    def test_builds_the_public_swiss_tracking_url(self):
        self.assertEqual(
            tracking_url(TRACKING_NUMBER),
            "https://www.dpdgroup.com/ch/mydpd/my-parcels/incoming"
            f"?parcelNumber={TRACKING_NUMBER}",
        )
        self.assertTrue(tracking_url(TRACKING_NUMBER, language="en").endswith("&lang=en"))

    def test_parses_verified_api_events_and_delivery_window_without_private_data(self):
        result = parse_tracking_api(
            API_DETAIL,
            TRACKING_NUMBER,
            postcode_verified=True,
        )

        self.assertEqual(result["status"], "out_for_delivery")
        self.assertEqual(result["last_status_text"], "Parcel out for delivery")
        self.assertEqual(result["last_update"], "2026-07-16T08:15:00+02:00")
        self.assertEqual(result["expected_delivery"], "2026-07-16 13:30–14:30")
        self.assertEqual(result["delivery_date"], "2026-07-16")
        self.assertEqual(result["delivery_time_from"], "13:30:00")
        self.assertEqual(result["delivery_time_to"], "14:30:00")
        self.assertTrue(result["is_predictive_date"])
        self.assertTrue(result["dpd_postcode_verified"])
        self.assertEqual(len(result["events"]), 2, "duplicate API scans are removed")
        self.assertEqual(result["events"][0]["location"], "Buchs, CH")
        self.assertNotIn("receiver", result)
        self.assertNotIn("8000", repr(result))

    def test_parses_unverified_api_summary_and_offset_timezone(self):
        result = parse_tracking_api(API_SUMMARY, TRACKING_NUMBER)

        self.assertEqual(result["status"], "in_transit")
        self.assertEqual(result["last_status_text"], "Parcel handed to DPD")
        self.assertEqual(result["last_update"], "2026-07-15T20:44:00+02:00")
        self.assertIsNone(result["expected_delivery"])
        self.assertNotIn("dpd_postcode_verified", result)

    def test_maps_api_exceptions_and_rejects_unrelated_payloads(self):
        returned = {
            **API_SUMMARY,
            "status": {**API_SUMMARY["status"], "description": "RETURN_TO_SENDER"},
            "parcelHistory": [],
        }
        self.assertEqual(
            parse_tracking_api(returned, TRACKING_NUMBER)["status"],
            "exception",
        )
        with self.assertRaisesRegex(LookupError, "requested parcel"):
            parse_tracking_api({"parcelNumber": "00000000000000"}, TRACKING_NUMBER)
        with self.assertRaisesRegex(DPDAPIError, "invalid response"):
            parse_tracking_api([], TRACKING_NUMBER)  # type: ignore[arg-type]

    def test_parses_server_rendered_timeline_events(self):
        result = parse_tracking_html(TRACKING_HTML, TRACKING_NUMBER)

        self.assertEqual(result["status"], "in_transit")
        self.assertEqual(result["last_status_text"], "Your parcel arrived at our depot")
        self.assertEqual(result["last_update"], "2026-07-15T20:44:00+02:00")
        self.assertEqual(
            result["events"],
            [
                {
                    "time": "2026-07-15T20:44:00+02:00",
                    "location": "Buchs, CH",
                    "description": "Your parcel arrived at our depot",
                },
                {
                    "time": "2026-07-15T16:34:00+02:00",
                    "location": "Rothenburg, CH",
                    "description": "Your parcel is on its way",
                },
            ],
        )

    def test_maps_delivered_and_not_found_pages(self):
        delivered = TRACKING_HTML.replace(
            "Your parcel arrived at our depot", "Your parcel has been delivered"
        )
        self.assertEqual(
            parse_tracking_html(delivered, TRACKING_NUMBER)["status"], "delivered"
        )

        failed = TRACKING_HTML.replace(
            "Your parcel arrived at our depot", "Your parcel was not delivered"
        )
        self.assertEqual(
            parse_tracking_html(failed, TRACKING_NUMBER)["status"], "exception"
        )

        missing = f"<html><body>{TRACKING_NUMBER} No parcel found</body></html>"
        self.assertEqual(
            parse_tracking_html(missing, TRACKING_NUMBER),
            {
                "status": "unknown",
                "last_status_text": "No parcel found",
                "last_update": None,
                "expected_delivery": None,
                "events": [],
            },
        )

    def test_parses_public_tracking_summary_in_latest_first_order(self):
        result = parse_tracking_html(SUMMARY_HTML, TRACKING_NUMBER)

        self.assertEqual(result["status"], "delivered")
        self.assertEqual(result["last_status_text"], "Delivered")
        self.assertEqual(result["last_update"], "2026-07-16T00:00:02+02:00")
        self.assertEqual(
            [event["description"] for event in result["events"]],
            [
                "Delivered",
                "Parcel out for delivery",
                "At delivery centre",
                "Parcel handed to DPD",
            ],
        )

    def test_rejects_challenges_and_unrelated_pages(self):
        with self.assertRaises(DPDChallengeError):
            parse_tracking_html("<title>Just a moment...</title>", TRACKING_NUMBER)
        with self.assertRaisesRegex(LookupError, "requested parcel"):
            parse_tracking_html("<html><body>Another parcel</body></html>", TRACKING_NUMBER)


class DPDTrackerTests(unittest.TestCase):
    def test_uses_verified_guest_api_before_the_web_fallback(self):
        tracker = DPDTracker(timeout=5, postcode="8000")
        with patch.object(tracker, "_api_fetch", return_value={"status": "in_transit"}):
            result = tracker.fetch(TRACKING_NUMBER)

        self.assertEqual(result["status"], "in_transit")
        self.assertEqual(result["tracking_url"], tracking_url(TRACKING_NUMBER))

    @patch("server.dpd.urlopen")
    def test_bootstraps_and_caches_the_mydpd_guest_session(self, open_url):
        open_url.side_effect = [
            FakeResponse(
                json.dumps(
                    {
                        "fid": "c123456789012345678901",
                        "authToken": {"token": "installation-token", "expiresIn": "604800s"},
                    }
                ).encode()
            ),
            FakeResponse(
                json.dumps({"entries": {"basic_dpd_token": "rotating-basic"}}).encode()
            ),
            FakeResponse(
                json.dumps({"access_token": "bearer-token", "expires_in": 3600}).encode()
            ),
            FakeResponse(json.dumps(API_DETAIL).encode()),
            FakeResponse(json.dumps(API_DETAIL).encode()),
        ]
        tracker = DPDTracker(
            timeout=5,
            postcode="8000",
            firebase_api_key="public-client-key",
        )

        first = tracker.fetch(TRACKING_NUMBER)
        second = tracker.fetch(TRACKING_NUMBER)

        self.assertEqual(first["expected_delivery"], "2026-07-16 13:30–14:30")
        self.assertTrue(first["dpd_postcode_verified"])
        self.assertEqual(second["status"], "out_for_delivery")
        self.assertEqual(open_url.call_count, 5, "bootstrap and OAuth tokens are cached")

        installation = open_url.call_args_list[0].args[0]
        remote_config = open_url.call_args_list[1].args[0]
        oauth = open_url.call_args_list[2].args[0]
        details = open_url.call_args_list[3].args[0]
        self.assertIn("firebaseinstallations.googleapis.com", installation.full_url)
        self.assertEqual(installation.get_header("X-goog-api-key"), "public-client-key")
        self.assertIn("firebaseremoteconfig.googleapis.com", remote_config.full_url)
        self.assertEqual(
            remote_config.get_header("X-goog-firebase-installations-auth"),
            "installation-token",
        )
        self.assertEqual(oauth.get_header("Authorization"), "Basic rotating-basic")
        self.assertEqual(details.get_header("Authorization"), "Bearer bearer-token")
        self.assertIn("dataForVerification=8000", details.full_url)
        self.assertIn("continueWithoutVerification=false", details.full_url)

    def test_retries_without_verification_when_postcode_does_not_match(self):
        tracker = DPDTracker(timeout=5, postcode="9999")
        with patch.object(
            tracker,
            "_details_with_fresh_token",
            side_effect=[_DPDAPIHTTPError(400), API_SUMMARY],
        ) as details:
            result = tracker._api_fetch(TRACKING_NUMBER)

        self.assertFalse(result["dpd_postcode_verified"])
        self.assertEqual(result["last_status_text"], "Parcel handed to DPD")
        self.assertEqual(details.call_args_list[0].args[1], "9999")
        self.assertIsNone(details.call_args_list[1].args[1])
        self.assertNotIn("9999", repr(result))

    def test_refreshes_an_expired_bearer_token_once(self):
        tracker = DPDTracker(timeout=5, postcode="")
        with (
            patch.object(tracker, "_access_token", side_effect=["stale", "fresh"]),
            patch.object(
                tracker,
                "_parcel_details",
                side_effect=[_DPDAPIHTTPError(401), API_SUMMARY],
            ) as details,
        ):
            result = tracker._details_with_fresh_token(TRACKING_NUMBER, None)

        self.assertEqual(result["parcelNumber"], TRACKING_NUMBER)
        self.assertEqual(details.call_args_list[1].args[2], "fresh")

    @patch("server.dpd.urlopen")
    def test_fetches_direct_html_when_cloudflare_allows_it(self, open_url):
        open_url.return_value = FakeResponse(TRACKING_HTML.encode())

        tracker = DPDTracker(timeout=5, postcode="")
        with patch.object(tracker, "_api_fetch", side_effect=DPDAPIError("offline")):
            result = tracker.fetch(TRACKING_NUMBER)

        self.assertEqual(result["status"], "in_transit")
        self.assertEqual(result["tracking_url"], tracking_url(TRACKING_NUMBER))
        request = open_url.call_args.args[0]
        self.assertIn(f"lang=en&parcelNumber={TRACKING_NUMBER}", request.full_url)
        self.assertIn("/my-parcels/track?", request.full_url)

    @patch("server.dpd.urlopen")
    def test_explains_when_a_solver_is_required(self, open_url):
        open_url.side_effect = HTTPError(
            tracking_url(TRACKING_NUMBER),
            403,
            "Forbidden",
            {"cf-mitigated": "challenge"},
            BytesIO(b"<title>Just a moment...</title>"),
        )

        tracker = DPDTracker(timeout=5, postcode="")
        with (
            patch.object(tracker, "_api_fetch", side_effect=DPDAPIError("offline")),
            self.assertRaisesRegex(LookupError, "guest API.*FLARESOLVERR_URL"),
        ):
            tracker.fetch(TRACKING_NUMBER)

    @patch("server.dpd.urlopen")
    def test_fetches_html_through_trawl(self, open_url):
        solver_body = json.dumps(
            {
                "status": "ok",
                "solution": {"status": 302, "response": TRACKING_HTML},
            }
        ).encode()
        open_url.return_value = FakeResponse(solver_body)

        tracker = DPDTracker("http://flaresolverr:8191", timeout=5, postcode="")
        with patch.object(tracker, "_api_fetch", side_effect=DPDAPIError("offline")):
            result = tracker.fetch(TRACKING_NUMBER)

        self.assertEqual(result["status"], "in_transit")
        request = open_url.call_args.args[0]
        self.assertEqual(request.full_url, "http://flaresolverr:8191/v1")
        payload = json.loads(request.data)
        self.assertEqual(payload["cmd"], "request.get")
        self.assertIn(f"lang=en&parcelNumber={TRACKING_NUMBER}", payload["url"])
        self.assertIn("/my-parcels/track?", payload["url"])

    def test_validates_tracking_numbers_and_solver_urls(self):
        with self.assertRaisesRegex(ValueError, "14 digits"):
            DPDTracker(postcode="").fetch("not-a-number")
        with self.assertRaisesRegex(ValueError, "exactly 4 digits"):
            DPDTracker(postcode="80A4").fetch(TRACKING_NUMBER)

        tracker = DPDTracker("flaresolverr:8191", postcode="")
        with (
            patch.object(tracker, "_api_fetch", side_effect=DPDAPIError("offline")),
            self.assertRaisesRegex(ValueError, "HTTP"),
        ):
            tracker.fetch(TRACKING_NUMBER)

    @patch("server.dpd.urlopen")
    def test_wraps_guest_api_transport_and_json_errors(self, open_url):
        tracker = DPDTracker(timeout=5, postcode="")
        open_url.side_effect = URLError("DNS failed")
        with self.assertRaisesRegex(DPDAPIError, "DNS failed"):
            tracker._request_json("https://example.test", data=b"", headers={})

        open_url.side_effect = None
        open_url.return_value = FakeResponse(b"not json")
        with self.assertRaisesRegex(DPDAPIError, "invalid JSON"):
            tracker._request_json("https://example.test", data=b"", headers={})

        open_url.side_effect = HTTPError(
            "https://example.test",
            429,
            "Too many requests",
            {},
            BytesIO(b'{"message":"slow down"}'),
        )
        with self.assertRaises(_DPDAPIHTTPError) as raised:
            tracker._request_json("https://example.test", data=b"", headers={})
        self.assertEqual(raised.exception.status, 429)
        self.assertEqual(raised.exception.payload["message"], "slow down")


if __name__ == "__main__":
    unittest.main()
