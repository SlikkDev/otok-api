"""Tests for the high-level commerce layer (identify_customer / track_order)."""

from __future__ import annotations

import pytest

from otok import (
    OtokClient,
    customer_to_contact_params,
    order_external_reference,
    order_receipt_idempotency_key,
)
from tests.helpers import MockTransport, json_response


def make_client(transport: MockTransport) -> OtokClient:
    return OtokClient(
        "otok_live_testkey",
        base_url="https://example.test/api",
        transport=transport,
    )


def commerce_transport() -> MockTransport:
    """Responses for the contact → deal → email call sequence."""
    return MockTransport(
        [
            json_response(
                201, {"id": "contact-1", "email": "jane@example.com", "duplicate": False}
            ),
            json_response(201, {"id": "deal-1", "status": "open", "duplicate": False}),
            json_response(
                201,
                {
                    "id": "send-1",
                    "status": "sent",
                    "duplicate": False,
                    "to": "jane@example.com",
                    "idempotency_key": "order:A-1001:receipt",
                    "provider_message_id": "prov-1",
                    "reason": None,
                    "created_at": "2026-07-14T00:00:00.000Z",
                },
            ),
        ]
    )


class TestCustomerToContactParams:
    def test_maps_customer_fields_to_wire_format_contact_fields(self) -> None:
        params = customer_to_contact_params(
            {
                "email": "jane@example.com",
                "phone": "+12025551234",
                "first_name": "Jane",
                "last_name": "Doe",
                "tags": ["VIP"],
                "groups": ["Customers"],
                "address": {"line1": "1 Main St", "city": "Tel Aviv", "postal_code": "12345"},
                "custom_fields": {"plan": "gold"},
                "extra": {"utm_source": "shop"},
            }
        )
        assert params == {
            "email": "jane@example.com",
            "phone": "+12025551234",
            "first_name": "Jane",
            "last_name": "Doe",
            "tags": ["VIP"],
            "groups": ["Customers"],
            "address_line1": "1 Main St",
            "city": "Tel Aviv",
            "postal_code": "12345",
            "custom_fields": {"plan": "gold"},
            "utm_source": "shop",
        }

    def test_requires_at_least_an_email_or_a_phone(self) -> None:
        with pytest.raises(ValueError, match="email or a phone"):
            customer_to_contact_params({"name": "Nobody"})


class TestIdempotencyKeyDerivation:
    def test_is_deterministic_per_order(self) -> None:
        assert order_external_reference("A-1001") == "order:A-1001"
        assert order_receipt_idempotency_key("A-1001") == "order:A-1001:receipt"


class TestIdentifyCustomer:
    def test_upserts_via_post_v1_contacts(self) -> None:
        transport = MockTransport([json_response(201, {"id": "contact-1"})])
        client = make_client(transport)
        contact = client.commerce.identify_customer(
            {"email": "jane@example.com", "first_name": "Jane"}
        )
        assert contact["id"] == "contact-1"
        assert transport.request_paths() == ["/api/v1/contacts"]
        assert transport.requests[0].method == "POST"
        assert transport.request_body(0) == {"email": "jane@example.com", "first_name": "Jane"}


class TestTrackOrder:
    def test_upserts_contact_creates_idempotent_deal_and_sends_one_receipt(self) -> None:
        transport = commerce_transport()
        client = make_client(transport)

        result = client.commerce.track_order(
            {
                "order_id": "A-1001",
                "customer": {"email": "jane@example.com", "name": "Jane Doe"},
                "total": 249.9,
                "currency": "USD",
                "note": "2 items",
                "receipt": {"subject": "Your order A-1001", "html": "<p>Thanks!</p>"},
            }
        )

        assert result.contact["id"] == "contact-1"
        assert result.deal["id"] == "deal-1"
        assert result.receipt is not None
        assert result.receipt["id"] == "send-1"

        assert transport.request_paths() == [
            "/api/v1/contacts",
            "/api/v1/deals",
            "/api/v1/emails",
        ]

        deal_body = transport.request_body(1)
        assert deal_body == {
            "contact_id": "contact-1",
            "amount": 249.9,
            "currency": "USD",
            "note": "2 items",
            "external_reference": "order:A-1001",
            "title": "Order A-1001",
        }

        email_body = transport.request_body(2)
        assert email_body["to"] == "jane@example.com"
        assert email_body["subject"] == "Your order A-1001"
        assert email_body["idempotency_key"] == "order:A-1001:receipt"
        assert email_body["metadata"] == {"order_id": "A-1001"}

    def test_omits_the_title_so_it_derives_from_the_product_when_a_sku_is_attached(self) -> None:
        transport = commerce_transport()
        client = make_client(transport)
        client.commerce.track_order(
            {
                "order_id": "A-2002",
                "customer": {"phone": "+12025551234"},
                "total": 50,
                "product_sku": "SKU-1",
            }
        )
        deal_body = transport.request_body(1)
        assert deal_body["product_sku"] == "SKU-1"
        assert "title" not in deal_body

    def test_skips_the_receipt_when_not_requested(self) -> None:
        transport = commerce_transport()
        client = make_client(transport)
        result = client.commerce.track_order(
            {
                "order_id": "A-3003",
                "customer": {"email": "j@example.com"},
                "total": 10,
            }
        )
        assert result.receipt is None
        assert transport.request_paths() == ["/api/v1/contacts", "/api/v1/deals"]

    def test_rejects_a_receipt_without_a_customer_email(self) -> None:
        transport = commerce_transport()
        client = make_client(transport)
        with pytest.raises(ValueError, match="customer email"):
            client.commerce.track_order(
                {
                    "order_id": "A-4004",
                    "customer": {"phone": "+12025551234"},
                    "total": 10,
                    "receipt": {"subject": "hi", "text": "hello"},
                }
            )

    def test_requires_an_order_id(self) -> None:
        transport = commerce_transport()
        client = make_client(transport)
        with pytest.raises(ValueError, match="order_id"):
            client.commerce.track_order(
                {
                    "order_id": "",
                    "customer": {"email": "j@example.com"},
                    "total": 10,
                }
            )
