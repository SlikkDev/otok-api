"""Shared test helpers: a scripted mock transport (no network)."""

from __future__ import annotations

import json
from typing import Any, Optional
from urllib.parse import urlsplit

from otok._http import TransportRequest, TransportResponse


def json_response(
    status: int,
    body: Any = None,
    headers: Optional[dict[str, str]] = None,
) -> TransportResponse:
    merged = {"content-type": "application/json"}
    merged.update({k.lower(): v for k, v in (headers or {}).items()})
    raw = b"" if body is None else json.dumps(body).encode("utf-8")
    return TransportResponse(status=status, headers=merged, body=raw)


class MockTransport:
    """Scripted transport: answers from a queue, records every request.

    When only one scripted response remains it is repeated forever (useful
    for retry tests).
    """

    def __init__(self, responses: Optional[list[TransportResponse]] = None) -> None:
        self.responses: list[TransportResponse] = list(responses or [])
        self.requests: list[TransportRequest] = []

    def send(self, request: TransportRequest) -> TransportResponse:
        self.requests.append(request)
        if not self.responses:
            raise AssertionError("MockTransport: no scripted response left")
        if len(self.responses) == 1:
            return self.responses[0]
        return self.responses.pop(0)

    # ── Assertion conveniences ──

    def request_path(self, index: int = -1) -> str:
        return urlsplit(self.requests[index].url).path

    def request_paths(self) -> list[str]:
        return [urlsplit(request.url).path for request in self.requests]

    def request_body(self, index: int = -1) -> Any:
        raw = self.requests[index].body
        return None if raw is None else json.loads(raw.decode("utf-8"))
