import unittest
from unittest.mock import patch

from server.planzer_shared import (
    PlanzerSharedTracker,
    is_planzer_shared_tracking_number,
    parse_tracking_html,
    validate_planzer_shared_url,
)


TRACKING_NUMBER = "999.90.03316119"
ACCESS_KEY = "abcdefghijklmnopqrstuvwxyzABCDEFGH"
TRACKING_URL = (
    f"https://trackandtrace.planzergroup.com/shared/sendungen/{TRACKING_NUMBER}"
    f"?accessKey={ACCESS_KEY}&brand=planzer&culture=de-ch"
)

TRACKING_HTML = """
<html><body>
  <time datetime="2026-07-17">17.07.2026</time>
  <div class="row">
    <div class="col-xs-5 text-center">
      <span class="glyphicon text-primary tooltip-target" title="Erfasst"></span>
      <time datetime="2026-07-15T06:45:05+00:00">15.07.2026</time>
    </div>
    <div class="col-xs-5 text-center">
      <span class="glyphicon text-primary tooltip-target" data-original-title="Abholung"></span>
      <time datetime="2026-07-16">16.07.2026</time>
    </div>
    <div class="col-xs-4 text-center">
      <span class="glyphicon text-primary tooltip-target" data-original-title="Umschlaglager"></span>
      <time datetime="2026-07-16T18:06:14+00:00">16.07.2026</time>
    </div>
    <div class="col-xs-5 text-center">
      <span class="glyphicon text-primary tooltip-target" title="In Auslieferung"></span>
      <time datetime="2026-07-16T18:06:14+00:00">16.07.2026</time>
    </div>
    <div class="col-xs-5 text-center">
      <span class="glyphicon text-pale tooltip-target" data-original-title="Ausgeliefert"></span>
    </div>
  </div>
</body></html>
"""


class FakeResponse:
    def __init__(self, body: str):
        self.body = body.encode()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self, _limit=-1):
        return self.body


class PlanzerSharedTests(unittest.TestCase):
    def test_recognizes_and_validates_the_capability_url(self):
        self.assertTrue(is_planzer_shared_tracking_number(TRACKING_NUMBER))
        self.assertTrue(is_planzer_shared_tracking_number("9999003316119"))
        self.assertFalse(is_planzer_shared_tracking_number("91346097020038089282"))
        self.assertEqual(validate_planzer_shared_url(TRACKING_URL, TRACKING_NUMBER), TRACKING_URL)

    def test_rejects_unsafe_incomplete_and_mismatched_urls(self):
        invalid = (
            TRACKING_URL.replace("trackandtrace.planzergroup.com", "example.test"),
            TRACKING_URL.replace(f"accessKey={ACCESS_KEY}", "brand=planzer"),
            TRACKING_URL.replace(TRACKING_NUMBER, "999.90.00000000"),
            TRACKING_URL + "#fragment",
        )
        for url in invalid:
            with self.subTest(url=url), self.assertRaises(ValueError):
                validate_planzer_shared_url(url, TRACKING_NUMBER)

    def test_parses_reached_steps_and_expected_delivery(self):
        result = parse_tracking_html(TRACKING_HTML, TRACKING_NUMBER)

        self.assertEqual(result["status"], "out_for_delivery")
        self.assertEqual(result["last_status_text"], "In Auslieferung")
        self.assertEqual(result["last_update"], "2026-07-16T18:06:14+00:00")
        self.assertEqual(result["expected_delivery"], "2026-07-17")
        self.assertEqual(result["events"][0]["description"], "Out for delivery")
        self.assertEqual(result["events"][-1]["description"], "Shipment registered by Planzer")

    def test_rejects_pages_without_a_tracking_route(self):
        with self.assertRaisesRegex(ValueError, "did not return tracking details"):
            parse_tracking_html("<html><body>Link expired</body></html>", TRACKING_NUMBER)

    @patch("server.planzer_shared.urllib.request.urlopen")
    def test_fetches_the_validated_page(self, urlopen):
        urlopen.return_value = FakeResponse(TRACKING_HTML)

        result = PlanzerSharedTracker(timeout=7).fetch(TRACKING_NUMBER, TRACKING_URL)

        self.assertEqual(result["status"], "out_for_delivery")
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, TRACKING_URL)
        self.assertEqual(urlopen.call_args.kwargs["timeout"], 7)


if __name__ == "__main__":
    unittest.main()
