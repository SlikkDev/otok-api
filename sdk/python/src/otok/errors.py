"""Exception types raised by the oToK SDK."""

from __future__ import annotations

from typing import Any, Optional


class OtokAPIError(Exception):
    """Error raised for any non-2xx API response (after retries are exhausted).

    ``code`` is the machine-readable error code when the API provides one —
    either from the domain envelope ``{"error": {"code", "message"}}``
    (e.g. ``endpoint_not_found``, ``campaign_not_found``) or from a
    top-level ``error_code`` field on the standard shape. Notably: 403
    ``FEATURE_NOT_INCLUDED_IN_PLAN`` when the workspace's plan lacks the
    product feature an endpoint group requires (Deals, Payments, Campaigns,
    Booking), and 409 ``CONTACT_MERGE_REQUIRED`` (with ``merge_request_id``
    on ``body``) when a contact create/update collides with another
    contact's phone/email. Key your handling on ``status`` + ``code``,
    never on the human-readable message.
    """

    def __init__(
        self,
        status: int,
        message: str,
        code: Optional[str] = None,
        body: Any = None,
    ) -> None:
        super().__init__(message)
        #: HTTP status code of the failed response.
        self.status = status
        #: Machine-readable error code from the API error envelope, when present.
        self.code = code
        #: The parsed response body (JSON when possible, raw text otherwise).
        self.body = body


class OtokTimeoutError(Exception):
    """Raised when a request exceeds the configured per-attempt timeout."""

    def __init__(self, timeout_seconds: float) -> None:
        super().__init__(f"Request timed out after {timeout_seconds}s")
        self.timeout_seconds = timeout_seconds


class OtokWebhookVerificationError(Exception):
    """Raised by ``construct_event`` when a webhook signature cannot be verified."""
