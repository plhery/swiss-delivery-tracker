import unittest

from server.rate_limit import RateLimiter


class RateLimiterTests(unittest.TestCase):
    def test_sliding_window_reports_retry_and_recovers(self):
        now = 100.0
        limiter = RateLimiter(clock=lambda: now)

        self.assertEqual(limiter.retry_after("user:sync", limit=2, window=10), 0)
        self.assertEqual(limiter.retry_after("user:sync", limit=2, window=10), 0)
        self.assertEqual(limiter.retry_after("user:sync", limit=2, window=10), 10)

        now = 109.2
        self.assertEqual(limiter.retry_after("user:sync", limit=2, window=10), 1)
        now = 110.1
        self.assertEqual(limiter.retry_after("user:sync", limit=2, window=10), 0)

    def test_keys_are_independent_and_memory_is_bounded(self):
        limiter = RateLimiter(max_keys=2, clock=lambda: 100.0)
        for key in ("first", "second", "third"):
            self.assertEqual(limiter.retry_after(key, limit=1, window=60), 0)

        self.assertEqual(len(limiter._requests), 2)
        self.assertIn("third", limiter._requests)

    def test_rejects_invalid_configuration(self):
        limiter = RateLimiter()
        for limit, window in ((0, 1), (1, 0)):
            with self.subTest(limit=limit, window=window):
                with self.assertRaises(ValueError):
                    limiter.retry_after("key", limit=limit, window=window)


if __name__ == "__main__":
    unittest.main()
