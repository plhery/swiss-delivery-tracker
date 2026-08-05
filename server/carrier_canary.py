"""Probe public carrier front doors without using real shipment identifiers."""

from __future__ import annotations

import argparse
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

from .api_contract import CARRIER_CAPABILITIES

DEFAULT_TIMEOUT = 15.0
DEFAULT_ATTEMPTS = 2
MAX_WORKERS = 6


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """A redirect proves reachability; do not follow it into a slower challenge page."""

    def redirect_request(
        self,
        request: urllib.request.Request,
        file_pointer: Any,
        code: int,
        message: str,
        headers: Any,
        new_url: str,
    ) -> None:
        return None


@dataclass(frozen=True)
class CanaryTarget:
    carrier_id: str
    display_name: str
    url: str

    @property
    def hostname(self) -> str:
        return urlparse(self.url).hostname or "invalid-host"


@dataclass(frozen=True)
class CanaryResult:
    target: CanaryTarget
    status: int | None
    error: str | None = None

    @property
    def healthy(self) -> bool:
        return self.status is not None and self.status < 500


def automatic_canary_targets(
    definitions: Mapping[str, Mapping[str, Any]] = CARRIER_CAPABILITIES,
) -> tuple[CanaryTarget, ...]:
    targets = []
    for carrier_id, definition in definitions.items():
        tracking = definition.get("tracking")
        if not isinstance(tracking, Mapping) or tracking.get("mode") != "automatic":
            continue
        display_name = definition.get("displayName")
        url = definition.get("canaryUrl")
        if not isinstance(display_name, str) or not isinstance(url, str):
            raise ValueError(f"Automatic carrier {carrier_id} has no canary metadata")
        parsed = urlparse(url)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError(f"Automatic carrier {carrier_id} has an unsafe canary URL")
        targets.append(CanaryTarget(carrier_id, display_name, url))
    return tuple(targets)


def request_status(url: str, timeout: float) -> int:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "text/html,application/json;q=0.8,*/*;q=0.5",
            "User-Agent": "SwissDeliveryTracker-Canary/1.0",
        },
    )
    try:
        opener = urllib.request.build_opener(_NoRedirectHandler())
        with opener.open(request, timeout=timeout) as response:
            return int(response.status)
    except urllib.error.HTTPError as exc:
        return exc.code


def probe_target(
    target: CanaryTarget,
    timeout: float = DEFAULT_TIMEOUT,
    attempts: int = DEFAULT_ATTEMPTS,
    fetch_status: Callable[[str, float], int] = request_status,
) -> CanaryResult:
    if attempts < 1:
        raise ValueError("Canary attempts must be positive")
    last_status: int | None = None
    last_error: str | None = None
    for _attempt in range(attempts):
        try:
            last_status = fetch_status(target.url, timeout)
            last_error = None
            if last_status < 500:
                break
        except (OSError, TimeoutError, urllib.error.URLError) as exc:
            last_status = None
            last_error = exc.__class__.__name__
    return CanaryResult(target, last_status, last_error)


def run_canaries(
    targets: tuple[CanaryTarget, ...],
    timeout: float = DEFAULT_TIMEOUT,
    attempts: int = DEFAULT_ATTEMPTS,
    fetch_status: Callable[[str, float], int] = request_status,
) -> tuple[CanaryResult, ...]:
    def probe(target: CanaryTarget) -> CanaryResult:
        return probe_target(target, timeout, attempts, fetch_status)

    with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, len(targets) or 1)) as pool:
        return tuple(pool.map(probe, targets))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    parser.add_argument("--attempts", type=int, default=DEFAULT_ATTEMPTS)
    args = parser.parse_args(argv)

    targets = automatic_canary_targets()
    results = run_canaries(targets, args.timeout, args.attempts)
    for result in results:
        if result.healthy:
            print(
                f"PASS {result.target.carrier_id} {result.target.hostname} "
                f"HTTP {result.status}"
            )
        elif result.status is not None:
            print(
                f"FAIL {result.target.carrier_id} {result.target.hostname} "
                f"HTTP {result.status}"
            )
        else:
            print(
                f"FAIL {result.target.carrier_id} {result.target.hostname} "
                f"{result.error or 'unreachable'}"
            )
    healthy = sum(result.healthy for result in results)
    print(f"{healthy}/{len(results)} automatic carrier front doors reachable")
    return 0 if healthy == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
