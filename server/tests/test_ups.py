import json
import unittest
from datetime import date
from email.message import Message
from unittest.mock import patch

from server.ups import (
    UPSTracker,
    _UPSHTTPSession,
    _UPSSessionRejected,
    parse_tracking_html,
    parse_tracking_response,
    tracking_url,
)

TRACKING_NUMBER = "1Z999AA10123456784"
TRACKING_HTML = f"""
<!doctype html>
<html>
  <head><meta name="stapp-tracknum" content="{TRACKING_NUMBER}"></head>
  <body>
    <span id="stApp_nameKey">Delivered <span>check_circle</span></span>
    <p id="stApp_deliveredToAddress">ZUERICH CH</p>
    <ups-ac-progress-bar id="stApp_shpmtProgress">
      Label Created completed We Have Your Package completed On the Way completed Delivered active
    </ups-ac-progress-bar>
  </body>
</html>
"""


def api_payload(progress="Delivered"):
    return {
        "statusCode": "200",
        "statusText": "Successful",
        "trackDetails": [
            {
                "trackingNumber": TRACKING_NUMBER,
                "errorCode": None,
                "errorText": None,
                "packageStatus": progress,
                "progressBarType": progress.replace(" ", ""),
                "currentMilestone": {"name": progress},
                "scheduledDeliveryDateDetail": None,
                "shipmentProgressActivities": [
                    {
                        "date": "08/04/2026",
                        "time": "2:38 P.M.",
                        "location": "ZUERICH, CH",
                        "activityScan": "Delivered",
                        "gmtDate": "20260804",
                        "gmtTime": "12:38:28",
                        "gmtOffset": "+02:00",
                    },
                    {
                        "date": "08/04/2026",
                        "time": "8:14 A.M.",
                        "location": "BULACH, CH",
                        "activityScan": "Out For Delivery",
                        "gmtDate": "20260804",
                        "gmtTime": "06:14:39",
                        "gmtOffset": "+02:00",
                    },
                ],
            }
        ],
    }


def trawl_response(page, *, cookies=None, tier=3):
    return json.dumps(
        {
            "url": "https://example.test",
            "html": page,
            "cookies": cookies or [],
            "userAgent": "browser",
            "statusCode": 200,
            "tier": tier,
            "sessionCached": tier == 2,
            "timings": [],
            "totalMs": 10,
        }
    ).encode()


class FakeResponse:
    def __init__(self, body):
        self.body = body
        self.headers = Message()
        self.headers["Content-Type"] = "application/json"

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self, limit=-1):
        return self.body if limit < 0 else self.body[:limit]


class FakeSession:
    def __init__(self, *, token="", page=TRACKING_HTML, status_outputs=()):
        self.token = token
        self.page = page
        self.status_outputs = list(status_outputs)
        self.page_calls = []
        self.status_calls = []
        self.seed_calls = []

    def fetch_page(self, url):
        self.page_calls.append(url)
        if isinstance(self.page, Exception):
            raise self.page
        return self.page

    def fetch_status(self, tracking_number):
        self.status_calls.append(tracking_number)
        if not self.status_outputs:
            raise AssertionError("Unexpected UPS status request")
        output = self.status_outputs.pop(0)
        if isinstance(output, Exception):
            raise output
        return output

    def seed_browser_cookies(self, cookies, user_agent=None):
        self.seed_calls.append((cookies, user_agent))
        self.token = next(
            (
                str(cookie.get("value") or "").replace("%2D", "-")
                for cookie in cookies
                if isinstance(cookie, dict) and cookie.get("name") == "X-XSRF-TOKEN-ST"
            ),
            "",
        )

    def xsrf_token(self):
        return self.token


class SessionFactory:
    def __init__(self, *sessions):
        self.sessions = list(sessions)
        self.calls = []

    def __call__(self, timeout):
        self.calls.append(timeout)
        if not self.sessions:
            raise AssertionError("Unexpected UPS session creation")
        return self.sessions.pop(0)


class FakeCurlResult:
    def __init__(self, stdout=b"", stderr=b"", returncode=0):
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode


def curl_result(body=b"", *, status=200, headers=()):
    response_headers = [f"HTTP/1.1 {status} Test"]
    response_headers.extend(headers)
    response_headers.append("")
    response_headers.append(f"__UPS_CURL_STATUS__:{status}")
    return FakeCurlResult(
        stdout=body,
        stderr="\r\n".join(response_headers).encode(),
    )


class FakeRunner:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, command, **kwargs):
        self.calls.append((command, kwargs))
        if not self.responses:
            raise AssertionError("Unexpected curl request")
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


class UPSParserTests(unittest.TestCase):
    def test_builds_tracking_url_and_parses_rendered_fallback(self):
        self.assertEqual(
            tracking_url(TRACKING_NUMBER),
            "https://www.ups.com/track?loc=en_US"
            f"&tracknum={TRACKING_NUMBER}&requester=ST/trackdetails",
        )
        result = parse_tracking_html(TRACKING_HTML, TRACKING_NUMBER)
        self.assertEqual(result["status"], "delivered")
        self.assertEqual(result["last_status_text"], "Delivered")
        self.assertEqual(result["events"][0]["location"], "ZUERICH CH")

    def test_rendered_fallback_handles_not_found_and_unrelated_pages(self):
        missing = TRACKING_HTML.replace("Delivered", "Invalid tracking number")
        self.assertEqual(parse_tracking_html(missing, TRACKING_NUMBER)["status"], "unknown")
        with self.assertRaisesRegex(LookupError, "requested parcel"):
            parse_tracking_html("<html>another shipment</html>", TRACKING_NUMBER)

    def test_parses_full_api_history_and_utc_times(self):
        result = parse_tracking_response(api_payload(), TRACKING_NUMBER)
        self.assertEqual(result["status"], "delivered")
        self.assertEqual(result["last_status_text"], "Delivered")
        self.assertEqual(result["last_update"], "2026-08-04T12:38:28+00:00")
        self.assertEqual(len(result["events"]), 2)
        self.assertEqual(result["events"][1]["description"], "Out For Delivery")

    def test_maps_expected_delivery_and_provider_errors(self):
        payload = api_payload("InTransit")
        detail = payload["trackDetails"][0]
        detail["scheduledDeliveryDateDetail"] = {
            "monthCMSKey": "cms.stapp.sep",
            "dayNum": "10",
        }
        self.assertEqual(
            parse_tracking_response(payload, TRACKING_NUMBER, today=date(2026, 8, 4))[
                "expected_delivery"
            ],
            "2026-09-10",
        )

        detail["errorCode"] = "250002"
        detail["errorText"] = "Tracking information is not available"
        missing = parse_tracking_response(payload, TRACKING_NUMBER)
        self.assertEqual(missing["status"], "unknown")
        self.assertEqual(missing["events"], [])

        with self.assertRaisesRegex(RuntimeError, "Unavailable"):
            parse_tracking_response(
                {"statusCode": "500", "statusText": "Unavailable"}, TRACKING_NUMBER
            )


class UPSTrackerTests(unittest.TestCase):
    def test_direct_http_session_succeeds_without_trawl_and_is_reused(self):
        direct = FakeSession(
            token="direct-token",
            status_outputs=[api_payload(), api_payload()],
        )
        factory = SessionFactory(direct)
        tracker = UPSTracker("", timeout=90, session_factory=factory)

        first = tracker.fetch(TRACKING_NUMBER)
        second = tracker.fetch(TRACKING_NUMBER)

        self.assertEqual(first["tracking_source"], "structured-web-response")
        self.assertEqual(second["status"], "delivered")
        self.assertEqual(len(first["events"]), 2)
        self.assertEqual(factory.calls, [20])
        self.assertEqual(direct.page_calls, [tracking_url(TRACKING_NUMBER)])
        self.assertEqual(direct.status_calls, [TRACKING_NUMBER, TRACKING_NUMBER])

    def test_rejected_cached_session_is_refreshed_without_browser(self):
        direct = FakeSession(
            token="direct-token",
            status_outputs=[
                api_payload(),
                _UPSSessionRejected("session rejected"),
                api_payload("InTransit"),
            ],
        )
        tracker = UPSTracker("", timeout=5, session_factory=SessionFactory(direct))

        tracker.fetch(TRACKING_NUMBER)
        refreshed = tracker.fetch(TRACKING_NUMBER)

        self.assertEqual(refreshed["status"], "in_transit")
        self.assertEqual(
            direct.page_calls,
            [tracking_url(TRACKING_NUMBER), tracking_url(TRACKING_NUMBER)],
        )
        self.assertIs(tracker.session, direct)

    def test_transient_cached_api_failure_keeps_the_existing_session(self):
        direct = FakeSession(
            token="direct-token",
            status_outputs=[api_payload(), RuntimeError("temporary outage")],
        )
        tracker = UPSTracker("", timeout=5, session_factory=SessionFactory(direct))
        tracker.fetch(TRACKING_NUMBER)

        with self.assertRaisesRegex(RuntimeError, "temporary outage"):
            tracker.fetch(TRACKING_NUMBER)

        self.assertEqual(direct.page_calls, [tracking_url(TRACKING_NUMBER)])
        self.assertIs(tracker.session, direct)

    @patch("server.ups.urlopen")
    def test_browser_bootstraps_full_cookie_jar_then_direct_api_is_reused(self, open_url):
        direct = FakeSession(token="", page="<html>Akamai challenge</html>")
        browser = FakeSession(status_outputs=[api_payload(), api_payload()])
        factory = SessionFactory(direct, browser)
        cookies = [
            {
                "name": "X-XSRF-TOKEN-ST",
                "value": "token%2Dvalue",
                "domain": ".ups.com",
                "path": "/",
                "secure": True,
            },
            {
                "name": "ak_bmsc",
                "value": "akamai-value",
                "domain": ".ups.com",
                "path": "/",
                "secure": True,
            },
        ]
        bootstrap = trawl_response(
            TRACKING_HTML,
            cookies=cookies,
        )
        open_url.return_value = FakeResponse(bootstrap)
        tracker = UPSTracker(
            "http://flaresolverr:8191",
            timeout=5,
            session_factory=factory,
        )

        first = tracker.fetch(TRACKING_NUMBER)
        second = tracker.fetch(TRACKING_NUMBER)

        self.assertEqual(first["tracking_source"], "structured-web-response")
        self.assertEqual(second["status"], "delivered")
        self.assertEqual(len(first["events"]), 2)
        self.assertEqual(open_url.call_count, 1)
        self.assertEqual(browser.status_calls, [TRACKING_NUMBER, TRACKING_NUMBER])
        self.assertEqual(browser.seed_calls, [(cookies, "browser")])
        self.assertIs(tracker.session, browser)

        bootstrap_request = open_url.call_args.args[0]
        bootstrap_payload = json.loads(bootstrap_request.data)
        self.assertTrue(bootstrap_payload["skipHttp"])
        self.assertEqual(bootstrap_payload["maxTier"], 3)
        self.assertNotIn("method", bootstrap_payload)

    @patch("server.ups.urlopen")
    def test_falls_back_to_rendered_page_when_browser_api_is_rejected(self, open_url):
        direct = FakeSession(token="", page="<html>Akamai challenge</html>")
        browser = FakeSession(status_outputs=[_UPSSessionRejected("API rejected")])
        cookies = [
            {
                "name": "X-XSRF-TOKEN-ST",
                "value": "browser-token",
                "domain": ".ups.com",
            }
        ]
        open_url.return_value = FakeResponse(trawl_response(TRACKING_HTML, cookies=cookies))
        tracker = UPSTracker(
            "http://flaresolverr:8191/v1",
            timeout=5,
            session_factory=SessionFactory(direct, browser),
        )

        result = tracker.fetch(TRACKING_NUMBER)

        self.assertEqual(result["status"], "delivered")
        self.assertEqual(result["tracking_source"], "rendered-page")
        self.assertEqual(open_url.call_args.args[0].full_url, "http://flaresolverr:8191/scrape")
        self.assertIsNone(tracker.session)

    def test_browser_cookie_jar_is_imported_for_direct_api_requests(self):
        runner = FakeRunner(curl_result(json.dumps(api_payload()).encode()))
        cookies = [
            {
                "name": "X-XSRF-TOKEN-ST",
                "value": "token%2Dvalue",
                "domain": ".ups.com",
                "path": "/",
                "secure": True,
                "httpOnly": False,
            },
            {
                "name": "ak_bmsc",
                "value": "akamai-value",
                "domain": ".ups.com",
                "path": "/",
                "secure": True,
                "httpOnly": True,
            },
            {
                "name": "ignored",
                "value": "external-value",
                "domain": ".example.com",
            },
        ]
        session = _UPSHTTPSession(7, runner=runner)
        session.seed_browser_cookies(cookies, "TRAWL browser agent")

        payload = session.fetch_status(TRACKING_NUMBER)

        self.assertEqual(payload["statusCode"], "200")
        self.assertEqual(session.xsrf_token(), "token-value")
        self.assertEqual(
            {cookie.name for cookie in session.cookies},
            {"X-XSRF-TOKEN-ST", "ak_bmsc"},
        )
        command, options = runner.calls[0]
        config = options["input"].decode()
        self.assertEqual(command, ["curl", "--config", "-"])
        self.assertEqual(options["timeout"], 12)
        self.assertIn('header = "User-Agent: TRAWL browser agent"', config)
        self.assertIn('header = "X-XSRF-TOKEN: token-value"', config)
        self.assertIn("ak_bmsc=akamai-value", config)
        self.assertIn(TRACKING_NUMBER.lower(), config)

    def test_direct_page_cookies_are_kept_for_the_status_call(self):
        page_response = curl_result(
            b"<html>UPS</html>",
            headers=(
                "Set-Cookie: X-XSRF-TOKEN-ST=direct%2Dtoken; Domain=.ups.com; "
                "Path=/; Secure",
                "Set-Cookie: _abck=direct-akamai; Domain=.ups.com; Path=/; "
                "Secure; HttpOnly",
            ),
        )
        api_response = curl_result(json.dumps(api_payload()).encode())
        runner = FakeRunner(page_response, api_response)
        session = _UPSHTTPSession(5, runner=runner)

        session.fetch_page(tracking_url(TRACKING_NUMBER))
        payload = session.fetch_status(TRACKING_NUMBER)

        self.assertEqual(session.xsrf_token(), "direct-token")
        self.assertEqual(payload["statusCode"], "200")
        api_config = runner.calls[1][1]["input"].decode()
        self.assertIn("X-XSRF-TOKEN-ST=direct%2Dtoken", api_config)
        self.assertIn("_abck=direct-akamai", api_config)

    def test_invalid_direct_api_response_is_rejected(self):
        runner = FakeRunner(curl_result(b"<html>challenge</html>"))
        session = _UPSHTTPSession(5, runner=runner)
        session.seed_browser_cookies(
            [
                {
                    "name": "X-XSRF-TOKEN-ST",
                    "value": "token",
                    "domain": ".ups.com",
                }
            ]
        )
        with self.assertRaisesRegex(RuntimeError, "invalid tracking response"):
            session.fetch_status(TRACKING_NUMBER)

    def test_validates_configuration_and_tracking_numbers(self):
        with self.assertRaisesRegex(ValueError, "18 characters"):
            UPSTracker("http://trawl", session_factory=SessionFactory()).fetch("not-ups")

        challenged = FakeSession(token="", page="<html>Akamai challenge</html>")
        with self.assertRaisesRegex(LookupError, "FLARESOLVERR_URL"):
            UPSTracker("", session_factory=SessionFactory(challenged)).fetch(TRACKING_NUMBER)

        challenged = FakeSession(token="", page="<html>Akamai challenge</html>")
        with self.assertRaisesRegex(ValueError, "HTTP"):
            UPSTracker(
                "trawl:8191",
                session_factory=SessionFactory(challenged),
            ).fetch(TRACKING_NUMBER)


if __name__ == "__main__":
    unittest.main()
