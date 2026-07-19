"""Tests for the HTTP client: request shaping, retries, backoff, errors."""

from __future__ import annotations

import json
import socket
import time
import urllib.error
from email.utils import formatdate
from typing import Any

import pytest

from otok import DEFAULT_BASE_URL, OtokAPIError, OtokTimeoutError, compute_backoff_ms
from otok._http import HttpClient, TransportRequest, TransportResponse
from tests.helpers import MockTransport, json_response


def make_client(transport: MockTransport, **kwargs: Any) -> HttpClient:
    options: Any = {
        "base_url": "https://example.test/api",
        "max_retries": 2,
        **kwargs,
    }
    return HttpClient("otok_live_testkey", transport=transport, **options)


class TestRequestBasics:
    def test_sends_auth_header_json_body_and_serialized_query(self) -> None:
        transport = MockTransport(
            [json_response(200, {"data": [], "total": 0, "limit": 10, "offset": 0})]
        )
        client = make_client(transport)
        result = client.request(
            "GET",
            "/v1/contacts",
            query={
                "filter": json.dumps({"lifecycle_stage": "lead"}, separators=(",", ":")),
                "limit": 10,
                "search": None,  # omitted
            },
        )
        assert result == {"data": [], "total": 0, "limit": 10, "offset": 0}
        assert len(transport.requests) == 1
        request = transport.requests[0]
        assert request.url == (
            "https://example.test/api/v1/contacts"
            "?filter=%7B%22lifecycle_stage%22%3A%22lead%22%7D&limit=10"
        )
        assert request.method == "GET"
        assert request.headers["Authorization"] == "Bearer otok_live_testkey"
        assert request.body is None

    def test_posts_a_json_body_with_content_type(self) -> None:
        transport = MockTransport([json_response(201, {"id": "c1"})])
        client = make_client(transport)
        result = client.request("POST", "/v1/contacts", body={"email": "a@b.co"})
        assert result["id"] == "c1"
        request = transport.requests[0]
        assert request.headers["Content-Type"] == "application/json"
        assert request.body is not None
        assert json.loads(request.body) == {"email": "a@b.co"}

    def test_returns_none_for_204_responses(self) -> None:
        transport = MockTransport([TransportResponse(status=204, headers={}, body=b"")])
        client = make_client(transport)
        assert client.request("DELETE", "/v1/webhook-endpoints/x") is None

    def test_default_base_url_is_the_canonical_one(self) -> None:
        assert DEFAULT_BASE_URL == "https://app.otok.io/api"

    def test_requires_an_api_key(self) -> None:
        with pytest.raises(ValueError, match="api_key"):
            HttpClient("", transport=MockTransport())

    def test_boolean_query_values_serialize_lowercase(self) -> None:
        transport = MockTransport([json_response(200, {})])
        client = make_client(transport)
        client.request("GET", "/v1/things", query={"force": True, "flag": False})
        assert transport.requests[0].url.endswith("?force=true&flag=false")


class TestRetries:
    def test_retries_on_429_respecting_retry_after_zero_then_succeeds(self) -> None:
        transport = MockTransport(
            [
                json_response(429, {"message": "Too many requests"}, {"retry-after": "0"}),
                json_response(200, {"ok": True}),
            ]
        )
        client = make_client(transport)
        assert client.request("GET", "/v1/tags") == {"ok": True}
        assert len(transport.requests) == 2

    def test_honors_retry_after_seconds_between_attempts(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        delays: list[float] = []
        monkeypatch.setattr(time, "sleep", delays.append)
        transport = MockTransport(
            [
                json_response(429, {"message": "slow down"}, {"retry-after": "2"}),
                json_response(200, {"ok": True}),
            ]
        )
        client = make_client(transport)
        assert client.request("GET", "/v1/tags") == {"ok": True}
        assert delays == [2.0]

    def test_honors_an_http_date_retry_after(self, monkeypatch: pytest.MonkeyPatch) -> None:
        delays: list[float] = []
        monkeypatch.setattr(time, "sleep", delays.append)
        http_date = formatdate(time.time() + 2, usegmt=True)
        transport = MockTransport(
            [
                json_response(503, {"message": "maintenance"}, {"retry-after": http_date}),
                json_response(200, {"ok": True}),
            ]
        )
        client = make_client(transport)
        assert client.request("GET", "/v1/tags") == {"ok": True}
        assert len(delays) == 1
        assert 0.0 <= delays[0] <= 2.0

    def test_retries_on_5xx_and_surfaces_the_last_error_after_exhausting(self) -> None:
        transport = MockTransport(
            [json_response(503, {"message": "unavailable"}, {"retry-after": "0"})]
        )
        client = make_client(transport)
        with pytest.raises(OtokAPIError) as excinfo:
            client.request("GET", "/v1/tags")
        assert excinfo.value.status == 503
        # 1 initial + 2 retries
        assert len(transport.requests) == 3

    def test_does_not_retry_non_retryable_statuses(self) -> None:
        transport = MockTransport(
            [json_response(400, {"statusCode": 400, "message": ["name must be a string"]})]
        )
        client = make_client(transport)
        with pytest.raises(OtokAPIError) as excinfo:
            client.request("POST", "/v1/tags", body={})
        assert excinfo.value.status == 400
        assert str(excinfo.value) == "name must be a string"
        assert len(transport.requests) == 1

    def test_respects_max_retries_zero(self) -> None:
        transport = MockTransport([json_response(500, {})])
        client = make_client(transport, max_retries=0)
        with pytest.raises(OtokAPIError):
            client.request("GET", "/v1/tags")
        assert len(transport.requests) == 1

    def test_does_not_retry_timeouts_on_non_idempotent_writes(self) -> None:
        class TimeoutTransport:
            def __init__(self) -> None:
                self.calls = 0

            def send(self, request: TransportRequest) -> TransportResponse:
                self.calls += 1
                raise OtokTimeoutError(request.timeout)

        transport = TimeoutTransport()
        client = HttpClient(
            "otok_live_testkey",
            base_url="https://example.test/api",
            timeout=0.03,
            transport=transport,
        )
        # POST without an idempotency key: the request may have reached the
        # server, so the timeout surfaces after the first attempt.
        with pytest.raises(OtokTimeoutError):
            client.request("POST", "/v1/tags", body={"name": "VIP"})
        assert transport.calls == 1


class _FlakyTransport:
    """Raises the scripted exceptions in order, then answers from responses."""

    def __init__(
        self,
        errors: list[BaseException],
        responses: list[TransportResponse],
    ) -> None:
        self.errors = list(errors)
        self.responses = list(responses)
        self.calls = 0

    def send(self, request: TransportRequest) -> TransportResponse:
        self.calls += 1
        if self.errors:
            raise self.errors.pop(0)
        if not self.responses:
            raise AssertionError("_FlakyTransport: no scripted response left")
        return self.responses.pop(0)


class TestNetworkErrorRetries:
    @pytest.fixture(autouse=True)
    def _no_sleep(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Full-jitter backoff sleeps random(0, cap) — swallow the sleeps so
        # retried requests re-fire immediately.
        monkeypatch.setattr(time, "sleep", lambda _s: None)

    def _client(self, transport: _FlakyTransport, **kwargs: Any) -> HttpClient:
        return HttpClient(
            "otok_live_testkey",
            base_url="https://example.test/api",
            transport=transport,
            **kwargs,
        )

    def test_retries_a_get_after_a_connection_reset(self) -> None:
        transport = _FlakyTransport(
            [ConnectionResetError("connection reset")],
            [json_response(200, {"ok": True})],
        )
        client = self._client(transport)
        assert client.request("GET", "/v1/tags") == {"ok": True}
        assert transport.calls == 2

    def test_retries_a_get_on_dns_failure_and_connection_refusal(self) -> None:
        transport = _FlakyTransport(
            [
                socket.gaierror(8, "nodename nor servname provided"),
                ConnectionRefusedError("connection refused"),
            ],
            [json_response(200, {"ok": True})],
        )
        client = self._client(transport)
        assert client.request("GET", "/v1/tags") == {"ok": True}
        assert transport.calls == 3

    def test_retries_a_get_on_a_urlerror_wrapped_socket_error(self) -> None:
        transport = _FlakyTransport(
            [urllib.error.URLError(ConnectionResetError("reset by peer"))],
            [json_response(200, {"ok": True})],
        )
        client = self._client(transport)
        assert client.request("GET", "/v1/tags") == {"ok": True}
        assert transport.calls == 2

    def test_retries_a_timed_out_get(self) -> None:
        transport = _FlakyTransport(
            [OtokTimeoutError(30.0)],
            [json_response(200, {"ok": True})],
        )
        client = self._client(transport)
        assert client.request("GET", "/v1/tags") == {"ok": True}
        assert transport.calls == 2

    def test_does_not_retry_a_post_without_an_idempotency_key(self) -> None:
        transport = _FlakyTransport(
            [ConnectionResetError("connection reset")],
            [json_response(201, {"id": "c1"})],
        )
        client = self._client(transport)
        with pytest.raises(ConnectionResetError):
            client.request("POST", "/v1/contacts", body={"email": "a@b.co"})
        assert transport.calls == 1

    def test_does_not_retry_a_payment_request_create(self) -> None:
        # POST /v1/payment-requests has NO idempotency key of any kind — a
        # replay would mint a second, independently payable link — so the
        # network error must surface after exactly one attempt (the same
        # posture as bookings.create, whose idempotency is server-derived).
        transport = _FlakyTransport(
            [ConnectionResetError("connection reset")],
            [json_response(201, {"id": "pr-1"})],
        )
        client = self._client(transport)
        with pytest.raises(ConnectionResetError):
            client.request(
                "POST",
                "/v1/payment-requests",
                body={"contact_id": "c-1", "amount": 250, "title": "Session"},
            )
        assert transport.calls == 1

    def test_does_not_retry_patch_or_delete(self) -> None:
        transport = _FlakyTransport(
            [ConnectionResetError("reset"), ConnectionResetError("reset")],
            [],
        )
        client = self._client(transport)
        with pytest.raises(ConnectionResetError):
            client.request("PATCH", "/v1/contacts/c1", body={"name": "Jane"})
        with pytest.raises(ConnectionResetError):
            client.request("DELETE", "/v1/webhook-endpoints/w1")
        assert transport.calls == 2

    def test_retries_a_post_carrying_an_idempotency_key(self) -> None:
        transport = _FlakyTransport(
            [ConnectionResetError("connection reset")],
            [json_response(201, {"id": "send-1"})],
        )
        client = self._client(transport)
        result = client.request(
            "POST",
            "/v1/emails",
            body={"to": "a@b.co", "subject": "hi", "text": "hi", "idempotency_key": "k-1"},
        )
        assert result["id"] == "send-1"
        assert transport.calls == 2

    def test_retries_a_post_carrying_an_external_reference(self) -> None:
        transport = _FlakyTransport(
            [socket.gaierror(8, "dns down")],
            [json_response(201, {"id": "deal-1"})],
        )
        client = self._client(transport)
        result = client.request(
            "POST",
            "/v1/deals",
            body={"title": "Order", "external_reference": "order:A-1001"},
        )
        assert result["id"] == "deal-1"
        assert transport.calls == 2

    def test_retries_a_post_carrying_an_external_refund_id(self) -> None:
        # A keyed order refund replays to duplicate=True server-side, so a
        # network retry can never double-apply it.
        transport = _FlakyTransport(
            [ConnectionResetError("connection reset")],
            [json_response(201, {"duplicate": False, "order": {"id": "o-1"}})],
        )
        client = self._client(transport)
        result = client.request(
            "POST",
            "/v1/orders/o-1/refunds",
            body={"amount": 50, "external_refund_id": "refund-77"},
        )
        assert result["order"]["id"] == "o-1"
        assert transport.calls == 2

    def test_an_empty_idempotency_key_does_not_make_a_post_retryable(self) -> None:
        transport = _FlakyTransport([ConnectionResetError("reset")], [])
        client = self._client(transport)
        with pytest.raises(ConnectionResetError):
            client.request(
                "POST",
                "/v1/emails",
                body={"to": "a@b.co", "subject": "hi", "idempotency_key": ""},
            )
        assert transport.calls == 1

    def test_does_not_retry_non_transient_errors_even_on_get(self) -> None:
        transport = _FlakyTransport([ValueError("broken transport")], [])
        client = self._client(transport)
        with pytest.raises(ValueError, match="broken transport"):
            client.request("GET", "/v1/tags")
        assert transport.calls == 1

    def test_surfaces_the_last_network_error_after_exhausting_retries(self) -> None:
        transport = _FlakyTransport(
            [
                ConnectionResetError("reset 1"),
                ConnectionResetError("reset 2"),
                ConnectionResetError("reset 3"),
            ],
            [],
        )
        client = self._client(transport)  # max_retries default 2
        with pytest.raises(ConnectionResetError, match="reset 3"):
            client.request("GET", "/v1/tags")
        assert transport.calls == 3

    def test_respects_max_retries_zero_for_network_errors(self) -> None:
        transport = _FlakyTransport([ConnectionResetError("reset")], [])
        client = self._client(transport, max_retries=0)
        with pytest.raises(ConnectionResetError):
            client.request("GET", "/v1/tags")
        assert transport.calls == 1

    def test_uses_the_shared_backoff_between_network_retries(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        delays: list[float] = []
        monkeypatch.setattr(time, "sleep", delays.append)
        transport = _FlakyTransport(
            [ConnectionResetError("reset"), ConnectionResetError("reset")],
            [json_response(200, {"ok": True})],
        )
        client = self._client(transport)
        assert client.request("GET", "/v1/tags") == {"ok": True}
        # One backoff sleep per retry, drawn from the shared full-jitter
        # schedule: random(0, 500ms * 2**attempt).
        assert len(delays) == 2
        assert 0.0 <= delays[0] <= 0.5
        assert 0.0 <= delays[1] <= 1.0


class TestRedirects:
    def test_urllib_transport_returns_a_302_instead_of_following_it(self) -> None:
        """The default transport must treat 3xx as terminal — following it
        would re-send the Authorization header to the redirect target.
        """
        from http.server import BaseHTTPRequestHandler, HTTPServer
        from threading import Thread

        from otok import UrllibTransport

        hits: list[str] = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                hits.append(self.path)
                if self.path == "/redirect":
                    self.send_response(302)
                    self.send_header("Location", "/target")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                else:
                    body = b"followed"
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)

            def log_message(self, format: str, *args: Any) -> None:
                pass  # keep test output quiet

        server = HTTPServer(("127.0.0.1", 0), Handler)
        port = server.server_address[1]
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            transport = UrllibTransport()
            response = transport.send(
                TransportRequest(
                    method="GET",
                    url=f"http://127.0.0.1:{port}/redirect",
                    headers={"Authorization": "Bearer otok_live_testkey"},
                    body=None,
                    timeout=5.0,
                )
            )
            assert response.status == 302
            assert response.headers.get("location") == "/target"
            # The redirect target was never requested.
            assert hits == ["/redirect"]
        finally:
            server.shutdown()
            server.server_close()

    def test_a_3xx_response_surfaces_as_an_api_error_not_a_retry(self) -> None:
        transport = MockTransport(
            [
                TransportResponse(
                    status=302,
                    headers={"location": "https://elsewhere.example/steal"},
                    body=b"",
                )
            ]
        )
        client = make_client(transport)
        with pytest.raises(OtokAPIError) as excinfo:
            client.request("GET", "/v1/tags")
        assert excinfo.value.status == 302
        assert len(transport.requests) == 1  # not followed, not retried


class TestErrorParsing:
    def test_parses_the_domain_error_envelope(self) -> None:
        body = {"error": {"code": "endpoint_not_found", "message": "Webhook endpoint not found"}}
        transport = MockTransport([json_response(404, body)])
        client = make_client(transport, max_retries=0)
        with pytest.raises(OtokAPIError) as excinfo:
            client.request("DELETE", "/v1/webhook-endpoints/nope")
        err = excinfo.value
        assert err.status == 404
        assert err.code == "endpoint_not_found"
        assert str(err) == "Webhook endpoint not found"
        assert err.body == body

    def test_joins_array_validation_messages(self) -> None:
        transport = MockTransport(
            [
                json_response(
                    400,
                    {"statusCode": 400, "message": ["too short", "too vague"]},
                )
            ]
        )
        client = make_client(transport, max_retries=0)
        with pytest.raises(OtokAPIError) as excinfo:
            client.request("POST", "/v1/tags", body={})
        assert str(excinfo.value) == "too short; too vague"

    def test_string_error_field_is_not_mistaken_for_the_envelope(self) -> None:
        transport = MockTransport(
            [
                json_response(
                    403,
                    {"statusCode": 403, "message": "Forbidden thing", "error": "Forbidden"},
                )
            ]
        )
        client = make_client(transport, max_retries=0)
        with pytest.raises(OtokAPIError) as excinfo:
            client.request("GET", "/v1/tags")
        assert str(excinfo.value) == "Forbidden thing"
        assert excinfo.value.code is None

    def test_error_code_extension_field_is_available_via_body(self) -> None:
        body = {
            "statusCode": 409,
            "error": "Conflict",
            "error_code": "CONTACT_MERGE_REQUIRED",
            "merge_request_id": "3a2b1c0d",
            "message": "The provided phone and email belong to two different existing contacts.",
        }
        transport = MockTransport([json_response(409, body)])
        client = make_client(transport, max_retries=0)
        with pytest.raises(OtokAPIError) as excinfo:
            client.request("POST", "/v1/contacts", body={})
        assert excinfo.value.code == "CONTACT_MERGE_REQUIRED"
        assert excinfo.value.body == body
        assert isinstance(excinfo.value.body, dict)
        assert excinfo.value.body["error_code"] == "CONTACT_MERGE_REQUIRED"

    def test_top_level_error_code_is_surfaced_as_code_on_the_403_feature_gate(self) -> None:
        body = {
            "message": (
                "Your current plan does not include access to this feature: deals. "
                "Please upgrade your plan."
            ),
            "error_code": "FEATURE_NOT_INCLUDED_IN_PLAN",
        }
        transport = MockTransport([json_response(403, body)])
        client = make_client(transport, max_retries=0)
        with pytest.raises(OtokAPIError) as excinfo:
            client.request("GET", "/v1/deals")
        err = excinfo.value
        assert err.status == 403
        assert err.code == "FEATURE_NOT_INCLUDED_IN_PLAN"
        assert str(err) == body["message"]
        # 403 is not retryable.
        assert len(transport.requests) == 1

    def test_non_json_error_body_keeps_the_http_status_message(self) -> None:
        transport = MockTransport(
            [TransportResponse(status=502, headers={}, body=b"Bad gateway")]
        )
        client = make_client(transport, max_retries=0)
        with pytest.raises(OtokAPIError) as excinfo:
            client.request("GET", "/v1/tags")
        assert str(excinfo.value) == "HTTP 502"
        assert excinfo.value.body == "Bad gateway"


class TestComputeBackoffMs:
    def test_uses_retry_after_delta_seconds_when_present(self) -> None:
        assert compute_backoff_ms(0, "3") == 3000
        assert compute_backoff_ms(5, "1") == 1000

    def test_uses_an_http_date_retry_after_when_present(self) -> None:
        in_two_seconds = formatdate(time.time() + 2, usegmt=True)
        ms = compute_backoff_ms(0, in_two_seconds)
        assert 0 < ms <= 2000

    def test_a_past_http_date_means_no_delay(self) -> None:
        past = formatdate(time.time() - 60, usegmt=True)
        assert compute_backoff_ms(0, past) == 0

    def test_falls_back_to_exponential_backoff_with_full_jitter(self) -> None:
        # random() = 1 → the full cap for the attempt: 500 * 2**attempt.
        assert compute_backoff_ms(0, None, lambda: 1.0) == 500
        assert compute_backoff_ms(1, None, lambda: 1.0) == 1000
        assert compute_backoff_ms(2, None, lambda: 1.0) == 2000
        # random() = 0 → immediate.
        assert compute_backoff_ms(3, None, lambda: 0.0) == 0

    def test_caps_the_backoff_at_30s(self) -> None:
        assert compute_backoff_ms(20, None, lambda: 1.0) == 30_000
        assert compute_backoff_ms(0, "3600") == 30_000

    def test_ignores_an_unparseable_retry_after(self) -> None:
        assert compute_backoff_ms(0, "soon", lambda: 1.0) == 500

    def test_ignores_a_negative_retry_after(self) -> None:
        assert compute_backoff_ms(0, "-5", lambda: 1.0) == 500
