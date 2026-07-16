"""Tests for the auto-paginating ``iter`` methods on list resources."""

from __future__ import annotations

import json
from typing import Any, Optional
from urllib.parse import parse_qs, urlsplit

from otok import OtokClient
from otok._http import TransportRequest, TransportResponse


class PagedTransport:
    """Serves a fixed dataset through the standard ``{data, total, limit,
    offset}`` envelope, honoring the request's ``limit``/``offset`` query
    params and recording each requested page.
    """

    def __init__(self, total_rows: int) -> None:
        self.rows = [{"id": f"row-{i}"} for i in range(total_rows)]
        self.pages: list[dict[str, Any]] = []

    def send(self, request: TransportRequest) -> TransportResponse:
        query = parse_qs(urlsplit(request.url).query)
        limit = int(query["limit"][0])
        offset = int(query["offset"][0])
        self.pages.append({"limit": limit, "offset": offset, "query": query})
        body = {
            "data": self.rows[offset : offset + limit],
            "total": len(self.rows),
            "limit": limit,
            "offset": offset,
        }
        return TransportResponse(
            status=200,
            headers={"content-type": "application/json"},
            body=json.dumps(body).encode("utf-8"),
        )


def make_client(total_rows: int) -> tuple[OtokClient, PagedTransport]:
    transport = PagedTransport(total_rows)
    client = OtokClient(
        "otok_live_testkey",
        base_url="https://example.test/api",
        transport=transport,
    )
    return client, transport


def page_shapes(transport: PagedTransport) -> list[tuple[int, int]]:
    return [(page["limit"], page["offset"]) for page in transport.pages]


class TestPaginationIterators:
    def test_contacts_iter_pages_at_the_documented_cap_and_yields_every_row(self) -> None:
        client, transport = make_client(1201)
        contacts = list(client.contacts.iter())
        assert len(contacts) == 1201
        assert contacts[0]["id"] == "row-0"
        assert contacts[-1]["id"] == "row-1200"
        assert page_shapes(transport) == [(500, 0), (500, 500), (500, 1000)]

    def test_passes_a_smaller_page_size_override_through(self) -> None:
        client, transport = make_client(5)
        tags = list(client.tags.iter({"limit": 2}))
        assert len(tags) == 5
        assert page_shapes(transport) == [(2, 0), (2, 2), (2, 4)]

    def test_clamps_a_page_size_override_above_the_documented_cap(self) -> None:
        client, transport = make_client(1)
        list(client.contacts.iter({"limit": 9999}))
        assert transport.pages[0]["limit"] == 500

    def test_deals_iter_uses_the_deals_payments_cap(self) -> None:
        client, transport = make_client(150)
        deals = list(client.deals.iter({"limit": 250}))
        assert len(deals) == 150
        assert page_shapes(transport) == [(100, 0), (100, 100)]

    def test_payments_iter_defaults_to_the_100_cap(self) -> None:
        client, transport = make_client(3)
        list(client.payments.iter())
        assert page_shapes(transport) == [(100, 0)]

    def test_orders_iter_uses_the_deals_payments_cap(self) -> None:
        client, transport = make_client(150)
        orders = list(client.orders.iter({"limit": 250}))
        assert len(orders) == 150
        assert orders[0]["id"] == "row-0"
        assert orders[-1]["id"] == "row-149"
        assert page_shapes(transport) == [(100, 0), (100, 100)]

    def test_orders_iter_forwards_the_callers_filters_on_every_page(self) -> None:
        client, transport = make_client(250)
        list(client.orders.iter({"status": "paid", "source": "api"}))
        assert len(transport.pages) == 3
        for page in transport.pages:
            assert page["query"]["status"] == ["paid"]
            assert page["query"]["source"] == ["api"]

    def test_orders_iter_terminates_on_a_short_page_despite_a_stale_total(self) -> None:
        class StaleTotalTransport:
            """An order deleted between pages: the total still says more but
            the next page is empty — the iterator must terminate, not loop.
            """

            def __init__(self) -> None:
                self.calls = 0

            def send(self, request: TransportRequest) -> TransportResponse:
                self.calls += 1
                body: dict[str, Any] = {
                    "data": [{"id": "row-0"}] if self.calls == 1 else [],
                    "total": 80,
                    "limit": 100,
                    "offset": 0 if self.calls == 1 else 1,
                }
                return TransportResponse(
                    status=200,
                    headers={"content-type": "application/json"},
                    body=json.dumps(body).encode("utf-8"),
                )

        transport = StaleTotalTransport()
        client = OtokClient(
            "otok_live_testkey",
            base_url="https://example.test/api",
            transport=transport,
        )
        assert len(list(client.orders.iter())) == 1
        assert transport.calls == 2

    def test_orders_iter_handles_an_empty_result_set_with_a_single_request(self) -> None:
        client, transport = make_client(0)
        assert list(client.orders.iter()) == []
        assert page_shapes(transport) == [(100, 0)]

    def test_forwards_the_callers_filter_params_on_every_page(self) -> None:
        client, transport = make_client(750)
        list(
            client.contacts.iter(
                {"filter": {"lifecycle_stage": "customer"}, "sort": "-updated_at"}
            )
        )
        assert len(transport.pages) == 2
        for page in transport.pages:
            assert page["query"]["filter"] == ['{"lifecycle_stage":"customer"}']
            assert page["query"]["sort"] == ["-updated_at"]

    def test_starts_at_the_callers_offset(self) -> None:
        client, transport = make_client(600)
        contacts = list(client.contacts.iter({"offset": 550}))
        assert len(contacts) == 50
        assert contacts[0]["id"] == "row-550"
        assert page_shapes(transport) == [(500, 550)]

    def test_handles_an_empty_result_set_with_a_single_request(self) -> None:
        client, transport = make_client(0)
        assert list(client.contacts.iter()) == []
        assert len(transport.pages) == 1

    def test_stops_when_a_page_comes_back_short_even_if_total_says_more(self) -> None:
        class StaleTotalTransport:
            """Rows deleted between pages: a stale total but an empty page —
            the iterator must terminate rather than loop.
            """

            def __init__(self) -> None:
                self.calls = 0

            def send(self, request: TransportRequest) -> TransportResponse:
                self.calls += 1
                body: dict[str, Any] = {
                    "data": [{"id": "row-0"}] if self.calls == 1 else [],
                    "total": 400,
                    "limit": 500,
                    "offset": 0 if self.calls == 1 else 1,
                }
                return TransportResponse(
                    status=200,
                    headers={"content-type": "application/json"},
                    body=json.dumps(body).encode("utf-8"),
                )

        transport = StaleTotalTransport()
        client = OtokClient(
            "otok_live_testkey",
            base_url="https://example.test/api",
            transport=transport,
        )
        assert len(list(client.contacts.iter())) == 1
        assert transport.calls == 2

    def test_is_lazy_and_stops_requesting_once_the_consumer_breaks(self) -> None:
        client, transport = make_client(1500)
        found: Optional[dict[str, Any]] = None
        for contact in client.contacts.iter():
            if contact["id"] == "row-10":  # within the first page
                found = contact
                break
        assert found is not None
        assert len(transport.pages) == 1

    def test_every_standard_convention_resource_iterates_at_the_500_cap(self) -> None:
        client, transport = make_client(2)
        assert len(list(client.bookings.iter())) == 2
        assert len(list(client.campaigns.iter())) == 2
        assert len(list(client.templates.iter())) == 2
        assert len(list(client.contact_groups.iter())) == 2
        assert len(list(client.meeting_types.iter())) == 2
        assert all(limit == 500 for limit, _offset in page_shapes(transport))
