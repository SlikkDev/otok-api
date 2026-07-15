"""Resource namespaces for the oToK public API (/v1)."""

from __future__ import annotations

import builtins
import json
from typing import Any, Optional, cast

from ._http import HttpClient, QueryValue
from .types import (
    Booking,
    BookingCreateParams,
    BookingListParams,
    BookingReassignParams,
    BookingRescheduleParams,
    Campaign,
    CampaignCreateParams,
    CampaignUpdateParams,
    Contact,
    ContactGroup,
    ContactGroupCreateParams,
    ContactGroupUpdateParams,
    ContactUpsertParams,
    Deal,
    DealCreateParams,
    DealListParams,
    DealMoveStageParams,
    DealSetStatusParams,
    DealUpdateParams,
    EmailSendParams,
    EmailSendResult,
    ListParams,
    MeetingType,
    MessageTemplate,
    Note,
    Paginated,
    Payment,
    PaymentCreateParams,
    PaymentEntryStatus,
    PaymentListParams,
    PaymentRefundParams,
    PaymentUpdateParams,
    Pipeline,
    SlotsParams,
    Tag,
    TagCreateParams,
    TagUpdateParams,
    TemplateSendParams,
    WebhookEndpointCreated,
    WebhookEndpointCreateParams,
    WebhookEndpointList,
)


def _list_query(params: Optional[ListParams]) -> dict[str, QueryValue]:
    """Serialize the shared list params (``filter`` is sent as a JSON string)."""
    p: ListParams = params or {}
    filter_obj = p.get("filter")
    return {
        "filter": (
            json.dumps(filter_obj, separators=(",", ":")) if filter_obj is not None else None
        ),
        "sort": p.get("sort"),
        "limit": p.get("limit"),
        "offset": p.get("offset"),
        "search": p.get("search"),
    }


def _params_query(params: Optional[Any]) -> dict[str, QueryValue]:
    """Pass a params mapping straight through as query parameters."""
    return dict(params or {})


# ─────────────────────────────── Contacts ───────────────────────────────


class ContactsApi:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def list(self, params: Optional[ListParams] = None) -> Paginated:
        return cast(
            Paginated,
            self._http.request("GET", "/v1/contacts", query=_list_query(params)),
        )

    def get(self, contact_id: str) -> Contact:
        return cast(Contact, self._http.request("GET", f"/v1/contacts/{contact_id}"))

    def upsert(self, params: ContactUpsertParams) -> Contact:
        """Create OR update (upsert) a contact. Matches by phone (canonicalized
        to E.164), falling back to email. ``tags``/``groups`` are ADDED on
        upsert. The response carries ``duplicate: True`` when an existing
        contact was matched and updated (201 either way).
        """
        return cast(Contact, self._http.request("POST", "/v1/contacts", body=params))

    def update(self, contact_id: str, params: ContactUpsertParams) -> Contact:
        """Update by id (404 when unknown). ``tags``/``groups`` REPLACE the
        full set.

        Changing ``phone``/``email`` to an identifier that belongs (or
        previously belonged) to another contact raises a 409 with
        ``err.code == "CONTACT_MERGE_REQUIRED"`` and a ``merge_request_id``
        in ``err.body``: the write is NOT applied — it is parked on a merge
        request to resolve (merge or dismiss) in oToK.
        """
        return cast(
            Contact,
            self._http.request("PATCH", f"/v1/contacts/{contact_id}", body=params),
        )

    # ── Notes ──

    def list_notes(self, contact_id: str) -> builtins.list[Note]:
        """All the contact's notes (pinned first, then newest-first) — the
        endpoint is unpaginated.
        """
        return cast(
            list[Note],
            self._http.request("GET", f"/v1/contacts/{contact_id}/notes"),
        )

    def create_note(self, contact_id: str, body: str, *, pinned: Optional[bool] = None) -> Note:
        """Add a plain-text note (≤5000 chars) to a contact."""
        payload: dict[str, Any] = {"body": body}
        if pinned is not None:
            payload["pinned"] = pinned
        return cast(
            Note,
            self._http.request("POST", f"/v1/contacts/{contact_id}/notes", body=payload),
        )

    def update_note(
        self,
        note_id: str,
        *,
        body: Optional[str] = None,
        pinned: Optional[bool] = None,
    ) -> Note:
        """Edit a note's body and/or pin/unpin it. Sending neither returns
        the note unchanged.
        """
        payload: dict[str, Any] = {}
        if body is not None:
            payload["body"] = body
        if pinned is not None:
            payload["pinned"] = pinned
        return cast(Note, self._http.request("PATCH", f"/v1/notes/{note_id}", body=payload))

    def delete_note(self, note_id: str) -> dict[str, Any]:
        """Delete a note. Returns ``{"success": True}``."""
        return cast(
            dict[str, Any],
            self._http.request("DELETE", f"/v1/notes/{note_id}"),
        )


# ─────────────────────────────── Tags ───────────────────────────────


class TagsApi:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def list(self, params: Optional[ListParams] = None) -> Paginated:
        return cast(
            Paginated,
            self._http.request("GET", "/v1/tags", query=_list_query(params)),
        )

    def get(self, tag_id: str) -> Tag:
        return cast(Tag, self._http.request("GET", f"/v1/tags/{tag_id}"))

    def create(self, params: TagCreateParams) -> Tag:
        """Create a tag. A name that already exists in the workspace
        (case-insensitive) raises a 409.
        """
        return cast(Tag, self._http.request("POST", "/v1/tags", body=params))

    def update(self, tag_id: str, params: TagUpdateParams) -> Tag:
        """Update a tag. Renaming to an existing name raises a 409."""
        return cast(Tag, self._http.request("PATCH", f"/v1/tags/{tag_id}", body=params))


# ─────────────────────────── Contact groups ───────────────────────────


class ContactGroupsApi:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def list(self, params: Optional[ListParams] = None) -> Paginated:
        return cast(
            Paginated,
            self._http.request("GET", "/v1/contact-groups", query=_list_query(params)),
        )

    def get(self, group_id: str) -> ContactGroup:
        return cast(ContactGroup, self._http.request("GET", f"/v1/contact-groups/{group_id}"))

    def create(self, params: ContactGroupCreateParams) -> ContactGroup:
        """Create a contact group. A name that already exists in the
        workspace (case-insensitive) raises a 409.
        """
        return cast(ContactGroup, self._http.request("POST", "/v1/contact-groups", body=params))

    def update(self, group_id: str, params: ContactGroupUpdateParams) -> ContactGroup:
        """Update a contact group. Renaming to an existing name raises a 409."""
        return cast(
            ContactGroup,
            self._http.request("PATCH", f"/v1/contact-groups/{group_id}", body=params),
        )


# ─────────────────────────── Pipelines / deals ───────────────────────────


class PipelinesApi:
    """Requires the Deals feature on the workspace's plan — without it every
    call raises a 403 with ``err.code == "FEATURE_NOT_INCLUDED_IN_PLAN"``.
    """

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def list(self) -> builtins.list[Pipeline]:
        """List pipelines, each with its ordered stages."""
        return cast(list[Pipeline], self._http.request("GET", "/v1/pipelines"))


class DealsApi:
    """Requires the Deals feature on the workspace's plan — without it every
    call raises a 403 with ``err.code == "FEATURE_NOT_INCLUDED_IN_PLAN"``.
    """

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def list(self, params: Optional[DealListParams] = None) -> Paginated:
        return cast(
            Paginated,
            self._http.request("GET", "/v1/deals", query=_params_query(params)),
        )

    def get(self, deal_id: str) -> Deal:
        return cast(Deal, self._http.request("GET", f"/v1/deals/{deal_id}"))

    def create(self, params: DealCreateParams) -> Deal:
        """Create a deal. Idempotent when ``external_reference`` is set: a
        repeat POST with the same reference updates that deal instead of
        creating a duplicate — the response then carries ``duplicate: True``
        (201 either way).
        """
        return cast(Deal, self._http.request("POST", "/v1/deals", body=params))

    def update(self, deal_id: str, params: DealUpdateParams) -> Deal:
        return cast(Deal, self._http.request("PATCH", f"/v1/deals/{deal_id}", body=params))

    def move_stage(self, deal_id: str, params: DealMoveStageParams) -> Deal:
        """Move a deal to a stage (cross-pipeline moves are handled)."""
        return cast(Deal, self._http.request("POST", f"/v1/deals/{deal_id}/stage", body=params))

    def set_status(self, deal_id: str, params: DealSetStatusParams) -> Deal:
        """Mark a deal won/lost, or reopen it with status "open"."""
        return cast(Deal, self._http.request("POST", f"/v1/deals/{deal_id}/status", body=params))


# ─────────────────────────── Transactional email ───────────────────────────


class EmailsApi:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def send(self, params: EmailSendParams) -> EmailSendResult:
        """Send a transactional email. ``idempotency_key`` is required — a
        repeat call with the same key returns the original send
        (``duplicate: true``) and never sends twice, so this is safe to
        retry.
        """
        return cast(EmailSendResult, self._http.request("POST", "/v1/emails", body=params))


# ─────────────────────────── Webhook endpoints ───────────────────────────


class WebhookEndpointsApi:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def create(self, params: WebhookEndpointCreateParams) -> WebhookEndpointCreated:
        """Register a webhook endpoint (max 3 per workspace). The returned
        ``secret`` (``whsec_…``) is shown ONCE — store it; you need it to
        verify signatures.
        """
        return cast(
            WebhookEndpointCreated,
            self._http.request("POST", "/v1/webhook-endpoints", body=params),
        )

    def list(self) -> WebhookEndpointList:
        """List endpoints (secrets are never returned)."""
        return cast(WebhookEndpointList, self._http.request("GET", "/v1/webhook-endpoints"))

    def delete(self, endpoint_id: str) -> None:
        """Delete an endpoint (stops deliveries immediately)."""
        self._http.request("DELETE", f"/v1/webhook-endpoints/{endpoint_id}")


# ─────────────────────────── Campaigns ───────────────────────────


class CampaignsApi:
    """Requires the Campaigns feature on the workspace's plan — without it
    every call raises a 403 with ``err.code ==
    "FEATURE_NOT_INCLUDED_IN_PLAN"``.
    """

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def list(self, params: Optional[ListParams] = None) -> Paginated:
        return cast(
            Paginated,
            self._http.request("GET", "/v1/campaigns", query=_list_query(params)),
        )

    def get(self, campaign_id: str) -> Campaign:
        return cast(Campaign, self._http.request("GET", f"/v1/campaigns/{campaign_id}"))

    def create(self, params: CampaignCreateParams) -> Campaign:
        return cast(Campaign, self._http.request("POST", "/v1/campaigns", body=params))

    def update(self, campaign_id: str, params: CampaignUpdateParams) -> Campaign:
        return cast(
            Campaign,
            self._http.request("PATCH", f"/v1/campaigns/{campaign_id}", body=params),
        )

    def execute(self, campaign_id: str) -> dict[str, Any]:
        """Enqueue a campaign for background execution. Success answers 200
        with ``{"success": True, "message": …, "jobId": …}``. Failures raise
        ``OtokAPIError``: 404 (``code="campaign_not_found"``) for an unknown
        id, 409 (``code="campaign_not_scheduled"``) when the campaign is not
        in "scheduled" status. Campaigns created without an explicit
        ``status`` default to "draft" — set ``status: "scheduled"`` (on
        create or via ``update``) before executing.
        """
        return cast(
            dict[str, Any],
            self._http.request("POST", f"/v1/campaigns/{campaign_id}/execute"),
        )


# ─────────────────────────── Templates (WhatsApp) ───────────────────────────


class TemplatesApi:
    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def list(self, params: Optional[ListParams] = None) -> Paginated:
        return cast(
            Paginated,
            self._http.request("GET", "/v1/templates", query=_list_query(params)),
        )

    def get(self, template_id: str) -> MessageTemplate:
        return cast(MessageTemplate, self._http.request("GET", f"/v1/templates/{template_id}"))

    def send(self, template_id: str, params: TemplateSendParams) -> dict[str, Any]:
        """Send a template message via WhatsApp. The contact (matched by
        phone) and its conversation are created automatically when they
        don't exist.
        """
        return cast(
            dict[str, Any],
            self._http.request("POST", f"/v1/templates/{template_id}/send", body=params),
        )


# ─────────────────────────── Payments ───────────────────────────


class PaymentsApi:
    """Requires the Payments feature on the workspace's plan — without it
    every call raises a 403 with ``err.code ==
    "FEATURE_NOT_INCLUDED_IN_PLAN"``.
    """

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def list(self, params: Optional[PaymentListParams] = None) -> Paginated:
        return cast(
            Paginated,
            self._http.request("GET", "/v1/payments", query=_params_query(params)),
        )

    def get(self, payment_id: str) -> Payment:
        """Get a payment with its entry schedule."""
        return cast(Payment, self._http.request("GET", f"/v1/payments/{payment_id}"))

    def create(self, params: PaymentCreateParams) -> Payment:
        """Create a payment (idempotent upsert via ``external_reference`` —
        a match updates that payment's mutable fields and the response
        carries ``duplicate: True``; 201 either way).
        """
        return cast(Payment, self._http.request("POST", "/v1/payments", body=params))

    def update(self, payment_id: str, params: PaymentUpdateParams) -> Payment:
        return cast(
            Payment,
            self._http.request("PATCH", f"/v1/payments/{payment_id}", body=params),
        )

    def cancel(self, payment_id: str) -> Payment:
        """Cancel a recurring payment plan."""
        return cast(Payment, self._http.request("POST", f"/v1/payments/{payment_id}/cancel"))

    def mark_entry(self, payment_id: str, entry_id: str, status: PaymentEntryStatus) -> Payment:
        """Mark a payment entry (installment/cycle) failed, refunded, etc."""
        return cast(
            Payment,
            self._http.request(
                "POST",
                f"/v1/payments/{payment_id}/entries/{entry_id}/mark",
                body={"status": status},
            ),
        )

    def refund(self, payment_id: str, params: Optional[PaymentRefundParams] = None) -> Payment:
        """Refund a payment (full or partial)."""
        return cast(
            Payment,
            self._http.request(
                "POST",
                f"/v1/payments/{payment_id}/refund",
                body=dict(params or {}),
            ),
        )


# ─────────────────────────── Bookings ───────────────────────────


class MeetingTypesApi:
    """Requires the Booking feature on the workspace's plan — without it
    every call raises a 403 with ``err.code ==
    "FEATURE_NOT_INCLUDED_IN_PLAN"``.
    """

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def list(self, params: Optional[ListParams] = None) -> Paginated:
        return cast(
            Paginated,
            self._http.request("GET", "/v1/meeting-types", query=_list_query(params)),
        )

    def get(self, meeting_type_id: str) -> MeetingType:
        return cast(
            MeetingType,
            self._http.request("GET", f"/v1/meeting-types/{meeting_type_id}"),
        )

    def slots(self, meeting_type_id: str, params: SlotsParams) -> dict[str, Any]:
        """Open start instants (UTC) over ``[from, to)`` — max 62 days."""
        return cast(
            dict[str, Any],
            self._http.request(
                "GET",
                f"/v1/meeting-types/{meeting_type_id}/slots",
                query={"from": params["from"], "to": params["to"]},
            ),
        )


class BookingsApi:
    """Requires the Booking feature on the workspace's plan — without it
    every call raises a 403 with ``err.code ==
    "FEATURE_NOT_INCLUDED_IN_PLAN"``.
    """

    def __init__(self, http: HttpClient) -> None:
        self._http = http

    def list(self, params: Optional[BookingListParams] = None) -> Paginated:
        return cast(
            Paginated,
            self._http.request("GET", "/v1/bookings", query=_params_query(params)),
        )

    def get(self, booking_id: str) -> Booking:
        return cast(Booking, self._http.request("GET", f"/v1/bookings/{booking_id}"))

    def create(self, params: BookingCreateParams) -> Booking:
        """Book a slot server-to-server. A taken slot raises 409 SLOT_TAKEN.
        A double-submit of the same slot/invitee returns the original
        booking with ``duplicate: True`` (201 either way).
        """
        return cast(Booking, self._http.request("POST", "/v1/bookings", body=params))

    def cancel(self, booking_id: str, reason: Optional[str] = None) -> Booking:
        return cast(
            Booking,
            self._http.request(
                "POST",
                f"/v1/bookings/{booking_id}/cancel",
                body={"reason": reason} if reason is not None else {},
            ),
        )

    def reschedule(self, booking_id: str, params: BookingRescheduleParams) -> Booking:
        return cast(
            Booking,
            self._http.request("POST", f"/v1/bookings/{booking_id}/reschedule", body=params),
        )

    def reassign(self, booking_id: str, params: Optional[BookingReassignParams] = None) -> Booking:
        return cast(
            Booking,
            self._http.request(
                "POST",
                f"/v1/bookings/{booking_id}/reassign",
                body=dict(params or {}),
            ),
        )
