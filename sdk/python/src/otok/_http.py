"""HTTP layer: transport abstraction, retries, backoff, and error mapping.

The transport is a tiny protocol (one ``send`` method) so the SDK stays
zero-dependency (the default transport wraps ``urllib.request``) and tests
can inject a scripted fake.
"""

from __future__ import annotations

import json
import math
import random
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import timezone
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Optional, Protocol, Union

from ._version import __version__
from .errors import OtokAPIError, OtokTimeoutError

#: Canonical base URL of the oToK API (endpoint paths ``/v1/...`` are
#: appended to it).
DEFAULT_BASE_URL = "https://app.otok.io/api"

DEFAULT_TIMEOUT_SECONDS = 30.0
DEFAULT_MAX_RETRIES = 2
#: Base backoff delay; grows exponentially per retry with full jitter.
BACKOFF_BASE_MS = 500
BACKOFF_CAP_MS = 30_000

QueryValue = Union[str, int, float, bool, None]


@dataclass
class TransportRequest:
    """A single outgoing HTTP request handed to the transport."""

    method: str
    url: str
    headers: Mapping[str, str]
    body: Optional[bytes]
    #: Per-attempt timeout in seconds.
    timeout: float


@dataclass
class TransportResponse:
    """The transport's response. ``headers`` keys must be lowercased."""

    status: int
    headers: Mapping[str, str]
    body: bytes


class Transport(Protocol):
    """Minimal transport contract.

    Implementations perform exactly one HTTP round trip per ``send`` call
    (no retries — the client owns retry policy), return a
    ``TransportResponse`` for ANY HTTP status (including 4xx/5xx), and raise
    ``OtokTimeoutError`` when the per-attempt timeout elapses.
    """

    def send(self, request: TransportRequest) -> TransportResponse:  # pragma: no cover
        ...


class UrllibTransport:
    """Default zero-dependency transport built on ``urllib.request``."""

    def send(self, request: TransportRequest) -> TransportResponse:
        req = urllib.request.Request(
            request.url,
            data=request.body,
            headers=dict(request.headers),
            method=request.method,
        )
        try:
            with urllib.request.urlopen(req, timeout=request.timeout) as response:
                return TransportResponse(
                    status=response.status,
                    headers=_lower_headers(response.headers.items()),
                    body=response.read(),
                )
        except urllib.error.HTTPError as err:
            # Non-2xx responses are data, not exceptions: the client decides
            # whether to retry or raise OtokAPIError.
            return TransportResponse(
                status=err.code,
                headers=_lower_headers(err.headers.items()),
                body=err.read(),
            )
        except (TimeoutError, socket.timeout) as err:  # socket.timeout: Python 3.9
            raise OtokTimeoutError(request.timeout) from err
        except urllib.error.URLError as err:
            if isinstance(err.reason, (TimeoutError, socket.timeout)):
                raise OtokTimeoutError(request.timeout) from err
            raise


def _lower_headers(items: Any) -> dict[str, str]:
    return {str(key).lower(): str(value) for key, value in items}


def compute_backoff_ms(
    attempt: int,
    retry_after_header: Optional[str] = None,
    random_func: Callable[[], float] = random.random,
) -> float:
    """Compute the delay (in milliseconds) before the next retry attempt.

    A ``Retry-After`` header (delta-seconds or HTTP-date), when present and
    parseable, wins over the computed backoff. Otherwise exponential backoff
    with full jitter: ``random(0, min(cap, base * 2**attempt))``.

    ``attempt`` is the 0-based index of the retry being scheduled.
    """
    if retry_after_header:
        header = retry_after_header.strip()
        seconds: Optional[float]
        try:
            seconds = float(header)
        except ValueError:
            seconds = None
        if seconds is not None and math.isfinite(seconds) and seconds >= 0:
            return min(seconds * 1000.0, float(BACKOFF_CAP_MS))
        date_ms = _parse_http_date_ms(header)
        if date_ms is not None:
            return min(max(0.0, date_ms - time.time() * 1000.0), float(BACKOFF_CAP_MS))
    cap = min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * (2**attempt))
    return float(math.floor(random_func() * cap))


def _parse_http_date_ms(value: str) -> Optional[float]:
    try:
        parsed = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if parsed is None:  # Python 3.9 returns None for some malformed input
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp() * 1000.0


def _is_retryable_status(status: int) -> bool:
    return status == 429 or status >= 500


class HttpClient:
    """Minimal HTTP client: auth header injection, JSON (de)serialization,
    per-attempt timeout, and exponential-backoff retries on 429/5xx
    respecting ``Retry-After``.
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
        max_retries: int = DEFAULT_MAX_RETRIES,
        transport: Optional[Transport] = None,
    ) -> None:
        if not api_key:
            raise ValueError("otok: api_key is required")
        self._api_key = api_key
        self._base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self._timeout = timeout
        self._max_retries = max_retries
        self._transport: Transport = transport if transport is not None else UrllibTransport()

    def request(
        self,
        method: str,
        path: str,
        *,
        query: Optional[Mapping[str, QueryValue]] = None,
        body: Any = None,
    ) -> Any:
        url = self._build_url(path, query)
        headers: dict[str, str] = {
            "Authorization": f"Bearer {self._api_key}",
            "Accept": "application/json",
            "User-Agent": f"otok-python/{__version__}",
        }
        data: Optional[bytes] = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")

        for attempt in range(self._max_retries + 1):
            # Network failures and timeouts are not retried in v0.1 — not
            # every endpoint is idempotent, and a request may have reached
            # the server.
            response = self._transport.send(
                TransportRequest(
                    method=method,
                    url=url,
                    headers=headers,
                    body=data,
                    timeout=self._timeout,
                )
            )

            if 200 <= response.status < 300:
                return _parse_body(response)

            if _is_retryable_status(response.status) and attempt < self._max_retries:
                delay_ms = compute_backoff_ms(attempt, response.headers.get("retry-after"))
                time.sleep(delay_ms / 1000.0)
                continue

            raise _to_api_error(response)

        # Unreachable: the final loop iteration always returns or raises.
        raise RuntimeError("otok: retry loop exited unexpectedly")

    def _build_url(self, path: str, query: Optional[Mapping[str, QueryValue]]) -> str:
        url = self._base_url + path
        if query:
            pairs = [
                (key, _serialize_query_value(value))
                for key, value in query.items()
                if value is not None
            ]
            if pairs:
                url = url + "?" + urllib.parse.urlencode(pairs)
        return url


def _serialize_query_value(value: Union[str, int, float, bool]) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _parse_body(response: TransportResponse) -> Any:
    if response.status == 204:
        return None
    if not response.body:
        return None
    text = response.body.decode("utf-8", errors="replace")
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return text


def _to_api_error(response: TransportResponse) -> OtokAPIError:
    body = _parse_body(response)
    code: Optional[str] = None
    message = f"HTTP {response.status}"
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict):
            # Domain envelope: { "error": { "code", "message" } }
            if isinstance(error.get("code"), str):
                code = error["code"]
            if isinstance(error.get("message"), str):
                message = error["message"]
        elif isinstance(body.get("message"), str):
            # Framework shape: { "statusCode", "message", "error" }
            message = body["message"]
        elif isinstance(body.get("message"), list):
            message = "; ".join(str(item) for item in body["message"])
    return OtokAPIError(response.status, message, code=code, body=body)
