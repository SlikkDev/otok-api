"""Parity tests: every resource method issues the documented verb + path
+ query/body, mirroring the Node SDK's surface.
"""

from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

from otok import OtokClient
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
