"""Wire contracts for intake, product cycles and shared saved reports."""

from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

from otok import (
    AttendancePayment,
    BookingDeposit,
    ContactUpsertParams,
    OtokClient,
    ProductCreateParams,
    ProductCycleUpdateParams,
    ReportRunParams,
)
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


def test_priced_event_opt_in_and_registration_payment_block() -> None:
    payment = {
        "sale_id": "sale-1",
        "sale_status": "active",
        "settlement_status": "unpaid",
        "pay_url": "https://pay.test/p/1",
    }
    client, transport = make_client(
        {"id": "event-3", "collect_payment_on_registration": True, "duplicate": False},
        {"id": "att-2", "payment_sale_id": "sale-1", "payment": payment, "created": True},
    )
    event = client.events.upsert(
        {"name": "Paid workshop", "collect_payment_on_registration": True}
    )
    assert transport.request_body() == {
        "name": "Paid workshop",
        "collect_payment_on_registration": True,
    }
    result = client.events.register(event["id"], {"contact_id": "c-1"})
    typed: AttendancePayment = result["payment"]
    assert typed["settlement_status"] == "unpaid"
    assert result["payment_sale_id"] == "sale-1"


def test_cycle_rearm_and_product_pricing_fields_survive_serialization() -> None:
    client, transport = make_client(
        {"id": "cycle-1", "rearmed_fires": 3},
        {"id": "product-1", "duplicate": False},
    )
    cycle_body: ProductCycleUpdateParams = {
        "starts_on": "2026-11-01",
        "rearm_date_triggers": True,
        "dynamic_pricing": False,
    }
    assert client.product_cycles.update("cycle-1", cycle_body)["rearmed_fires"] == 3
    assert transport.request_body() == cycle_body
    product_body: ProductCreateParams = {
        "name": "Course",
        "dynamic_pricing": False,
        "recurring_sale_policy": "per_period",
    }
    client.products.create(product_body)
    assert transport.request_body() == product_body


def test_booking_deposit_block_is_read_verbatim() -> None:
    deposit: BookingDeposit = {
        "state": "awaiting",
        "amount": 100.0,
        "hold_until": "2026-10-07T10:00:00.000Z",
        "sale_id": "sale-9",
    }
    client, _ = make_client({"id": "booking-1", "status": "confirmed", "deposit": deposit})
    assert client.bookings.get("booking-1")["deposit"] == deposit
