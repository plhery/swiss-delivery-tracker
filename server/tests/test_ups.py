from datetime import date
from email.message import Message
import html
import json
import unittest
from unittest.mock import patch

from server.ups import (
    TRAWL_API_SESSION_KEY,
    TRAWL_WEB_SESSION_KEY,
    UPSTracker,
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


class FakeBridge:
    def __init__(self, copied=True):
        self.copied = copied
        self.calls = []

    def copy(self, source, destination):
        self.calls.append((source, destination))
        return self.copied


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
    @patch("server.ups.urlopen")
    def test_fetches_structured_history_and_reuses_the_api_session(self, open_url):
        bridge = FakeBridge()
        browser_json = f"<html><body><pre>{html.escape(json.dumps(api_payload()))}</pre></body></html>"
        bootstrap = trawl_response(
            TRACKING_HTML,
            cookies=[{"name": "X-XSRF-TOKEN-ST", "value": "token%2Dvalue"}],
        )
        api_response = trawl_response(browser_json, tier=2)
        open_url.side_effect = [
            FakeResponse(bootstrap),
            FakeResponse(api_response),
            FakeResponse(api_response),
        ]
        tracker = UPSTracker(
            "http://flaresolverr:8191",
            redis_url="",
            timeout=5,
            session_bridge=bridge,
        )

        first = tracker.fetch(TRACKING_NUMBER)
        second = tracker.fetch(TRACKING_NUMBER)

        self.assertEqual(first["tracking_source"], "structured-web-response")
        self.assertEqual(second["status"], "delivered")
        self.assertEqual(len(first["events"]), 2)
        self.assertEqual(
            bridge.calls,
            [(TRAWL_WEB_SESSION_KEY, TRAWL_API_SESSION_KEY)],
        )
        self.assertEqual(open_url.call_count, 3)

        bootstrap_request = open_url.call_args_list[0].args[0]
        bootstrap_payload = json.loads(bootstrap_request.data)
        self.assertTrue(bootstrap_payload["skipHttp"])
        self.assertEqual(bootstrap_payload["maxTier"], 3)

        api_request = open_url.call_args_list[1].args[0]
        api_request_payload = json.loads(api_request.data)
        self.assertEqual(api_request_payload["method"], "POST")
        self.assertEqual(api_request_payload["headers"]["X-XSRF-TOKEN"], "token-value")
        self.assertEqual(
            json.loads(api_request_payload["body"])["TrackingNumber"],
            [TRACKING_NUMBER.lower()],
        )

    @patch("server.ups.urlopen")
    def test_falls_back_to_rendered_page_without_session_bridge(self, open_url):
        open_url.return_value = FakeResponse(trawl_response(TRACKING_HTML))
        tracker = UPSTracker("http://flaresolverr:8191/v1", redis_url="", timeout=5)

        result = tracker.fetch(TRACKING_NUMBER)

        self.assertEqual(result["status"], "delivered")
        self.assertEqual(result["tracking_source"], "rendered-page")
        self.assertEqual(open_url.call_args.args[0].full_url, "http://flaresolverr:8191/scrape")

    def test_validates_configuration_and_tracking_numbers(self):
        with self.assertRaisesRegex(ValueError, "18 characters"):
            UPSTracker("http://trawl", redis_url="").fetch("not-ups")
        with self.assertRaisesRegex(LookupError, "FLARESOLVERR_URL"):
            UPSTracker("", redis_url="").fetch(TRACKING_NUMBER)
        with self.assertRaisesRegex(ValueError, "HTTP"):
            UPSTracker("trawl:8191", redis_url="").fetch(TRACKING_NUMBER)


if __name__ == "__main__":
    unittest.main()
