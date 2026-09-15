"""Wire contracts for intake, product cycles and shared saved reports."""

from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

from otok import ContactUpsertParams, OtokClient, ReportRunParams
from tests.helpers import MockTransport, json_response


def make_client(*bodies: object) -> tuple[OtokClient, MockTransport]:
    transport = MockTransport(
        [json_response(201, body) for body in bodies] or [json_response(201, {})]
    )
    return OtokClient(
        "otok_live_testkey", base_url="https://example.test/api", transport=transport
    ), transport


def test_contact_submission_fields_survive_serialization() -> None:
    client, transport = make_client({"id": "contact-1", "duplicate": True})
    body: ContactUpsertParams = {
        "email": "jane@example.com",
        "owner_email": "member@example.com",
        "inquiry": "never",
        "acquisition": {"event_id": "signup-example-001", "gbraid": "example-click"},
    }
    assert client.contacts.upsert(body)["duplicate"] is True
    assert transport.request_body() == body


def test_cycle_routes_and_partial_update() -> None:
    client, transport = make_client({}, {"id": "cycle-1", "duplicate": True})
    client.product_cycles.list("product-1", {"is_archived": False, "limit": 5, "offset": 10})
    assert parse_qs(urlsplit(transport.requests[0].url).query)["is_archived"] == ["false"]
    assert client.product_cycles.create("product-1", {"name": "Autumn course"})["duplicate"] is True
    client.product_cycles.get("cycle-1")
    client.product_cycles.update("cycle-1", {"manual_status": None, "is_archived": True})
    assert transport.request_paths() == [
        "/api/v1/products/product-1/cycles",
        "/api/v1/products/product-1/cycles",
        "/api/v1/product-cycles/cycle-1",
        "/api/v1/product-cycles/cycle-1",
    ]
    assert [r.method for r in transport.requests] == ["GET", "POST", "GET", "PATCH"]
    assert transport.request_body() == {"manual_status": None, "is_archived": True}


def test_cycle_iteration_keeps_product_and_filters() -> None:
    client, transport = make_client(
        {"data": [{"id": "a"}], "total": 2, "limit": 1, "offset": 0},
        {"data": [{"id": "b"}], "total": 2, "limit": 1, "offset": 1},
    )
    assert [
        r["id"] for r in client.product_cycles.iter("product-1", {"limit": 1, "is_archived": False})
    ] == ["a", "b"]
    assert transport.request_path() == "/api/v1/products/product-1/cycles"
    assert parse_qs(urlsplit(transport.requests[-1].url).query) == {
        "limit": ["1"],
        "offset": ["1"],
        "is_archived": ["false"],
    }


def test_report_run_preserves_empty_body_and_overrides() -> None:
    client, transport = make_client({"shape": "summary"}, {"shape": "table"})
    assert client.reports.run("report-1")["shape"] == "summary"
    assert transport.request_body() == {}
    body: ReportRunParams = {
        "page": {"size": 25, "offset": 50},
        "sort": [{"by": "created_at", "dir": "desc"}],
    }
    assert client.reports.run("report-1", body)["shape"] == "table"
    assert transport.request_body() == body
    assert transport.request_path() == "/api/v1/reports/report-1/run"


def test_report_iteration_clamps_page_size() -> None:
    client, transport = make_client({"data": [], "total": 0, "limit": 100, "offset": 3})
    assert list(client.reports.iter({"limit": 500, "offset": 3})) == []
    assert transport.request_path() == "/api/v1/reports"
    assert parse_qs(urlsplit(transport.requests[-1].url).query) == {
        "limit": ["100"],
        "offset": ["3"],
    }
