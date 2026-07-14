"""Tests for webhook signature verification and event construction."""

from __future__ import annotations

import hashlib
import hmac
import json
from typing import Union

import pytest

from otok import (
    OtokWebhookVerificationError,
    compute_webhook_signature,
    construct_event,
    parse_signature_header,
    verify_webhook_signature,
)
from otok.webhooks import _constant_time_equal_hex

SECRET = "whsec_testsecret_testsecret_testsecret_1234"
NOW = 1_752_000_000

EVENT_BODY = json.dumps(
    {
        "id": "5f1e9c4a-0000-4000-8000-000000000001",
        "type": "email.bounced",
        "created_at": "2026-07-14T12:00:00.000Z",
        "data": {
            "send_id": "send-1",
            "idempotency_key": "order:42:receipt",
            "to": "jane@example.com",
            "reason": "550 5.1.1 user unknown",
            "bounce_type": "hard",
            "metadata": {"order_id": "42"},
        },
    }
)


def sign(body: Union[str, bytes], timestamp: int = NOW, secret: str = SECRET) -> str:
    raw = body.encode("utf-8") if isinstance(body, str) else body
    v1 = hmac.new(secret.encode("utf-8"), f"{timestamp}.".encode() + raw, hashlib.sha256)
    return f"t={timestamp},v1={v1.hexdigest()}"


class TestVerifyWebhookSignature:
    def test_accepts_a_valid_signature(self) -> None:
        assert verify_webhook_signature(EVENT_BODY, sign(EVENT_BODY), SECRET, now=NOW)

    def test_accepts_a_bytes_payload(self) -> None:
        raw = EVENT_BODY.encode("utf-8")
        assert verify_webhook_signature(raw, sign(raw), SECRET, now=NOW)

    def test_rejects_a_tampered_payload(self) -> None:
        tampered = EVENT_BODY.replace("jane@", "eve@")
        assert not verify_webhook_signature(tampered, sign(EVENT_BODY), SECRET, now=NOW)

    def test_rejects_the_wrong_secret(self) -> None:
        assert not verify_webhook_signature(EVENT_BODY, sign(EVENT_BODY), "whsec_other", now=NOW)

    def test_rejects_an_expired_timestamp_with_the_default_tolerance(self) -> None:
        stale = sign(EVENT_BODY, NOW - 301)
        assert not verify_webhook_signature(EVENT_BODY, stale, SECRET, now=NOW)
        # Inside the 5-minute window passes.
        recent = sign(EVENT_BODY, NOW - 299)
        assert verify_webhook_signature(EVENT_BODY, recent, SECRET, now=NOW)

    def test_rejects_timestamps_too_far_in_the_future(self) -> None:
        future = sign(EVENT_BODY, NOW + 301)
        assert not verify_webhook_signature(EVENT_BODY, future, SECRET, now=NOW)

    def test_accepts_a_future_timestamp_within_tolerance(self) -> None:
        skewed = sign(EVENT_BODY, NOW + 299)
        assert verify_webhook_signature(EVENT_BODY, skewed, SECRET, now=NOW)

    def test_honors_a_custom_tolerance(self) -> None:
        old = sign(EVENT_BODY, NOW - 100)
        assert not verify_webhook_signature(
            EVENT_BODY, old, SECRET, now=NOW, tolerance_seconds=60
        )

    @pytest.mark.parametrize(
        "header",
        ["", "t=abc,v1=00", "v1=00", f"t={NOW}", "garbage", f"t=-1,v1={'0' * 64}"],
    )
    def test_rejects_malformed_headers(self, header: str) -> None:
        assert not verify_webhook_signature(EVENT_BODY, header, SECRET, now=NOW)

    def test_accepts_when_any_of_multiple_v1_signatures_matches(self) -> None:
        with_decoy = f"{sign(EVENT_BODY)},v1={'0' * 64}"
        assert verify_webhook_signature(EVENT_BODY, with_decoy, SECRET, now=NOW)

    def test_rejects_when_only_decoy_signatures_are_present(self) -> None:
        decoys = f"t={NOW},v1={'0' * 64},v1={'f' * 64}"
        assert not verify_webhook_signature(EVENT_BODY, decoys, SECRET, now=NOW)


class TestConstantTimePath:
    def test_comparison_goes_through_hmac_compare_digest(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls: list[tuple[bytes, bytes]] = []
        original = hmac.compare_digest

        def spying_compare(a: bytes, b: bytes) -> bool:
            calls.append((a, b))
            return original(a, b)

        # otok.webhooks resolves hmac.compare_digest at call time, so
        # patching the stdlib module is observed by the library.
        monkeypatch.setattr(hmac, "compare_digest", spying_compare)
        assert verify_webhook_signature(EVENT_BODY, sign(EVENT_BODY), SECRET, now=NOW)
        assert len(calls) == 1

    def test_equal_hex_strings_compare_true(self) -> None:
        assert _constant_time_equal_hex("ab" * 32, "ab" * 32)

    def test_same_length_different_hex_compare_false(self) -> None:
        assert not _constant_time_equal_hex("ab" * 32, "cd" * 32)

    def test_length_mismatch_compares_false(self) -> None:
        assert not _constant_time_equal_hex("ab", "abcd")

    def test_invalid_hex_compares_false(self) -> None:
        assert not _constant_time_equal_hex("zz", "zz")


class TestParseSignatureHeader:
    def test_parses_timestamp_and_signatures(self) -> None:
        parsed = parse_signature_header(sign(EVENT_BODY))
        assert parsed is not None
        assert parsed.timestamp == NOW
        assert len(parsed.signatures) == 1

    def test_returns_none_for_non_hex_signatures(self) -> None:
        assert parse_signature_header(f"t={NOW},v1=nothex") is None

    def test_returns_none_for_a_negative_timestamp(self) -> None:
        assert parse_signature_header(f"t=-2,v1={'a' * 64}") is None

    def test_ignores_unknown_keys(self) -> None:
        parsed = parse_signature_header(f"{sign(EVENT_BODY)},v0=whatever")
        assert parsed is not None
        assert len(parsed.signatures) == 1


class TestComputeWebhookSignature:
    def test_matches_the_documented_scheme(self) -> None:
        expected = hmac.new(
            SECRET.encode("utf-8"),
            f"{NOW}.{EVENT_BODY}".encode(),
            hashlib.sha256,
        ).hexdigest()
        assert compute_webhook_signature(SECRET, NOW, EVENT_BODY) == expected

    def test_str_and_bytes_payloads_agree(self) -> None:
        assert compute_webhook_signature(SECRET, NOW, EVENT_BODY) == compute_webhook_signature(
            SECRET, NOW, EVENT_BODY.encode("utf-8")
        )


class TestConstructEvent:
    def test_returns_the_event_for_a_valid_signature(self) -> None:
        event = construct_event(EVENT_BODY, sign(EVENT_BODY), SECRET, now=NOW)
        assert event["type"] == "email.bounced"
        assert event["data"]["to"] == "jane@example.com"
        assert event["data"].get("bounce_type") == "hard"

    def test_raises_on_a_missing_header(self) -> None:
        with pytest.raises(OtokWebhookVerificationError, match="Missing X-Otok-Signature"):
            construct_event(EVENT_BODY, None, SECRET)

    def test_raises_on_a_missing_secret(self) -> None:
        with pytest.raises(OtokWebhookVerificationError, match="Missing webhook signing secret"):
            construct_event(EVENT_BODY, sign(EVENT_BODY), "")

    def test_raises_on_an_invalid_signature(self) -> None:
        with pytest.raises(OtokWebhookVerificationError, match="verification failed"):
            construct_event(EVENT_BODY, sign(EVENT_BODY, NOW, "whsec_bad"), SECRET, now=NOW)

    def test_raises_on_a_verified_but_non_json_payload(self) -> None:
        body = "not json"
        with pytest.raises(OtokWebhookVerificationError, match="not valid JSON"):
            construct_event(body, sign(body), SECRET, now=NOW)

    def test_raises_on_a_verified_json_payload_that_is_not_an_event_envelope(self) -> None:
        body = json.dumps({"hello": "world"})
        with pytest.raises(OtokWebhookVerificationError, match="not a recognized event"):
            construct_event(body, sign(body), SECRET, now=NOW)
