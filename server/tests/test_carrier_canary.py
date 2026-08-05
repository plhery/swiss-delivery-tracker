import io
import unittest
from contextlib import redirect_stdout
from unittest import mock

from server.carrier_canary import (
    CanaryTarget,
    automatic_canary_targets,
    main,
    probe_target,
    run_canaries,
)


class CarrierCanaryTests(unittest.TestCase):
    def test_every_automatic_carrier_has_a_privacy_safe_target(self):
        definitions = {
            "automatic": {
                "displayName": "Automatic",
                "tracking": {"mode": "automatic"},
                "canaryUrl": "https://carrier.example/public/",
            },
            "manual": {
                "displayName": "Manual",
                "tracking": {"mode": "link-only"},
            },
        }

        targets = automatic_canary_targets(definitions)

        self.assertEqual(targets, (CanaryTarget(
            "automatic", "Automatic", "https://carrier.example/public/"
        ),))

    def test_rejects_secret_bearing_or_missing_canary_urls(self):
        for url in (
            "https://carrier.example/?tracking=secret",
            "https://user:password@carrier.example/",
            "http://carrier.example/",
        ):
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, "unsafe"):
                automatic_canary_targets({
                    "carrier": {
                        "displayName": "Carrier",
                        "tracking": {"mode": "automatic"},
                        "canaryUrl": url,
                    }
                })

    def test_retries_server_errors_and_accepts_front_door_responses(self):
        target = CanaryTarget("carrier", "Carrier", "https://carrier.example/")
        statuses = iter((503, 403))

        result = probe_target(target, attempts=2, fetch_status=lambda _url, _timeout: next(statuses))

        self.assertTrue(result.healthy)
        self.assertEqual(result.status, 403)

    def test_reports_failure_without_printing_urls(self):
        target = CanaryTarget("carrier", "Carrier", "https://carrier.example/private/path")
        output = io.StringIO()

        with redirect_stdout(output):
            with mock.patch(
                "server.carrier_canary.automatic_canary_targets", return_value=(target,)
            ), mock.patch(
                "server.carrier_canary.run_canaries",
                return_value=(probe_target(
                    target,
                    attempts=1,
                    fetch_status=lambda _url, _timeout: 503,
                ),),
            ):
                exit_code = main([])

        self.assertEqual(exit_code, 1)
        self.assertIn("carrier.example HTTP 503", output.getvalue())
        self.assertNotIn("/private/path", output.getvalue())

    def test_runs_each_target(self):
        targets = (
            CanaryTarget("one", "One", "https://one.example/"),
            CanaryTarget("two", "Two", "https://two.example/"),
        )

        results = run_canaries(targets, attempts=1, fetch_status=lambda _url, _timeout: 204)

        self.assertEqual([result.target.carrier_id for result in results], ["one", "two"])
        self.assertTrue(all(result.healthy for result in results))


if __name__ == "__main__":
    unittest.main()
