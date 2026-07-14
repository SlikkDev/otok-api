"""Exception types raised by the oToK SDK."""

from __future__ import annotations

from typing import Any, Optional


class OtokAPIError(Exception):
    """Error raised for any non-2xx API response (after retries are exhausted).

    Domain endpoints use the machine-readable envelope
    ``{"error": {"code", "message"}}`` — ``code`` is surfaced here when
    present. Framework-level errors (validation 400s, throttling 429s, auth
    401s) keep the platform's default shape; key your handling on ``status``
    (+ ``code`` when present), never on the human-readable message.
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
