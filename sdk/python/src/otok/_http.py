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
    #: Timeout in seconds. With the default urllib transport this bounds
    #: each blocking socket operation (connect, each read) rather than the
    #: attempt's total wall-clock time.
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
    (no retries and no redirect following — the client owns retry policy,
    and a 3xx is a terminal response), return a ``TransportResponse`` for
    ANY HTTP status (including 3xx/4xx/5xx), and raise ``OtokTimeoutError``
    when the request times out.
    """

    def send(self, request: TransportRequest) -> TransportResponse:  # pragma: no cover
        ...


class _NoRedirectFollowHandler(urllib.request.HTTPRedirectHandler):
    """Treat every 3xx as a terminal response instead of following it.

    urllib's default redirect handler re-sends the original headers —
    including ``Authorization: Bearer otok_live_…`` — to the redirect
    target, even cross-origin. The API never redirects, so the safe
    behavior is to surface the 3xx to the caller (the same posture as
    oToK's own outbound webhook dispatcher, which follows no redirects).
    """

    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> None:
        # Returning None makes HTTPRedirectHandler raise HTTPError for the
        # 3xx, which UrllibTransport converts into a TransportResponse.
        return None


class UrllibTransport:
    """Default zero-dependency transport built on ``urllib.request``.

    Redirects are NOT followed — a 3xx comes back as a plain
    ``TransportResponse`` — so the bearer API key is never re-sent to a
    redirect target. The per-request ``timeout`` bounds each socket
    operation (connect, each read), not the whole attempt.
    """

    def __init__(self) -> None:
        self._opener = urllib.request.build_opener(_NoRedirectFollowHandler())

    def send(self, request: TransportRequest) -> TransportResponse:
        req = urllib.request.Request(
            request.url,
            data=request.body,
            headers=dict(request.headers),
            method=request.method,
        )
        try:
            with self._opener.open(req, timeout=request.timeout) as response:
                return TransportResponse(
                    status=response.status,
                    headers=_lower_headers(response.headers.items()),
                    body=response.read(),
                )
        except urllib.error.HTTPError as err:
            # Non-2xx responses (including unfollowed 3xx) are data, not
            # exceptions: the client decides whether to retry or raise
            # OtokAPIError.
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


#: Transport-level exceptions treated as transient: connection
#: reset/refused/aborted/broken pipe (``ConnectionError``), DNS failure
#: (``socket.gaierror``/``herror``), socket timeout. ``socket.timeout`` is an
#: alias of ``TimeoutError`` since 3.10 but is listed for 3.9.
_TRANSIENT_NETWORK_EXCEPTIONS = (
    ConnectionError,
    socket.gaierror,
    socket.herror,
    TimeoutError,
    socket.timeout,
)


def _is_transient_network_error(err: BaseException) -> bool:
    """True when ``err`` is a transient transport-level failure (the request
    never produced an HTTP response): a connection/DNS/socket-timeout error —
    raised directly or wrapped in a ``urllib.error.URLError`` — or an
    ``OtokTimeoutError``.
    """
    if isinstance(err, OtokTimeoutError):
        return True
    if isinstance(err, urllib.error.HTTPError):
        return False  # an HTTP response, not a transport failure
    if isinstance(err, _TRANSIENT_NETWORK_EXCEPTIONS):
        return True
    if isinstance(err, urllib.error.URLError):
        return isinstance(err.reason, _TRANSIENT_NETWORK_EXCEPTIONS)
    return False


def _is_network_retry_safe(method: str, body: Any) -> bool:
    """Whether a request may be auto-retried after a transient NETWORK error.

    A network error is ambiguous — the request may or may not have reached
    the server — so replaying it is only safe when a replay cannot
    double-apply an effect: safe methods (GET/HEAD), or a write body that
    carries its own idempotency key — ``idempotency_key``
    (``POST /v1/emails``), ``external_reference`` (``POST /v1/deals``,
    ``POST /v1/payments``, ``POST /v1/orders``), or ``external_refund_id``
    (``POST /v1/orders/:id/refunds``). Everything else surfaces the network
    error to the caller. (429/5xx HTTP responses are a different case — the
    server answered — and keep their existing retry behavior for all
    requests.)
    """
    if method.upper() in ("GET", "HEAD"):
        return True
    if isinstance(body, Mapping):
        for key in ("idempotency_key", "external_reference", "external_refund_id"):
            value = body.get(key)
            if isinstance(value, str) and value:
                return True
    return False


class HttpClient:
    """Minimal HTTP client: auth header injection, JSON (de)serialization,
    request timeouts, and exponential-backoff retries — on 429/5xx
    respecting ``Retry-After``, and on transient network errors for
    safe/idempotency-keyed requests only.

    ``timeout`` is passed to the transport per attempt; with the default
    urllib transport it bounds each socket operation (connect, each read),
    not the attempt's total wall-clock time.
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

        network_retry_safe = _is_network_retry_safe(method, body)

        for attempt in range(self._max_retries + 1):
            try:
                response = self._transport.send(
                    TransportRequest(
                        method=method,
                        url=url,
                        headers=headers,
                        body=data,
                        timeout=self._timeout,
                    )
                )
            except Exception as err:
                # Transient transport-level failures (connection reset/
                # refused, DNS failure, socket timeout) share the 429/5xx
                # backoff — but only when replaying is safe (GET/HEAD or an
                # idempotency-keyed write). The request may have reached the
                # server, so non-idempotent writes are never network-retried;
                # the error surfaces to the caller instead.
                if (
                    network_retry_safe
                    and attempt < self._max_retries
                    and _is_transient_network_error(err)
                ):
                    time.sleep(compute_backoff_ms(attempt) / 1000.0)
                    continue
                raise

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
        else:
            # Standard shape: { "statusCode"?, "message", "error"? } — some
            # carry a machine-readable top-level error_code
            # (FEATURE_NOT_INCLUDED_IN_PLAN, CONTACT_MERGE_REQUIRED) plus
            # extra fields (e.g. merge_request_id), all kept on `body`.
            if isinstance(body.get("message"), str):
                message = body["message"]
            elif isinstance(body.get("message"), list):
                message = "; ".join(str(item) for item in body["message"])
            if isinstance(body.get("error_code"), str):
                code = body["error_code"]
    return OtokAPIError(response.status, message, code=code, body=body)
