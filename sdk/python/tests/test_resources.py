"""Parity tests: every resource method issues the documented verb + path
+ query/body, mirroring the Node SDK's surface.
"""

from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

import pytest

from otok import (
    BOOKING_WEBHOOK_EVENT_TYPES,
    CONTACT_WEBHOOK_EVENT_TYPES,
    DEAL_WEBHOOK_EVENT_TYPES,
    DEFAULT_EMAIL_WEBHOOK_EVENT_TYPES,
    EMAIL_WEBHOOK_EVENT_TYPES,
    EVENT_ATTENDANCE_WEBHOOK_EVENT_TYPES,
    FORM_WEBHOOK_EVENT_TYPES,
    MESSAGE_WEBHOOK_EVENT_TYPES,
    ORDER_WEBHOOK_EVENT_TYPES,
    PAYMENT_REQUEST_WEBHOOK_EVENT_TYPES,
    OtokAPIError,
    OtokClient,
)
from otok._http import TransportRequest, TransportResponse
from tests.helpers import MockTransport, json_response


def make_client(*responses: TransportResponse) -> tuple[OtokClient, MockTransport]:
    transport = MockTransport(list(responses) or [json_response(200, {})])
    client = OtokClient(
        "otok_live_testkey",
        base_url="https://example.test/api",
        transport=transport,
    )
    return client, transport


def last_request(transport: MockTransport) -> TransportRequest:
    return transport.requests[-1]


def query_of(request: TransportRequest) -> dict[str, list[str]]:
    return parse_qs(urlsplit(request.url).query)


class TestContacts:
    def test_list_serializes_shared_list_params(self) -> None:
        client, transport = make_client()
        client.contacts.list(
            {
                "filter": {"lifecycle_stage": "lead"},
                "sort": "-updated_at",
                "limit": 25,
                "offset": 50,
                "search": "dana",
            }
        )
        request = last_request(transport)
        assert request.method == "GET"
        assert urlsplit(request.url).path == "/api/v1/contacts"
        assert query_of(request) == {
            "filter": ['{"lifecycle_stage":"lead"}'],
            "sort": ["-updated_at"],
            "limit": ["25"],
            "offset": ["50"],
            "search": ["dana"],
        }

    def test_get_upsert_and_update(self) -> None:
        client, transport = make_client()
        client.contacts.get("c-1")
        assert (last_request(transport).method, transport.request_path()) == (
            "GET",
            "/api/v1/contacts/c-1",
        )
        client.contacts.upsert({"email": "a@b.co", "tags": ["VIP"]})
        assert (last_request(transport).method, transport.request_path()) == (
            "POST",
            "/api/v1/contacts",
        )
        assert transport.request_body() == {"email": "a@b.co", "tags": ["VIP"]}
        client.contacts.update("c-1", {"lifecycle_stage": "customer"})
        assert (last_request(transport).method, transport.request_path()) == (
            "PATCH",
            "/api/v1/contacts/c-1",
        )

    def test_upsert_surfaces_the_top_level_duplicate_marker(self) -> None:
        # 201 in both outcomes; duplicate=True means an existing contact was
        # matched and updated instead of created.
        client, _ = make_client(
            json_response(201, {"id": "c-1", "phone": "+12025551234", "duplicate": True})
        )
        contact = client.contacts.upsert({"phone": "+12025551234"})
        assert contact["duplicate"] is True

    def test_notes_endpoints(self) -> None:
        client, transport = make_client()
        client.contacts.list_notes("c-1")
        assert (last_request(transport).method, transport.request_path()) == (
            "GET",
            "/api/v1/contacts/c-1/notes",
        )
        client.contacts.create_note("c-1", "Asked for a demo", pinned=True)
        assert (last_request(transport).method, transport.request_path()) == (
            "POST",
            "/api/v1/contacts/c-1/notes",
        )
        assert transport.request_body() == {"body": "Asked for a demo", "pinned": True}
        client.contacts.update_note("n-1", body="Edited")
        assert (last_request(transport).method, transport.request_path()) == (
            "PATCH",
            "/api/v1/notes/n-1",
        )
        assert transport.request_body() == {"body": "Edited"}
        client.contacts.delete_note("n-1")
        assert (last_request(transport).method, transport.request_path()) == (
            "DELETE",
            "/api/v1/notes/n-1",
        )


class TestContactDocuments:
    def test_defaults_to_a_stored_only_read_without_a_live_param(self) -> None:
        client, transport = make_client(
            json_response(
                200,
                {
                    "documents": [],
                    "live": {"attempted": False, "ok": True, "complete": True, "error": None},
                },
            )
        )
        result = client.contacts.list_documents("c-1")
        request = last_request(transport)
        assert request.method == "GET"
        assert urlsplit(request.url).path == "/api/v1/contacts/c-1/documents"
        assert query_of(request) == {}
        assert result["live"]["attempted"] is False
        assert result["documents"] == []

    def test_serializes_the_live_opt_in(self) -> None:
        client, transport = make_client(
            json_response(
                200,
                {
                    "documents": [
                        {
                            "key": "sumit:123456",
                            "kind": "tax_invoice_receipt",
                            "rawType": None,
                            "isCredit": False,
                            "provider": "sumit",
                            "documentId": "123456",
                            "number": "2043",
                            # Legacy number-only rows have no URL — callers
                            # must check before opening.
                            "url": None,
                            "date": "2026-07-14T10:00:00.000Z",
                            "amount": 350,
                            "currency": "ILS",
                            "origin": "merged",
                            "sources": [
                                {"type": "contact_payment", "id": "p-1"},
                                {"type": "provider", "provider": "sumit"},
                            ],
                        }
                    ],
                    "live": {"attempted": True, "ok": True, "complete": True, "error": None},
                },
            )
        )
        result = client.contacts.list_documents("c-1", live=True)
        assert query_of(last_request(transport)) == {"live": ["true"]}
        assert result["live"]["attempted"] is True
        assert result["documents"][0]["kind"] == "tax_invoice_receipt"
        assert result["documents"][0]["url"] is None

    def test_404s_exactly_like_contacts_get_for_an_unknown_contact(self) -> None:
        client, _ = make_client(
            json_response(
                404,
                {
                    "statusCode": 404,
                    "error": "Not Found",
                    "message": "contacts with ID c-missing not found",
                },
            )
        )
        with pytest.raises(OtokAPIError) as excinfo:
            client.contacts.list_documents("c-missing")
        assert excinfo.value.status == 404


class TestTagsAndGroups:
    def test_tags_crud(self) -> None:
        client, transport = make_client()
        client.tags.list({"search": "vip"})
        assert transport.request_path() == "/api/v1/tags"
        client.tags.get("t-1")
        assert transport.request_path() == "/api/v1/tags/t-1"
        client.tags.create({"name": "VIP", "color": "#f59e0b", "type": "contact"})
        assert (last_request(transport).method, transport.request_path()) == (
            "POST",
            "/api/v1/tags",
        )
        client.tags.update("t-1", {"color": "#000000"})
        assert (last_request(transport).method, transport.request_path()) == (
            "PATCH",
            "/api/v1/tags/t-1",
        )

    def test_contact_groups_crud(self) -> None:
        client, transport = make_client()
        client.contact_groups.list()
        assert transport.request_path() == "/api/v1/contact-groups"
        client.contact_groups.get("g-1")
        assert transport.request_path() == "/api/v1/contact-groups/g-1"
        client.contact_groups.create({"name": "Beta testers"})
        assert (last_request(transport).method, transport.request_path()) == (
            "POST",
            "/api/v1/contact-groups",
        )
        client.contact_groups.update("g-1", {"description": "Updated"})
        assert (last_request(transport).method, transport.request_path()) == (
            "PATCH",
            "/api/v1/contact-groups/g-1",
        )


class TestPipelinesAndDeals:
    def test_pipelines_list_returns_the_bare_array(self) -> None:
        client, transport = make_client(json_response(200, [{"id": "p-1", "stages": []}]))
        result = client.pipelines.list()
        assert result == [{"id": "p-1", "stages": []}]
        assert transport.request_path() == "/api/v1/pipelines"

    def test_deals_list_uses_dedicated_query_params(self) -> None:
        client, transport = make_client()
        client.deals.list(
            {
                "pipeline_id": "p-1",
                "status": "open",
                "external_reference": "order:A-1001",
                "limit": 10,
            }
        )
        request = last_request(transport)
        assert urlsplit(request.url).path == "/api/v1/deals"
        assert query_of(request) == {
            "pipeline_id": ["p-1"],
            "status": ["open"],
            "external_reference": ["order:A-1001"],
            "limit": ["10"],
        }

    def test_deal_writes(self) -> None:
        client, transport = make_client()
        client.deals.create({"contact_id": "c-1", "title": "Deal", "external_reference": "x-1"})
        assert (last_request(transport).method, transport.request_path()) == (
            "POST",
            "/api/v1/deals",
        )
        client.deals.get("d-1")
        assert transport.request_path() == "/api/v1/deals/d-1"
        client.deals.update("d-1", {"amount": 100})
        assert (last_request(transport).method, transport.request_path()) == (
            "PATCH",
            "/api/v1/deals/d-1",
        )
        client.deals.move_stage("d-1", {"stage_id": "s-2", "index": 0})
        assert (last_request(transport).method, transport.request_path()) == (
            "POST",
            "/api/v1/deals/d-1/stage",
        )
        assert transport.request_body() == {"stage_id": "s-2", "index": 0}
        client.deals.set_status("d-1", {"status": "won"})
        assert (last_request(transport).method, transport.request_path()) == (
            "POST",
            "/api/v1/deals/d-1/status",
        )
        assert transport.request_body() == {"status": "won"}

    def test_create_surfaces_the_top_level_duplicate_marker(self) -> None:
        # 201 in both outcomes; duplicate=True means external_reference
        # matched an existing deal that was updated instead.
        client, _ = make_client(
            json_response(201, {"id": "d-1", "external_reference": "x-1", "duplicate": True})
        )
        deal = client.deals.create({"contact_id": "c-1", "external_reference": "x-1"})
        assert deal["duplicate"] is True


class TestEmailsAndWebhookEndpoints:
    def test_email_send(self) -> None:
        client, transport = make_client()
        client.emails.send(
            {
                "to": "a@b.co",
                "subject": "Hi",
                "html": "<p>Hi</p>",
                "idempotency_key": "k-1",
                "tracking": {"opens": True, "clicks": True},
            }
        )
        assert (last_request(transport).method, transport.request_path()) == (
            "POST",
            "/api/v1/emails",
        )
        assert transport.request_body()["idempotency_key"] == "k-1"

    def test_webhook_endpoint_management(self) -> None:
        client, transport = make_client(
            json_response(201, {"id": "we-1", "secret": "whsec_x"}),
            json_response(200, {"data": []}),
            TransportResponse(status=204, headers={}, body=b""),
        )
        created = client.webhook_endpoints.create(
            {"url": "https://hooks.example.com/otok", "events": ["email.delivered"]}
        )
        assert created["secret"] == "whsec_x"
        assert (last_request(transport).method, transport.request_path()) == (
            "POST",
            "/api/v1/webhook-endpoints",
        )
        client.webhook_endpoints.list()
        assert (last_request(transport).method, transport.request_path()) == (
            "GET",
            "/api/v1/webhook-endpoints",
        )
        client.webhook_endpoints.delete("we-1")
        assert (last_request(transport).method, transport.request_path()) == (
            "DELETE",
            "/api/v1/webhook-endpoints/we-1",
        )

    def test_create_without_events_omits_the_key_so_the_server_default_applies(self) -> None:
        client, transport = make_client(json_response(201, {"id": "we-1", "secret": "whsec_x"}))
        client.webhook_endpoints.create({"url": "https://hooks.example.com/otok"})
        assert transport.request_body() == {"url": "https://hooks.example.com/otok"}

    def test_event_type_constants_pin_the_wire_contract(self) -> None:
        # Omitted `events` subscribes to the three delivery events.
        assert DEFAULT_EMAIL_WEBHOOK_EVENT_TYPES == (
            "email.delivered",
            "email.bounced",
            "email.complained",
        )
        # email.failed is deprecated: accepted at registration, never fires —
        # so it stays registrable but is not part of the default set.
        assert "email.failed" not in DEFAULT_EMAIL_WEBHOOK_EVENT_TYPES
        assert "email.failed" in EMAIL_WEBHOOK_EVENT_TYPES

    def test_order_event_types_are_registrable_but_never_defaulted(self) -> None:
        assert ORDER_WEBHOOK_EVENT_TYPES == (
            "order.created",
            "order.paid",
            "order.refunded",
            "order.cancelled",
            "order.fulfilled",
        )
        # Order events are opt-in by listing: an endpoint registered without
        # an explicit `events` list gets only the email delivery defaults.
        # (Widened to str so mypy doesn't flag the deliberately non-overlapping
        # Literal comparison — the assertion's whole point.)
        defaults: tuple[str, ...] = DEFAULT_EMAIL_WEBHOOK_EVENT_TYPES
        for event_type in ORDER_WEBHOOK_EVENT_TYPES:
            assert event_type not in defaults

    def test_payment_request_event_types_are_registrable_but_never_defaulted(self) -> None:
        assert PAYMENT_REQUEST_WEBHOOK_EVENT_TYPES == (
            "payment_request.created",
            "payment_request.paid",
            "payment_request.expired",
            "payment_request.cancelled",
        )
        # Payment-request events are opt-in by listing, like the order
        # events: an endpoint registered without an explicit `events` list
        # gets only the email delivery defaults.
        defaults: tuple[str, ...] = DEFAULT_EMAIL_WEBHOOK_EVENT_TYPES
        for event_type in PAYMENT_REQUEST_WEBHOOK_EVENT_TYPES:
            assert event_type not in defaults

    def test_order_events_are_listed_verbatim_at_registration(self) -> None:
        client, transport = make_client(json_response(201, {"id": "we-1", "secret": "whsec_x"}))
        client.webhook_endpoints.create(
            {
                "url": "https://hooks.example.com/otok",
                "events": ["order.created", "order.paid", "order.refunded"],
            }
        )
        assert transport.request_body() == {
            "url": "https://hooks.example.com/otok",
            "events": ["order.created", "order.paid", "order.refunded"],
        }

    def test_new_family_event_types_are_registrable_but_never_defaulted(self) -> None:
        assert CONTACT_WEBHOOK_EVENT_TYPES == (
            "contact.created",
            "contact.updated",
            "contact.deleted",
            "contact.consent_changed",
        )
        assert MESSAGE_WEBHOOK_EVENT_TYPES == ("message.received",)
        assert DEAL_WEBHOOK_EVENT_TYPES == (
            "deal.created",
            "deal.stage_changed",
            "deal.won",
            "deal.lost",
        )
        assert BOOKING_WEBHOOK_EVENT_TYPES == (
            "booking.created",
            "booking.rescheduled",
            "booking.cancelled",
            "booking.reassigned",
        )
        assert EVENT_ATTENDANCE_WEBHOOK_EVENT_TYPES == ("event.attendance.changed",)
        assert FORM_WEBHOOK_EVENT_TYPES == ("form.submitted",)
        # Every new family is opt-in by listing: an endpoint registered
        # without an explicit `events` list gets only the email delivery
        # defaults.
        defaults: tuple[str, ...] = DEFAULT_EMAIL_WEBHOOK_EVENT_TYPES
        new_family_types: tuple[str, ...] = (
            CONTACT_WEBHOOK_EVENT_TYPES
            + MESSAGE_WEBHOOK_EVENT_TYPES
            + DEAL_WEBHOOK_EVENT_TYPES
            + BOOKING_WEBHOOK_EVENT_TYPES
            + EVENT_ATTENDANCE_WEBHOOK_EVENT_TYPES
            + FORM_WEBHOOK_EVENT_TYPES
        )
        assert len(new_family_types) == 15
        for event_type in new_family_types:
            assert event_type not in defaults

    def test_new_family_events_are_listed_verbatim_at_registration(self) -> None:
        client, transport = make_client(json_response(201, {"id": "we-2", "secret": "whsec_y"}))
        client.webhook_endpoints.create(
            {
                "url": "https://hooks.example.com/otok",
                "events": [
                    "contact.created",
                    "message.received",
                    "deal.won",
                    "booking.created",
                    "event.attendance.changed",
                    "form.submitted",
                ],
            }
        )
        assert transport.request_body() == {
            "url": "https://hooks.example.com/otok",
            "events": [
                "contact.created",
                "message.received",
                "deal.won",
                "booking.created",
                "event.attendance.changed",
                "form.submitted",
            ],
        }


class TestProducts:
    def test_list_serializes_every_documented_filter(self) -> None:
        client, transport = make_client(
            json_response(200, {"data": [], "total": 0, "limit": 50, "offset": 0})
        )
        client.products.list(
            {
                "q": "onboarding",
                "sku": "SKU-1",
                "external_id": "prod-9",
                "is_active": True,
                "limit": 10,
                "offset": 20,
            }
        )
        request = last_request(transport)
        assert request.method == "GET"
        assert urlsplit(request.url).path == "/api/v1/products"
        assert query_of(request) == {
            "q": ["onboarding"],
            "sku": ["SKU-1"],
            "external_id": ["prod-9"],
            "is_active": ["true"],
            "limit": ["10"],
            "offset": ["20"],
        }

    def test_create_surfaces_the_upsert_duplicate_marker(self) -> None:
        # 201 in both outcomes; duplicate=True means the external_id matched
        # an existing product that was updated instead of created.
        client, transport = make_client(
            json_response(
                201,
                {
                    "id": "product-1",
                    "name": "Onboarding package",
                    "external_id": "prod-9",
                    "duplicate": True,
                },
            )
        )
        product = client.products.create(
            {"name": "Onboarding package", "external_id": "prod-9", "price": 249.9}
        )
        assert product["duplicate"] is True
        assert (last_request(transport).method, transport.request_path()) == (
            "POST",
            "/api/v1/products",
        )
        assert transport.request_body() == {
            "name": "Onboarding package",
            "external_id": "prod-9",
            "price": 249.9,
        }

    def test_get_and_update(self) -> None:
        client, transport = make_client(json_response(200, {"id": "product-1"}))
        client.products.get("product-1")
        assert (last_request(transport).method, transport.request_path()) == (
            "GET",
            "/api/v1/products/product-1",
        )
        client.products.update("product-1", {"is_active": False})
        assert (last_request(transport).method, transport.request_path()) == (
            "PATCH",
            "/api/v1/products/product-1",
        )
        assert transport.request_body() == {"is_active": False}

    def test_conflict_raises_a_coded_409(self) -> None:
        client, _ = make_client(
            json_response(
                409,
                {
                    "error": {
                        "code": "product_conflict",
                        "message": "A product with this sku or external_id already exists",
                    }
                },
            )
        )
        with pytest.raises(OtokAPIError) as exc_info:
            client.products.create({"name": "P", "sku": "SKU-1"})
        assert exc_info.value.status == 409
        assert exc_info.value.code == "product_conflict"


class TestSuppressions:
    def test_list_serializes_the_email_filter_and_paging(self) -> None:
        client, transport = make_client(
            json_response(200, {"data": [], "total": 0, "limit": 50, "offset": 0})
        )
        client.suppressions.list({"email": "jane@example.com", "limit": 5})
        request = last_request(transport)
        assert request.method == "GET"
        assert urlsplit(request.url).path == "/api/v1/suppressions"
        assert query_of(request) == {"email": ["jane@example.com"], "limit": ["5"]}

    def test_create_is_an_idempotent_add_with_a_duplicate_marker(self) -> None:
        client, transport = make_client(
            json_response(
                201,
                {
                    "id": "sup-1",
                    "email": "jane@example.com",
                    "reason": "manual",
                    "duplicate": True,
                },
            )
        )
        row = client.suppressions.create(
            {"email": "jane@example.com", "reason": "manual", "note": "asked by phone"}
        )
        assert row["duplicate"] is True
        assert transport.request_body() == {
            "email": "jane@example.com",
            "reason": "manual",
            "note": "asked by phone",
        }

    def test_delete_returns_none_on_204(self) -> None:
        client, transport = make_client(json_response(204))
        client.suppressions.delete("sup-1")
        assert (last_request(transport).method, transport.request_path()) == (
            "DELETE",
            "/api/v1/suppressions/sup-1",
        )

    def test_missing_email_marketing_feature_raises_a_coded_403(self) -> None:
        client, _ = make_client(
            json_response(
                403,
                {
                    "message": (
                        "Your current plan does not include access to this feature: "
                        "email_marketing. Please upgrade your plan."
                    ),
                    "error_code": "FEATURE_NOT_INCLUDED_IN_PLAN",
                },
            )
        )
        with pytest.raises(OtokAPIError) as exc_info:
            client.suppressions.list()
        assert exc_info.value.status == 403
        assert exc_info.value.code == "FEATURE_NOT_INCLUDED_IN_PLAN"


class TestContactConsent:
    def test_get_consent_reads_both_channels(self) -> None:
        client, transport = make_client(
            json_response(
                200,
                {
                    "contact_id": "c-1",
                    "block_state": "none",
                    "channels": {
                        "whatsapp": {"consent_state": "unknown", "deliverability": "unknown"},
                        "email": {
                            "consent_state": "subscribed",
                            "deliverability": "deliverable",
                            "suppressed": False,
                            "suppression_reason": None,
                        },
                    },
                },
            )
        )
        consent = client.contacts.get_consent("c-1")
        assert (last_request(transport).method, transport.request_path()) == (
            "GET",
            "/api/v1/contacts/c-1/consent",
        )
        assert consent["channels"]["email"]["suppressed"] is False

    def test_set_consent_puts_the_decision_to_the_channel_route(self) -> None:
        client, transport = make_client(
            json_response(
                200,
                {
                    "consent_state": "subscribed",
                    "consent_source": "api:crm-sync",
                    "deliverability": "deliverable",
                },
            )
        )
        channel = client.contacts.set_consent(
            "c-1",
            "email",
            {"state": "subscribed", "basis": "express_opt_in", "source": "crm-sync"},
        )
        assert (last_request(transport).method, transport.request_path()) == (
            "PUT",
            "/api/v1/contacts/c-1/consent/email",
        )
        assert transport.request_body() == {
            "state": "subscribed",
            "basis": "express_opt_in",
            "source": "crm-sync",
        }
        assert channel["consent_state"] == "subscribed"

    def test_complained_channel_raises_the_sticky_409(self) -> None:
        client, _ = make_client(
            json_response(
                409,
                {
                    "error": {
                        "code": "consent_sticky_complained",
                        "message": (
                            "This channel has a spam complaint on record; consent "
                            "cannot be re-subscribed via the API."
                        ),
                    }
                },
            )
        )
        with pytest.raises(OtokAPIError) as exc_info:
            client.contacts.set_consent("c-1", "email", {"state": "subscribed"})
        assert exc_info.value.status == 409
        assert exc_info.value.code == "consent_sticky_complained"


class TestCampaignsAndTemplates:
    def test_campaigns(self) -> None:
        client, transport = make_client()
        client.campaigns.list({"filter": {"status": "scheduled"}})
        assert transport.request_path() == "/api/v1/campaigns"
        client.campaigns.get("cmp-1")
        assert transport.request_path() == "/api/v1/campaigns/cmp-1"
        client.campaigns.create({"name": "July promo", "status": "scheduled"})
        assert (last_request(transport).method, transport.request_path()) == (
            "POST",
            "/api/v1/campaigns",
        )
        client.campaigns.update("cmp-1", {"status": "draft"})
        assert (last_request(transport).method, transport.request_path()) == (
            "PATCH",
            "/api/v1/campaigns/cmp-1",
        )
        client.campaigns.execute("cmp-1")
        request = last_request(transport)
        assert (request.method, transport.request_path()) == (
            "POST",
            "/api/v1/campaigns/cmp-1/execute",
        )
        assert request.body is None  # no request body on execute

    def test_execute_returns_the_200_success_body(self) -> None:
        client, _ = make_client(
            json_response(
                200,
                {
                    "success": True,
                    "message": "Campaign queued for execution",
                    "jobId": "execute-cmp-1",
                },
            )
        )
        result = client.campaigns.execute("cmp-1")
        assert result["success"] is True
        assert result["jobId"] == "execute-cmp-1"

    def test_execute_failures_raise_api_errors_with_machine_readable_codes(self) -> None:
        # A non-scheduled campaign is a 409, not a 2xx with success=false.
        client, _ = make_client(
            json_response(
                409,
                {
                    "error": {
                        "code": "campaign_not_scheduled",
                        "message": (
                            "Campaign status is 'draft' — only 'scheduled' "
                            "campaigns can be executed"
                        ),
                    }
                },
            )
        )
        with pytest.raises(OtokAPIError) as excinfo:
            client.campaigns.execute("cmp-1")
        assert excinfo.value.status == 409
        assert excinfo.value.code == "campaign_not_scheduled"

        client, _ = make_client(
            json_response(
                404,
                {"error": {"code": "campaign_not_found", "message": "Campaign not found"}},
            )
        )
        with pytest.raises(OtokAPIError) as excinfo:
            client.campaigns.execute("cmp-missing")
        assert excinfo.value.status == 404
        assert excinfo.value.code == "campaign_not_found"

    def test_templates(self) -> None:
        client, transport = make_client()
        client.templates.list({"filter": {"status": "approved"}})
        assert transport.request_path() == "/api/v1/templates"
        client.templates.get("tpl-1")
        assert transport.request_path() == "/api/v1/templates/tpl-1"
        client.templates.send(
            "tpl-1",
            {
                "to": "+972501234567",
                "body_variables": [{"type": "text", "text": "Dana", "param_name": "name"}],
            },
        )
        assert (last_request(transport).method, transport.request_path()) == (
            "POST",
            "/api/v1/templates/tpl-1/send",
        )
        assert transport.request_body()["to"] == "+972501234567"


class TestEmailCampaigns:
    def test_list_serializes_the_status_filter_and_paging(self) -> None:
        client, transport = make_client(
            json_response(200, {"data": [], "total": 0, "limit": 25, "offset": 0})
        )
        client.email_campaigns.list({"status": "draft", "limit": 10, "offset": 5})
        request = last_request(transport)
        assert request.method == "GET"
        assert urlsplit(request.url).path == "/api/v1/email-campaigns"
        assert query_of(request) == {"status": ["draft"], "limit": ["10"], "offset": ["5"]}

    def test_get_reads_the_full_campaign(self) -> None:
        client, transport = make_client()
        client.email_campaigns.get("ec-1")
        assert (last_request(transport).method, transport.request_path()) == (
            "GET",
            "/api/v1/email-campaigns/ec-1",
        )

    def test_create_posts_the_content_contract_and_surfaces_the_compile_envelope(self) -> None:
        client, transport = make_client(
            json_response(
                201,
                {
                    "id": "ec-1",
                    "status": "draft",
                    "subject": "Big news, [[first_name : there]]!",
                    "preheader": None,
                    "duplicate": False,
                    "compile": {"ok": True, "errors": [], "warnings": []},
                },
            )
        )
        campaign = client.email_campaigns.create(
            {
                "name": "July product launch",
                "subject": "Big news, [[first_name : there]]!",
                "sender_profile_id": "sp-1",
                "external_reference": "launch-2026-07",
                "content": {
                    "direction": "ltr",
                    "markdown": "# Hello\n\n::button[Read more](https://example.com)",
                },
            }
        )
        assert (last_request(transport).method, transport.request_path()) == (
            "POST",
            "/api/v1/email-campaigns",
        )
        assert transport.request_body()["content"]["markdown"].startswith("# Hello")
        assert transport.request_body()["external_reference"] == "launch-2026-07"
        # The campaign row answers under the request field names (subject,
        # not subject_override) with the write-time compile report attached.
        assert campaign["subject"] == "Big news, [[first_name : there]]!"
        assert campaign["compile"]["ok"] is True
        assert campaign["duplicate"] is False

    def test_create_replay_surfaces_the_duplicate_marker(self) -> None:
        # 201 either way; a post-launch verbatim replay carries no compile
        # envelope at all.
        client, _ = make_client(
            json_response(
                201,
                {"id": "ec-1", "status": "sent", "duplicate": True},
            )
        )
        campaign = client.email_campaigns.create(
            {
                "name": "July product launch",
                "subject": "Big news!",
                "sender_profile_id": "sp-1",
                "external_reference": "launch-2026-07",
                "content": {"markdown": "# Hello"},
            }
        )
        assert campaign["duplicate"] is True
        assert "compile" not in campaign

    def test_content_contract_violations_raise_coded_400s(self) -> None:
        client, _ = make_client(
            json_response(
                400,
                {
                    "error": {
                        "code": "invalid_content",
                        "message": (
                            'content must include exactly one of "markdown", '
                            '"blocks", or "design_json"'
                        ),
                    }
                },
            )
        )
        with pytest.raises(OtokAPIError) as exc_info:
            client.email_campaigns.create(
                {
                    "name": "Broken",
                    "subject": "s",
                    "sender_profile_id": "sp-1",
                    "content": {},
                }
            )
        assert exc_info.value.status == 400
        assert exc_info.value.code == "invalid_content"

        client, _ = make_client(
            json_response(
                400,
                {
                    "error": {
                        "code": "unknown_snippet",
                        "message": 'Unknown snippet "footer". Available snippets: Header, Legal',
                    }
                },
            )
        )
        with pytest.raises(OtokAPIError) as exc_info:
            client.email_campaigns.create(
                {
                    "name": "Broken",
                    "subject": "s",
                    "sender_profile_id": "sp-1",
                    "content": {"markdown": "::snippet[footer]"},
                }
            )
        assert exc_info.value.status == 400
        assert exc_info.value.code == "unknown_snippet"

    def test_update_patches_the_campaign(self) -> None:
        client, transport = make_client()
        client.email_campaigns.update(
            "ec-1", {"subject": "New subject", "topic_key": None}
        )
        assert (last_request(transport).method, transport.request_path()) == (
            "PATCH",
            "/api/v1/email-campaigns/ec-1",
        )
        assert transport.request_body() == {"subject": "New subject", "topic_key": None}

    def test_updating_a_launched_campaign_raises_campaign_not_editable(self) -> None:
        client, _ = make_client(
            json_response(
                409,
                {
                    "error": {
                        "code": "campaign_not_editable",
                        "message": (
                            "Campaign status is 'sent' — only draft or scheduled "
                            "campaigns can be edited"
                        ),
                    }
                },
            )
        )
        with pytest.raises(OtokAPIError) as exc_info:
            client.email_campaigns.update("ec-1", {"name": "Too late"})
        assert exc_info.value.status == 409
        assert exc_info.value.code == "campaign_not_editable"

    def test_estimate_returns_estimated_recipients(self) -> None:
        client, transport = make_client(json_response(200, {"estimated_recipients": 1234}))
        estimate = client.email_campaigns.estimate("ec-1")
        assert (last_request(transport).method, transport.request_path()) == (
            "GET",
            "/api/v1/email-campaigns/ec-1/estimate",
        )
        assert estimate == {"estimated_recipients": 1234}

    def test_send_posts_without_a_body_and_returns_the_campaign(self) -> None:
        client, transport = make_client(
            json_response(200, {"id": "ec-1", "status": "sending"})
        )
        campaign = client.email_campaigns.send("ec-1")
        request = last_request(transport)
        assert (request.method, transport.request_path()) == (
            "POST",
            "/api/v1/email-campaigns/ec-1/send",
        )
        assert request.body is None
        assert campaign["status"] == "sending"

    def test_send_gate_failure_raises_the_422_launch_failed(self) -> None:
        # A launch-gate failure marks the campaign failed; the 422 body
        # carries the final status under error.campaign_status.
        client, _ = make_client(
            json_response(
                422,
                {
                    "error": {
                        "code": "launch_failed",
                        "message": "Sender profile domain is not verified",
                        "campaign_status": "failed",
                    }
                },
            )
        )
        with pytest.raises(OtokAPIError) as exc_info:
            client.email_campaigns.send("ec-1")
        assert exc_info.value.status == 422
        assert exc_info.value.code == "launch_failed"
        assert exc_info.value.body["error"]["campaign_status"] == "failed"

    def test_send_wrong_status_raises_campaign_not_sendable(self) -> None:
        client, _ = make_client(
            json_response(
                409,
                {
                    "error": {
                        "code": "campaign_not_sendable",
                        "message": (
                            "Campaign status is 'sending' — only draft or scheduled "
                            "campaigns can be sent"
                        ),
                    }
                },
            )
        )
        with pytest.raises(OtokAPIError) as exc_info:
            client.email_campaigns.send("ec-1")
        assert exc_info.value.status == 409
        assert exc_info.value.code == "campaign_not_sendable"

    def test_schedule_posts_the_instant(self) -> None:
        client, transport = make_client(
            json_response(200, {"id": "ec-1", "status": "scheduled"})
        )
        client.email_campaigns.schedule("ec-1", "2026-08-01T09:00:00Z")
        assert (last_request(transport).method, transport.request_path()) == (
            "POST",
            "/api/v1/email-campaigns/ec-1/schedule",
        )
        assert transport.request_body() == {"scheduled_at": "2026-08-01T09:00:00Z"}

    def test_schedule_failures_carry_machine_readable_codes(self) -> None:
        client, _ = make_client(
            json_response(
                400,
                {
                    "error": {
                        "code": "invalid_scheduled_at",
                        "message": "scheduled_at must be a future instant",
                    }
                },
            )
        )
        with pytest.raises(OtokAPIError) as exc_info:
            client.email_campaigns.schedule("ec-1", "2020-01-01T00:00:00Z")
        assert exc_info.value.status == 400
        assert exc_info.value.code == "invalid_scheduled_at"

        client, _ = make_client(
            json_response(
                409,
                {
                    "error": {
                        "code": "campaign_not_schedulable",
                        "message": (
                            "Campaign status is 'sent' — only draft or scheduled "
                            "campaigns can be scheduled"
                        ),
                    }
                },
            )
        )
        with pytest.raises(OtokAPIError) as exc_info:
            client.email_campaigns.schedule("ec-1", "2026-08-01T09:00:00Z")
        assert exc_info.value.status == 409
        assert exc_info.value.code == "campaign_not_schedulable"

    def test_unschedule_conflicts_carry_machine_readable_codes(self) -> None:
        client, transport = make_client(json_response(200, {"id": "ec-1", "status": "draft"}))
        client.email_campaigns.unschedule("ec-1")
        assert (last_request(transport).method, transport.request_path()) == (
            "POST",
            "/api/v1/email-campaigns/ec-1/unschedule",
        )

        # The minute sweep CAS-claims scheduled→sending; a lost race is a 409,
        # not a silent no-op.
        client, _ = make_client(
            json_response(
                409,
                {
                    "error": {
                        "code": "already_sending",
                        "message": (
                            "The send sweep already claimed this campaign — it is sending"
                        ),
                    }
                },
            )
        )
        with pytest.raises(OtokAPIError) as exc_info:
            client.email_campaigns.unschedule("ec-1")
        assert exc_info.value.status == 409
        assert exc_info.value.code == "already_sending"

        client, _ = make_client(
            json_response(
                409,
                {
                    "error": {
                        "code": "campaign_not_scheduled",
                        "message": (
                            "Campaign status is 'draft' — only scheduled campaigns "
                            "can be unscheduled"
                        ),
                    }
                },
            )
        )
        with pytest.raises(OtokAPIError) as exc_info:
            client.email_campaigns.unschedule("ec-1")
        assert exc_info.value.status == 409
        assert exc_info.value.code == "campaign_not_scheduled"

    def test_unknown_campaign_raises_campaign_not_found(self) -> None:
        client, _ = make_client(
            json_response(
                404,
                {"error": {"code": "campaign_not_found", "message": "Email campaign not found"}},
            )
        )
        with pytest.raises(OtokAPIError) as exc_info:
            client.email_campaigns.get("ec-missing")
        assert exc_info.value.status == 404
        assert exc_info.value.code == "campaign_not_found"

    def test_missing_email_marketing_feature_raises_a_coded_403(self) -> None:
        client, _ = make_client(
            json_response(
                403,
                {
                    "message": (
                        "Your current plan does not include access to this feature: "
                        "email_marketing. Please upgrade your plan."
                    ),
                    "error_code": "FEATURE_NOT_INCLUDED_IN_PLAN",
                },
            )
        )
        with pytest.raises(OtokAPIError) as exc_info:
            client.email_campaigns.list()
        assert exc_info.value.status == 403
        assert exc_info.value.code == "FEATURE_NOT_INCLUDED_IN_PLAN"


class TestNewsletters:
    def test_list_serializes_paging(self) -> None:
        client, transport = make_client(
            json_response(200, {"data": [], "total": 0, "limit": 25, "offset": 0})
        )
        client.newsletters.list({"limit": 10, "offset": 5})
        request = last_request(transport)
        assert request.method == "GET"
        assert urlsplit(request.url).path == "/api/v1/newsletters"
        assert query_of(request) == {"limit": ["10"], "offset": ["5"]}

    def test_get_includes_the_active_subscriber_count(self) -> None:
        client, transport = make_client(
            json_response(
                200,
                {"id": "nl-1", "name": "Product updates", "active_subscriber_count": 42},
            )
        )
        newsletter = client.newsletters.get("nl-1")
        assert (last_request(transport).method, transport.request_path()) == (
            "GET",
            "/api/v1/newsletters/nl-1",
        )
        assert newsletter["active_subscriber_count"] == 42

    def test_create_posts_the_newsletter(self) -> None:
        client, transport = make_client(
            json_response(
                201,
                {"id": "nl-1", "name": "Product updates", "active_subscriber_count": 0},
            )
        )
        client.newsletters.create({"name": "Product updates", "description": "Monthly"})
        assert (last_request(transport).method, transport.request_path()) == (
            "POST",
            "/api/v1/newsletters",
        )
        assert transport.request_body() == {
            "name": "Product updates",
            "description": "Monthly",
        }

    def test_create_failures_carry_machine_readable_codes(self) -> None:
        client, _ = make_client(
            json_response(
                409,
                {
                    "error": {
                        "code": "duplicate_name",
                        "message": "A newsletter with this name already exists",
                    }
                },
            )
        )
        with pytest.raises(OtokAPIError) as exc_info:
            client.newsletters.create({"name": "Product updates"})
        assert exc_info.value.status == 409
        assert exc_info.value.code == "duplicate_name"

        # The plan's max_newsletters cap answers the framework limit shape.
        client, _ = make_client(
            json_response(
                403,
                {
                    "message": (
                        "Plan limit reached for max_newsletters (3). Please upgrade "
                        "your plan to continue."
                    ),
                    "error_code": "PLAN_LIMIT_EXCEEDED",
                },
            )
        )
        with pytest.raises(OtokAPIError) as exc_info:
            client.newsletters.create({"name": "One too many"})
        assert exc_info.value.status == 403
        assert exc_info.value.code == "PLAN_LIMIT_EXCEEDED"

        client, _ = make_client(
            json_response(
                400,
                {
                    "error": {
                        "code": "sender_profile_not_found",
                        "message": "Sender profile not found in this workspace",
                    }
                },
            )
        )
        with pytest.raises(OtokAPIError) as exc_info:
            client.newsletters.create({"name": "Updates", "sender_profile_id": "sp-x"})
        assert exc_info.value.status == 400
        assert exc_info.value.code == "sender_profile_not_found"

    def test_list_issues_serializes_the_status_filter_and_paging(self) -> None:
        client, transport = make_client(
            json_response(200, {"data": [], "total": 0, "limit": 25, "offset": 0})
        )
        client.newsletters.list_issues("nl-1", {"status": "published", "limit": 10})
        request = last_request(transport)
        assert request.method == "GET"
        assert urlsplit(request.url).path == "/api/v1/newsletters/nl-1/issues"
        assert query_of(request) == {"status": ["published"], "limit": ["10"]}

    def test_create_issue_posts_the_content_contract(self) -> None:
        client, transport = make_client(
            json_response(
                201,
                {
                    "id": "is-1",
                    "newsletter_id": "nl-1",
                    "issue_number": None,
                    "status": "draft",
                    "duplicate": False,
                    "compile": {"ok": True, "errors": [], "warnings": []},
                },
            )
        )
        issue = client.newsletters.create_issue(
            "nl-1",
            {
                "subject": "Issue one",
                "external_reference": "issue-1",
                "content": {
                    "direction": "rtl",
                    "blocks": [{"kind": "paragraph", "text": "Hi [[first_name : there]]"}],
                },
            },
        )
        assert (last_request(transport).method, transport.request_path()) == (
            "POST",
            "/api/v1/newsletters/nl-1/issues",
        )
        assert transport.request_body()["content"]["blocks"][0]["kind"] == "paragraph"
        assert issue["compile"]["ok"] is True
        assert issue["duplicate"] is False
        # The number is assigned at publish, not at create.
        assert issue["issue_number"] is None

    def test_create_issue_without_params_posts_an_empty_draft(self) -> None:
        client, transport = make_client(json_response(201, {"id": "is-1", "status": "draft"}))
        client.newsletters.create_issue("nl-1")
        assert transport.request_body() == {}

    def test_create_issue_replay_surfaces_the_duplicate_marker(self) -> None:
        client, _ = make_client(
            json_response(
                201,
                {
                    "id": "is-1",
                    "status": "published",
                    "issue_number": 4,
                    "duplicate": True,
                    "compile": {"ok": True, "errors": [], "warnings": []},
                },
            )
        )
        issue = client.newsletters.create_issue(
            "nl-1", {"external_reference": "issue-1", "content": {"markdown": "New body"}}
        )
        assert issue["duplicate"] is True
        assert issue["issue_number"] == 4  # replays never touch the number

    def test_cross_newsletter_reference_raises_external_reference_in_use(self) -> None:
        client, _ = make_client(
            json_response(
                409,
                {
                    "error": {
                        "code": "external_reference_in_use",
                        "message": (
                            "external_reference already belongs to an issue of a "
                            "different newsletter"
                        ),
                    }
                },
            )
        )
        with pytest.raises(OtokAPIError) as exc_info:
            client.newsletters.create_issue("nl-2", {"external_reference": "issue-1"})
        assert exc_info.value.status == 409
        assert exc_info.value.code == "external_reference_in_use"

    def test_issue_reads_and_writes_issue_the_documented_verbs(self) -> None:
        client, transport = make_client()
        client.newsletters.get_issue("is-1")
        assert (last_request(transport).method, transport.request_path()) == (
            "GET",
            "/api/v1/newsletter-issues/is-1",
        )
        client.newsletters.update_issue("is-1", {"subject": "Edited", "preheader": None})
        assert (last_request(transport).method, transport.request_path()) == (
            "PATCH",
            "/api/v1/newsletter-issues/is-1",
        )
        assert transport.request_body() == {"subject": "Edited", "preheader": None}
        client.newsletters.publish_issue("is-1")
        request = last_request(transport)
        assert (request.method, transport.request_path()) == (
            "POST",
            "/api/v1/newsletter-issues/is-1/publish",
        )
        assert request.body is None
        client.newsletters.schedule_issue("is-1", "2026-08-01T09:00:00Z")
        assert (last_request(transport).method, transport.request_path()) == (
            "POST",
            "/api/v1/newsletter-issues/is-1/schedule",
        )
        assert transport.request_body() == {"scheduled_at": "2026-08-01T09:00:00Z"}
        client.newsletters.unschedule_issue("is-1")
        assert (last_request(transport).method, transport.request_path()) == (
            "POST",
            "/api/v1/newsletter-issues/is-1/unschedule",
        )

    def test_delete_issue_returns_the_success_body(self) -> None:
        client, transport = make_client(json_response(200, {"success": True}))
        result = client.newsletters.delete_issue("is-1")
        assert (last_request(transport).method, transport.request_path()) == (
            "DELETE",
            "/api/v1/newsletter-issues/is-1",
        )
        assert result == {"success": True}

    def test_deleting_a_published_issue_raises_issue_published(self) -> None:
        client, _ = make_client(
            json_response(
                400,
                {
                    "error": {
                        "code": "issue_published",
                        "message": "Published issues cannot be deleted",
                    }
                },
            )
        )
        with pytest.raises(OtokAPIError) as exc_info:
            client.newsletters.delete_issue("is-1")
        assert exc_info.value.status == 400
        assert exc_info.value.code == "issue_published"

    def test_publish_without_content_raises_issue_missing_content(self) -> None:
        client, _ = make_client(
            json_response(
                409,
                {
                    "error": {
                        "code": "issue_missing_content",
                        "message": (
                            "An issue needs a subject and content before it can be "
                            "published"
                        ),
                    }
                },
            )
        )
        with pytest.raises(OtokAPIError) as exc_info:
            client.newsletters.publish_issue("is-1")
        assert exc_info.value.status == 409
        assert exc_info.value.code == "issue_missing_content"

    def test_schedule_issue_failures_carry_machine_readable_codes(self) -> None:
        client, _ = make_client(
            json_response(
                400,
                {
                    "error": {
                        "code": "invalid_scheduled_at",
                        "message": "scheduled_at must be a future instant",
                    }
                },
            )
        )
        with pytest.raises(OtokAPIError) as exc_info:
            client.newsletters.schedule_issue("is-1", "2020-01-01T00:00:00Z")
        assert exc_info.value.status == 400
        assert exc_info.value.code == "invalid_scheduled_at"

        client, _ = make_client(
            json_response(
                409,
                {
                    "error": {
                        "code": "issue_already_published",
                        "message": (
                            "Issue is already published — published issues cannot be "
                            "scheduled"
                        ),
                    }
                },
            )
        )
        with pytest.raises(OtokAPIError) as exc_info:
            client.newsletters.schedule_issue("is-1", "2026-08-01T09:00:00Z")
        assert exc_info.value.status == 409
        assert exc_info.value.code == "issue_already_published"

    def test_unschedule_wrong_state_raises_issue_not_scheduled(self) -> None:
        client, _ = make_client(
            json_response(
                409,
                {
                    "error": {
                        "code": "issue_not_scheduled",
                        "message": (
                            "Issue status is 'draft' — only scheduled issues can be "
                            "unscheduled"
                        ),
                    }
                },
            )
        )
        with pytest.raises(OtokAPIError) as exc_info:
            client.newsletters.unschedule_issue("is-1")
        assert exc_info.value.status == 409
        assert exc_info.value.code == "issue_not_scheduled"

    def test_unknown_rows_raise_coded_404s(self) -> None:
        client, _ = make_client(
            json_response(
                404,
                {"error": {"code": "newsletter_not_found", "message": "Newsletter not found"}},
            )
        )
        with pytest.raises(OtokAPIError) as exc_info:
            client.newsletters.get("nl-missing")
        assert exc_info.value.status == 404
        assert exc_info.value.code == "newsletter_not_found"

        client, _ = make_client(
            json_response(
                404,
                {"error": {"code": "issue_not_found", "message": "Issue not found"}},
            )
        )
        with pytest.raises(OtokAPIError) as exc_info:
            client.newsletters.get_issue("is-missing")
        assert exc_info.value.status == 404
        assert exc_info.value.code == "issue_not_found"

    def test_missing_newsletters_feature_raises_a_coded_403(self) -> None:
        client, _ = make_client(
            json_response(
                403,
                {
                    "message": (
                        "Your current plan does not include access to this feature: "
                        "newsletters. Please upgrade your plan."
                    ),
                    "error_code": "FEATURE_NOT_INCLUDED_IN_PLAN",
                },
            )
        )
        with pytest.raises(OtokAPIError) as exc_info:
            client.newsletters.list()
        assert exc_info.value.status == 403
        assert exc_info.value.code == "FEATURE_NOT_INCLUDED_IN_PLAN"


class TestPayments:
    def test_payments_surface(self) -> None:
        client, transport = make_client()
        client.payments.list({"type": "recurring", "status": "active"})
        request = last_request(transport)
        assert urlsplit(request.url).path == "/api/v1/payments"
        assert query_of(request) == {"type": ["recurring"], "status": ["active"]}
        client.payments.get("p-1")
        assert transport.request_path() == "/api/v1/payments/p-1"
        client.payments.create(
            {"type": "one_time", "amount": 350, "phone": "+972501234567", "title": "Session"}
        )
        assert (last_request(transport).method, transport.request_path()) == (
            "POST",
            "/api/v1/payments",
        )
        client.payments.update("p-1", {"note": "Updated"})
        assert (last_request(transport).method, transport.request_path()) == (
            "PATCH",
            "/api/v1/payments/p-1",
        )
        client.payments.cancel("p-1")
        request = last_request(transport)
        assert (request.method, transport.request_path()) == (
            "POST",
            "/api/v1/payments/p-1/cancel",
        )
        assert request.body is None  # no request body on cancel
        client.payments.mark_entry("p-1", "e-1", "completed")
        assert (last_request(transport).method, transport.request_path()) == (
            "POST",
            "/api/v1/payments/p-1/entries/e-1/mark",
        )
        assert transport.request_body() == {"status": "completed"}
        client.payments.refund("p-1")
        assert (last_request(transport).method, transport.request_path()) == (
            "POST",
            "/api/v1/payments/p-1/refund",
        )
        assert transport.request_body() == {}
        client.payments.refund("p-1", {"amount": 100, "note": "Partial"})
        assert transport.request_body() == {"amount": 100, "note": "Partial"}

    def test_create_surfaces_the_top_level_duplicate_marker(self) -> None:
        # 201 in both outcomes; duplicate=True means external_reference
        # matched an existing payment that was updated instead.
        client, _ = make_client(
            json_response(201, {"id": "p-1", "external_reference": "inv-1", "duplicate": True})
        )
        payment = client.payments.create(
            {"type": "one_time", "amount": 350, "external_reference": "inv-1"}
        )
        assert payment["duplicate"] is True


class TestPaymentRequests:
    def test_list_serializes_every_documented_filter(self) -> None:
        client, transport = make_client()
        client.payment_requests.list(
            {
                "status": "pending",
                "contact_id": "5f9f1b9b-0000-4000-8000-000000000001",
                "deal_id": "5f9f1b9b-0000-4000-8000-000000000002",
                "limit": 10,
                "offset": 20,
            }
        )
        request = last_request(transport)
        assert request.method == "GET"
        assert urlsplit(request.url).path == "/api/v1/payment-requests"
        assert query_of(request) == {
            "status": ["pending"],
            "contact_id": ["5f9f1b9b-0000-4000-8000-000000000001"],
            "deal_id": ["5f9f1b9b-0000-4000-8000-000000000002"],
            "limit": ["10"],
            "offset": ["20"],
        }

    def test_writes_issue_the_documented_verb_and_path(self) -> None:
        client, transport = make_client(json_response(201, {"id": "pr-1"}))
        client.payment_requests.create(
            {
                "phone": "+972501234567",
                "name": "Dana Levi",
                "amount": 250,
                "currency": "ILS",
                "title": "Onboarding session",
                "vat_mode": "inclusive",
                "vat_rate": 18,
            }
        )
        request = last_request(transport)
        assert (request.method, transport.request_path()) == (
            "POST",
            "/api/v1/payment-requests",
        )
        assert transport.request_body() == {
            "phone": "+972501234567",
            "name": "Dana Levi",
            "amount": 250,
            "currency": "ILS",
            "title": "Onboarding session",
            "vat_mode": "inclusive",
            "vat_rate": 18,
        }
        client.payment_requests.get("pr-1")
        assert (last_request(transport).method, transport.request_path()) == (
            "GET",
            "/api/v1/payment-requests/pr-1",
        )
        client.payment_requests.cancel("pr-1")
        request = last_request(transport)
        assert (request.method, transport.request_path()) == (
            "POST",
            "/api/v1/payment-requests/pr-1/cancel",
        )
        assert request.body is None  # no request body on cancel

    def test_create_returns_checkout_diagnostics_and_no_duplicate_marker(self) -> None:
        # There is no idempotency key on this resource: a repeat POST mints
        # a second payable link, so no `duplicate` field can exist.
        client, _ = make_client(
            json_response(
                201,
                {
                    "id": "pr-1",
                    "status": "pending",
                    "charge_kind": "checkout",
                    "amount": 250,
                    "currency": "ILS",
                    "pay_url": "https://app.otok.io/pay/pr_tok",
                    "checkout_url": "https://provider.example/checkout/1",
                    "checkout_error": None,
                },
            )
        )
        request = client.payment_requests.create({"contact_id": "c-1", "amount": 250})
        assert "duplicate" not in request
        assert request["pay_url"] == "https://app.otok.io/pay/pr_tok"
        assert request["checkout_url"] == "https://provider.example/checkout/1"
        assert request["checkout_error"] is None

    def test_create_surfaces_the_no_payment_provider_code(self) -> None:
        client, _ = make_client(
            json_response(
                400,
                {
                    "statusCode": 400,
                    "error": "Bad Request",
                    "error_code": "NO_PAYMENT_PROVIDER",
                    "message": (
                        "No payment provider is connected — connect Cardcom or Sumit "
                        "in Settings → Integrations first."
                    ),
                },
            )
        )
        with pytest.raises(OtokAPIError) as excinfo:
            client.payment_requests.create({"contact_id": "c-1", "amount": 100})
        assert excinfo.value.status == 400
        assert excinfo.value.code == "NO_PAYMENT_PROVIDER"

    def test_cancel_surfaces_the_typed_409s(self) -> None:
        client, _ = make_client(
            json_response(
                409,
                {
                    "statusCode": 409,
                    "error": "Conflict",
                    "message": "Only pending payment requests can be cancelled",
                },
            ),
            json_response(
                409,
                {
                    "statusCode": 409,
                    "error": "Conflict",
                    "error_code": "TOKEN_REQUEST_NOT_CANCELLABLE",
                    "message": (
                        "Direct saved-card charges cannot be cancelled — the charge "
                        "orchestration resolves them"
                    ),
                },
            ),
        )
        with pytest.raises(OtokAPIError) as excinfo:
            client.payment_requests.cancel("pr-1")
        assert excinfo.value.status == 409
        assert excinfo.value.code is None
        with pytest.raises(OtokAPIError) as excinfo:
            client.payment_requests.cancel("pr-2")
        assert excinfo.value.status == 409
        assert excinfo.value.code == "TOKEN_REQUEST_NOT_CANCELLABLE"

    def test_feature_gate_403_embeds_the_workspace_payments_feature_id(self) -> None:
        # Pay-links are gated by `workspace_payments`, NOT the `payments`
        # ledger feature — the message embeds whichever id is missing.
        client, _ = make_client(
            json_response(
                403,
                {
                    "message": (
                        "Your current plan does not include access to this feature: "
                        "workspace_payments. Please upgrade your plan."
                    ),
                    "error_code": "FEATURE_NOT_INCLUDED_IN_PLAN",
                },
            )
        )
        with pytest.raises(OtokAPIError) as excinfo:
            client.payment_requests.list()
        assert excinfo.value.status == 403
        assert excinfo.value.code == "FEATURE_NOT_INCLUDED_IN_PLAN"


class TestOrders:
    def test_list_serializes_every_documented_filter(self) -> None:
        client, transport = make_client()
        client.orders.list(
            {
                "status": "paid",
                "contact_id": "5f9f1b9b-0000-4000-8000-000000000001",
                "source": "api",
                "store_connection_id": "5f9f1b9b-0000-4000-8000-000000000002",
                "external_reference": "shop:1001",
                "placed_from": "2026-07-01T00:00:00Z",
                "placed_to": "2026-07-31T23:59:59Z",
                "limit": 10,
                "offset": 20,
            }
        )
        request = last_request(transport)
        assert request.method == "GET"
        assert urlsplit(request.url).path == "/api/v1/orders"
        assert query_of(request) == {
            "status": ["paid"],
            "contact_id": ["5f9f1b9b-0000-4000-8000-000000000001"],
            "source": ["api"],
            "store_connection_id": ["5f9f1b9b-0000-4000-8000-000000000002"],
            "external_reference": ["shop:1001"],
            "placed_from": ["2026-07-01T00:00:00Z"],
            "placed_to": ["2026-07-31T23:59:59Z"],
            "limit": ["10"],
            "offset": ["20"],
        }

    def test_order_writes(self) -> None:
        client, transport = make_client()
        client.orders.create(
            {
                "email": "jane@example.com",
                "items": [
                    {"title": "Widget", "unit_price": 170, "quantity": 2},
                    {"product_sku": "SKU-1"},
                ],
                "shipping_total": 20,
                "financial_status": "paid",
                "external_reference": "shop:1001",
            }
        )
        assert (last_request(transport).method, transport.request_path()) == (
            "POST",
            "/api/v1/orders",
        )
        assert transport.request_body() == {
            "email": "jane@example.com",
            "items": [
                {"title": "Widget", "unit_price": 170, "quantity": 2},
                {"product_sku": "SKU-1"},
            ],
            "shipping_total": 20,
            "financial_status": "paid",
            "external_reference": "shop:1001",
        }
        client.orders.get("o-1")
        assert (last_request(transport).method, transport.request_path()) == (
            "GET",
            "/api/v1/orders/o-1",
        )
        client.orders.create_refund(
            "o-1",
            {"amount": 50, "external_refund_id": "refund-77", "reason": "Damaged"},
        )
        assert (last_request(transport).method, transport.request_path()) == (
            "POST",
            "/api/v1/orders/o-1/refunds",
        )
        assert transport.request_body() == {
            "amount": 50,
            "external_refund_id": "refund-77",
            "reason": "Damaged",
        }
        client.orders.mark_paid("o-1")
        assert (last_request(transport).method, transport.request_path()) == (
            "POST",
            "/api/v1/orders/o-1/mark-paid",
        )
        assert transport.request_body() == {}
        client.orders.mark_paid("o-1", {"payment_reference": "inv-1001"})
        assert transport.request_body() == {"payment_reference": "inv-1001"}
        client.orders.cancel("o-1")
        request = last_request(transport)
        assert (request.method, transport.request_path()) == (
            "POST",
            "/api/v1/orders/o-1/cancel",
        )
        assert request.body is None  # no request body on cancel

    def test_create_carries_no_top_level_duplicate_marker(self) -> None:
        # Unlike contacts/deals/payments/bookings, both create and
        # upsert-match answer 201 with the same full-order body — the only
        # signals are created_at or a pre-check by external_reference.
        client, _ = make_client(
            json_response(
                201,
                {
                    "id": "o-1",
                    "external_reference": "shop:1001",
                    "financial_status": "paid",
                    "total": 360,
                    "items": [],
                    "refunds": [],
                    "created_at": "2026-07-15T00:00:00.000Z",
                },
            )
        )
        order = client.orders.create({"contact_id": "c-1", "external_reference": "shop:1001"})
        assert "duplicate" not in order
        assert order["created_at"] == "2026-07-15T00:00:00.000Z"

    def test_refund_replay_surfaces_the_duplicate_marker(self) -> None:
        # A repeat POST with the same external_refund_id applies nothing and
        # returns the current order state with duplicate=True.
        client, _ = make_client(
            json_response(
                201,
                {
                    "duplicate": True,
                    "order": {
                        "id": "o-1",
                        "financial_status": "partially_refunded",
                        "refunded_total": 50,
                    },
                },
            )
        )
        result = client.orders.create_refund(
            "o-1", {"amount": 50, "external_refund_id": "refund-77"}
        )
        assert result["duplicate"] is True
        assert result["order"]["id"] == "o-1"
        assert result["order"]["financial_status"] == "partially_refunded"

    def test_refunding_a_never_paid_order_raises_a_typed_400(self) -> None:
        client, _ = make_client(
            json_response(
                400,
                {
                    "statusCode": 400,
                    "error": "Bad Request",
                    "error_code": "ORDER_NEVER_PAID",
                    "message": "Cannot refund an order that was never paid.",
                },
            )
        )
        with pytest.raises(OtokAPIError) as excinfo:
            client.orders.create_refund("o-1", {"amount": 50})
        assert excinfo.value.status == 400
        assert excinfo.value.code == "ORDER_NEVER_PAID"

    def test_feature_gate_403_maps_to_a_typed_error(self) -> None:
        client, _ = make_client(
            json_response(
                403,
                {
                    "message": (
                        "Your current plan does not include access to this "
                        "feature: orders. Please upgrade your plan."
                    ),
                    "error_code": "FEATURE_NOT_INCLUDED_IN_PLAN",
                },
            )
        )
        with pytest.raises(OtokAPIError) as excinfo:
            client.orders.list()
        err = excinfo.value
        assert err.status == 403
        assert err.code == "FEATURE_NOT_INCLUDED_IN_PLAN"

    def test_mark_paid_surfaces_the_typed_transition_and_reference_codes(self) -> None:
        # Refund states are set by recording refunds, never by mark-paid.
        client, _ = make_client(
            json_response(
                409,
                {
                    "statusCode": 409,
                    "error": "Conflict",
                    "error_code": "ORDER_ILLEGAL_TRANSITION",
                    "message": (
                        "Illegal status transition refunded → paid. "
                        "Refund states are set by recording refunds."
                    ),
                },
            )
        )
        with pytest.raises(OtokAPIError) as excinfo:
            client.orders.mark_paid("o-1")
        assert excinfo.value.status == 409
        assert excinfo.value.code == "ORDER_ILLEGAL_TRANSITION"

        client, _ = make_client(
            json_response(
                404,
                {
                    "statusCode": 404,
                    "error": "Not Found",
                    "error_code": "ORDER_PAYMENT_REFERENCE_NOT_FOUND",
                    "message": "No payment matches the provided payment_reference.",
                },
            )
        )
        with pytest.raises(OtokAPIError) as excinfo:
            client.orders.mark_paid("o-1", {"payment_reference": "inv-x"})
        assert excinfo.value.status == 404
        assert excinfo.value.code == "ORDER_PAYMENT_REFERENCE_NOT_FOUND"

        client, _ = make_client(
            json_response(
                409,
                {
                    "statusCode": 409,
                    "error": "Conflict",
                    "error_code": "ORDER_PAYMENT_ALREADY_LINKED",
                    "message": "The order is already linked to a different payment reference.",
                },
            )
        )
        with pytest.raises(OtokAPIError) as excinfo:
            client.orders.mark_paid("o-1", {"payment_reference": "inv-y"})
        assert excinfo.value.status == 409
        assert excinfo.value.code == "ORDER_PAYMENT_ALREADY_LINKED"


class TestBookings:
    def test_meeting_types_and_slots(self) -> None:
        client, transport = make_client()
        client.meeting_types.list({"filter": {"is_active": True}})
        assert transport.request_path() == "/api/v1/meeting-types"
        client.meeting_types.get("mt-1")
        assert transport.request_path() == "/api/v1/meeting-types/mt-1"
        client.meeting_types.slots(
            "mt-1", {"from": "2026-07-20T00:00:00Z", "to": "2026-07-27T00:00:00Z"}
        )
        request = last_request(transport)
        assert urlsplit(request.url).path == "/api/v1/meeting-types/mt-1/slots"
        assert query_of(request) == {
            "from": ["2026-07-20T00:00:00Z"],
            "to": ["2026-07-27T00:00:00Z"],
        }

    def test_meeting_type_embed(self) -> None:
        client, transport = make_client(
            json_response(
                200,
                {
                    "workspace_ref": "acme",
                    "slug": "intro-call",
                    "embed_key": "bk_live_abc123",
                    "page_url": "https://app.otok.io/book/acme/intro-call",
                    "snippet_html": (
                        '<div data-otok-booking="intro-call"></div>\n'
                        '<script async src="https://app.otok.io/embed/booking.js"'
                        ' data-key="bk_live_abc123"></script>'
                    ),
                },
            )
        )
        embed = client.meeting_types.embed("mt-1")
        request = last_request(transport)
        assert request.method == "GET"
        assert transport.request_path() == "/api/v1/meeting-types/mt-1/embed"
        assert embed["workspace_ref"] == "acme"
        assert embed["slug"] == "intro-call"
        assert embed["embed_key"] == "bk_live_abc123"
        assert embed["page_url"] == "https://app.otok.io/book/acme/intro-call"
        assert "bk_live_abc123" in embed["snippet_html"]

    def test_embed_surfaces_the_booking_feature_gate_403(self) -> None:
        client, _ = make_client(
            json_response(
                403,
                {
                    "message": (
                        "Your current plan does not include access to this "
                        "feature: booking. Please upgrade your plan."
                    ),
                    "error_code": "FEATURE_NOT_INCLUDED_IN_PLAN",
                },
            )
        )
        with pytest.raises(OtokAPIError) as excinfo:
            client.meeting_types.embed("mt-1")
        assert excinfo.value.status == 403
        assert excinfo.value.code == "FEATURE_NOT_INCLUDED_IN_PLAN"

    def test_bookings_surface(self) -> None:
        client, transport = make_client()
        client.bookings.list({"status": "confirmed", "from": "2026-07-01T00:00:00Z"})
        request = last_request(transport)
        assert urlsplit(request.url).path == "/api/v1/bookings"
        assert query_of(request) == {
            "status": ["confirmed"],
            "from": ["2026-07-01T00:00:00Z"],
        }
        client.bookings.get("bk-1")
        assert transport.request_path() == "/api/v1/bookings/bk-1"
        client.bookings.create(
            {
                "meeting_type_id": "mt-1",
                "start_at": "2026-07-20T06:00:00Z",
                "timezone": "Europe/Berlin",
                "invitee": {"name": "Dana Levi", "email": "dana@example.com"},
            }
        )
        assert (last_request(transport).method, transport.request_path()) == (
            "POST",
            "/api/v1/bookings",
        )
        client.bookings.cancel("bk-1")
        assert (last_request(transport).method, transport.request_path()) == (
            "POST",
            "/api/v1/bookings/bk-1/cancel",
        )
        assert transport.request_body() == {}
        client.bookings.cancel("bk-1", "No longer needed")
        assert transport.request_body() == {"reason": "No longer needed"}
        client.bookings.reschedule("bk-1", {"start_at": "2026-07-21T06:00:00Z"})
        assert (last_request(transport).method, transport.request_path()) == (
            "POST",
            "/api/v1/bookings/bk-1/reschedule",
        )
        client.bookings.reassign("bk-1")
        assert (last_request(transport).method, transport.request_path()) == (
            "POST",
            "/api/v1/bookings/bk-1/reassign",
        )
        assert transport.request_body() == {}
        client.bookings.reassign("bk-1", {"user_id": "u-2", "force": True})
        assert transport.request_body() == {"user_id": "u-2", "force": True}

    def test_create_surfaces_the_top_level_duplicate_marker(self) -> None:
        # 201 in both outcomes; duplicate=True means a double-submit of the
        # same slot/invitee returned the original booking.
        client, _ = make_client(json_response(201, {"id": "bk-1", "duplicate": True}))
        booking = client.bookings.create(
            {
                "meeting_type_id": "mt-1",
                "start_at": "2026-07-20T06:00:00Z",
                "timezone": "Europe/Berlin",
                "invitee": {"name": "Dana Levi", "email": "dana@example.com"},
            }
        )
        assert booking["duplicate"] is True
