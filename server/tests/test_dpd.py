from email.message import Message
from io import BytesIO
import json
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

from server.dpd import DPDChallengeError, DPDTracker, parse_tracking_html, tracking_url


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
    @patch("server.dpd.urlopen")
    def test_fetches_direct_html_when_cloudflare_allows_it(self, open_url):
        open_url.return_value = FakeResponse(TRACKING_HTML.encode())

        result = DPDTracker(timeout=5).fetch(TRACKING_NUMBER)

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

        with self.assertRaisesRegex(LookupError, "FLARESOLVERR_URL"):
            DPDTracker(timeout=5).fetch(TRACKING_NUMBER)

    @patch("server.dpd.urlopen")
    def test_fetches_html_through_trawl(self, open_url):
        solver_body = json.dumps(
            {
                "status": "ok",
                "solution": {"status": 302, "response": TRACKING_HTML},
            }
        ).encode()
        open_url.return_value = FakeResponse(solver_body)

        result = DPDTracker("http://flaresolverr:8191", timeout=5).fetch(TRACKING_NUMBER)

        self.assertEqual(result["status"], "in_transit")
        request = open_url.call_args.args[0]
        self.assertEqual(request.full_url, "http://flaresolverr:8191/v1")
        payload = json.loads(request.data)
        self.assertEqual(payload["cmd"], "request.get")
        self.assertIn(f"lang=en&parcelNumber={TRACKING_NUMBER}", payload["url"])
        self.assertIn("/my-parcels/track?", payload["url"])

    def test_validates_tracking_numbers_and_solver_urls(self):
        with self.assertRaisesRegex(ValueError, "14 digits"):
            DPDTracker().fetch("not-a-number")
        with self.assertRaisesRegex(ValueError, "HTTP"):
            DPDTracker("flaresolverr:8191").fetch(TRACKING_NUMBER)


if __name__ == "__main__":
    unittest.main()
