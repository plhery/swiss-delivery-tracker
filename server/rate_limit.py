"""Small in-memory sliding-window limiter for one-process deployments."""

from __future__ import annotations

import math
import threading
import time
from collections import deque
from collections.abc import Callable


class RateLimiter:
    def __init__(
        self,
        *,
        max_keys: int = 4096,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.max_keys = max(1, max_keys)
        self.clock = clock
        self._requests: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def retry_after(self, key: str, *, limit: int, window: float) -> int:
        """Record an allowed request, or return seconds until one is allowed."""
        if limit < 1 or window <= 0:
            raise ValueError("Rate limits require a positive count and window")
        now = self.clock()
        cutoff = now - window
        with self._lock:
            requests = self._requests.setdefault(key, deque())
            while requests and requests[0] <= cutoff:
                requests.popleft()
            if len(requests) >= limit:
                return max(1, math.ceil(requests[0] + window - now))
            requests.append(now)
            if len(self._requests) > self.max_keys:
                self._prune(cutoff, keep=key)
        return 0

    def _prune(self, cutoff: float, *, keep: str) -> None:
        for key in list(self._requests):
            if key == keep:
                continue
            requests = self._requests[key]
            while requests and requests[0] <= cutoff:
                requests.popleft()
            if not requests:
                del self._requests[key]
            if len(self._requests) <= self.max_keys:
                return
        while len(self._requests) > self.max_keys:
            oldest = next(key for key in self._requests if key != keep)
            del self._requests[oldest]
