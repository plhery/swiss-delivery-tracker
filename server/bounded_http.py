"""Response-size guards for carrier adapters supplied by the pinned dependency."""

from __future__ import annotations

from types import ModuleType
from typing import Any

MAX_UPSTREAM_RESPONSE_BYTES = 2_000_000


class UpstreamResponseTooLarge(RuntimeError):
    """Raised before an upstream response can consume unbounded process memory."""


class BoundedResponse:
    def __init__(self, response: Any, limit: int = MAX_UPSTREAM_RESPONSE_BYTES) -> None:
        self._response = response
        self._remaining = max(1, limit)

    def read(self, amount: int | None = -1) -> Any:
        requested = (
            self._remaining + 1
            if amount is None or amount < 0
            else min(amount, self._remaining + 1)
        )
        data = self._response.read(requested)
        if len(data) > self._remaining:
            raise UpstreamResponseTooLarge("The carrier returned an unexpectedly large response")
        self._remaining -= len(data)
        return data

    def __enter__(self) -> BoundedResponse:
        self._response.__enter__()
        return self

    def __exit__(self, *args: object) -> Any:
        return self._response.__exit__(*args)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._response, name)


class _BoundedOpener:
    def __init__(self, opener: Any, limit: int) -> None:
        self._opener = opener
        self._limit = limit

    def open(self, *args: Any, **kwargs: Any) -> BoundedResponse:
        return BoundedResponse(self._opener.open(*args, **kwargs), self._limit)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._opener, name)


class _BoundedRequestModule:
    def __init__(self, request_module: Any, limit: int) -> None:
        self._request_module = request_module
        self._limit = limit

    def urlopen(self, *args: Any, **kwargs: Any) -> BoundedResponse:
        return BoundedResponse(self._request_module.urlopen(*args, **kwargs), self._limit)

    def build_opener(self, *args: Any, **kwargs: Any) -> _BoundedOpener:
        return _BoundedOpener(self._request_module.build_opener(*args, **kwargs), self._limit)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._request_module, name)


class _BoundedUrllib:
    def __init__(self, urllib_module: Any, limit: int) -> None:
        self._urllib_module = urllib_module
        self.request = _BoundedRequestModule(urllib_module.request, limit)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._urllib_module, name)


class _BoundedConnection:
    def __init__(self, connection: Any, limit: int) -> None:
        self._connection = connection
        self._limit = limit

    def getresponse(self, *args: Any, **kwargs: Any) -> BoundedResponse:
        return BoundedResponse(self._connection.getresponse(*args, **kwargs), self._limit)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._connection, name)


class _BoundedClientModule:
    def __init__(self, client_module: Any, limit: int) -> None:
        self._client_module = client_module
        self._limit = limit

    def HTTPConnection(self, *args: Any, **kwargs: Any) -> _BoundedConnection:  # noqa: N802
        return _BoundedConnection(
            self._client_module.HTTPConnection(*args, **kwargs), self._limit
        )

    def HTTPSConnection(self, *args: Any, **kwargs: Any) -> _BoundedConnection:  # noqa: N802
        return _BoundedConnection(
            self._client_module.HTTPSConnection(*args, **kwargs), self._limit
        )

    def __getattr__(self, name: str) -> Any:
        return getattr(self._client_module, name)


class _BoundedHttp:
    def __init__(self, http_module: Any, limit: int) -> None:
        self._http_module = http_module
        self.client = _BoundedClientModule(http_module.client, limit)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._http_module, name)


def install_bounded_http(
    module: ModuleType | Any,
    limit: int = MAX_UPSTREAM_RESPONSE_BYTES,
) -> None:
    """Give one imported carrier module private, size-bounded HTTP proxies."""
    urllib_module = getattr(module, "urllib", None)
    if (
        urllib_module is not None
        and not isinstance(urllib_module, _BoundedUrllib)
        and hasattr(urllib_module, "request")
    ):
        setattr(module, "urllib", _BoundedUrllib(urllib_module, limit))  # noqa: B010

    http_module = getattr(module, "http", None)
    if (
        http_module is not None
        and not isinstance(http_module, _BoundedHttp)
        and hasattr(http_module, "client")
    ):
        setattr(module, "http", _BoundedHttp(http_module, limit))  # noqa: B010
