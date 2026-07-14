"""Tests for the HTTP client: request shaping, retries, backoff, errors."""

from __future__ import annotations

import json
import time
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

    def test_does_not_retry_timeouts(self) -> None:
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
        with pytest.raises(OtokTimeoutError):
            client.request("GET", "/v1/tags")
        assert transport.calls == 1


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
        assert excinfo.value.body == body
        assert isinstance(excinfo.value.body, dict)
        assert excinfo.value.body["error_code"] == "CONTACT_MERGE_REQUIRED"

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
