"""Webhook signature verification for oToK event deliveries.

Signature scheme (``X-Otok-Signature: t=<unix seconds>,v1=<hex>``)::

    signed_payload = "<t>" + "." + <raw request body>
    v1 = lowercase hex( HMAC-SHA256( key = full whsec_… secret, msg = signed_payload ) )

Verification MUST run against the raw request body bytes — parse-then-
re-serialize changes the bytes and breaks the signature.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
from dataclasses import dataclass
from typing import Optional, Union, cast

from .errors import OtokWebhookVerificationError
from .types import OtokWebhookEvent

#: Default maximum allowed age (and future skew) of the signature timestamp,
#: in seconds. Retried deliveries carry fresh timestamps, so a tight window
#: is safe.
DEFAULT_TOLERANCE_SECONDS = 300

_HEX_SIGNATURE_RE = re.compile(r"^[0-9a-f]{64}$")


def compute_webhook_signature(
    secret: str,
    timestamp_seconds: int,
    payload: Union[str, bytes],
) -> str:
    """Compute the lowercase-hex ``v1`` signature for a payload.

    The HMAC key is the ENTIRE secret string including the ``whsec_`` prefix.
    """
    payload_bytes = payload.encode("utf-8") if isinstance(payload, str) else payload
    mac = hmac.new(secret.encode("utf-8"), digestmod=hashlib.sha256)
    mac.update(f"{timestamp_seconds}.".encode())
    mac.update(payload_bytes)
    return mac.hexdigest()


@dataclass
class ParsedSignatureHeader:
    timestamp: int
    signatures: list[str]


def parse_signature_header(header: str) -> Optional[ParsedSignatureHeader]:
    """Parse ``t=<unix>,v1=<hex>[,v1=<hex>…]``; returns ``None`` when malformed."""
    if not isinstance(header, str) or not header:
        return None
    timestamp: Optional[int] = None
    signatures: list[str] = []
    for part in header.split(","):
        eq = part.find("=")
        if eq == -1:
            continue
        key = part[:eq].strip()
        value = part[eq + 1 :].strip()
        if key == "t":
            try:
                parsed = int(value)
            except ValueError:
                return None
            if parsed < 0:
                return None
            timestamp = parsed
        elif key == "v1" and _HEX_SIGNATURE_RE.match(value):
            signatures.append(value)
    if timestamp is None or not signatures:
        return None
    return ParsedSignatureHeader(timestamp=timestamp, signatures=signatures)


def _constant_time_equal_hex(a: str, b: str) -> bool:
    if len(a) != len(b):
        return False
    try:
        return hmac.compare_digest(bytes.fromhex(a), bytes.fromhex(b))
    except ValueError:
        return False


def verify_webhook_signature(
    payload: Union[str, bytes],
    signature_header: str,
    secret: str,
    *,
    tolerance_seconds: int = DEFAULT_TOLERANCE_SECONDS,
    now: Optional[int] = None,
) -> bool:
    """Verify an oToK webhook signature.

    Returns ``True`` only when the header parses, the timestamp is within
    ``tolerance_seconds`` of ``now``, and an expected signature matches
    (constant-time comparison via ``hmac.compare_digest``).

    ``payload`` is the RAW request body (``str`` or ``bytes``) — exactly as
    received. ``secret`` is the endpoint's ``whsec_…`` secret (full string,
    prefix included). ``now`` (unix seconds) is overridable for testing.
    """
    parsed = parse_signature_header(signature_header)
    if parsed is None:
        return False

    current = now if now is not None else int(time.time())
    if abs(current - parsed.timestamp) > tolerance_seconds:
        return False

    expected = compute_webhook_signature(secret, parsed.timestamp, payload)
    return any(_constant_time_equal_hex(signature, expected) for signature in parsed.signatures)


def construct_event(
    payload: Union[str, bytes],
    signature_header: Optional[str],
    secret: str,
    *,
    tolerance_seconds: int = DEFAULT_TOLERANCE_SECONDS,
    now: Optional[int] = None,
) -> OtokWebhookEvent:
    """Verify the signature AND parse the body into a typed event — the
    recommended entry point for webhook handlers::

        event = construct_event(raw_body, request.headers["X-Otok-Signature"], secret)
        if event["type"] == "email.bounced":
            ... event["data"].get("bounce_type") ...

    Raises :class:`OtokWebhookVerificationError` when verification or
    parsing fails — respond 400 and let oToK retry (retries span ≈16 hours).
    """
    if not secret:
        raise OtokWebhookVerificationError("Missing webhook signing secret")
    if not signature_header:
        raise OtokWebhookVerificationError("Missing X-Otok-Signature header")
    if not verify_webhook_signature(
        payload,
        signature_header,
        secret,
        tolerance_seconds=tolerance_seconds,
        now=now,
    ):
        raise OtokWebhookVerificationError("Webhook signature verification failed")
    text = payload if isinstance(payload, str) else payload.decode("utf-8")
    try:
        event = json.loads(text)
    except ValueError:
        raise OtokWebhookVerificationError("Webhook payload is not valid JSON") from None
    if (
        not isinstance(event, dict)
        or not isinstance(event.get("type"), str)
        or not isinstance(event.get("id"), str)
    ):
        raise OtokWebhookVerificationError("Webhook payload is not a recognized event envelope")
    return cast(OtokWebhookEvent, event)
