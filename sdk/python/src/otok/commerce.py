"""High-level e-commerce layer: plain customer/order dicts in, contact
upserts + idempotent deal creation (and an optional receipt email) out.

Everything here is retry-safe by design:

- customers upsert by phone/email (no duplicates),
- orders map to deals through ``external_reference`` (one order = one deal),
- receipts carry a deterministic email idempotency key derived from the
  order id (one order = at most one receipt).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional, TypedDict, cast

from .resources import ContactsApi, DealsApi, EmailsApi
from .types import (
    Contact,
    ContactUpsertParams,
    Deal,
    DealCreateParams,
    EmailSendParams,
    EmailSendResult,
)


class CommerceAddress(TypedDict, total=False):
    line1: str
    line2: str
    city: str
    state: str
    postal_code: str
    country: str


class CommerceCustomer(TypedDict, total=False):
    """A store customer. At least one of ``email`` / ``phone`` is required."""

    email: str
    #: E.164 preferred, e.g. "+12025551234".
    phone: str
    first_name: str
    last_name: str
    #: Full name; used when first_name/last_name aren't split.
    name: str
    #: Tag NAMES — added to the contact (never removed).
    tags: list[str]
    #: Contact group NAMES — added to the contact (never removed).
    groups: list[str]
    address: CommerceAddress
    #: Workspace-defined custom fields, keyed by field key.
    custom_fields: dict[str, Any]
    #: Extra wire-format contact fields to pass through as-is.
    extra: ContactUpsertParams


class _CommerceReceiptRequired(TypedDict):
    subject: str


class CommerceReceipt(_CommerceReceiptRequired, total=False):
    html: str
    text: str
    #: Defaults to the workspace's default verified sender profile.
    sender_profile_id: str
    reply_to: str


class _CommerceOrderRequired(TypedDict):
    #: Your order id. Becomes the deal's ``external_reference`` (prefixed
    #: ``order:``), which makes ``track_order`` idempotent — the same order
    #: never creates two deals.
    order_id: str
    customer: CommerceCustomer
    #: Order total (deal amount).
    total: float


class CommerceOrder(_CommerceOrderRequired, total=False):
    #: 3-letter code; defaults to the workspace currency.
    currency: str
    #: Deal title; defaults to "Order <order_id>".
    title: str
    #: Target pipeline; defaults to the workspace default pipeline.
    pipeline_id: str
    #: Target stage; defaults to the pipeline's first stage.
    stage_id: str
    #: Note stored on the deal.
    note: str
    #: Attach a catalog product by SKU (deal title derives from the product).
    product_sku: str
    #: Optional transactional receipt email, sent at most once per order.
    receipt: CommerceReceipt


@dataclass
class TrackOrderResult:
    contact: Contact
    deal: Deal
    #: Present only when ``order["receipt"]`` was provided.
    receipt: Optional[EmailSendResult] = None


def customer_to_contact_params(customer: CommerceCustomer) -> ContactUpsertParams:
    """Map a commerce customer to wire-format contact upsert params."""
    if not customer.get("email") and not customer.get("phone"):
        raise ValueError("otok: a commerce customer needs at least an email or a phone")
    address: CommerceAddress = customer.get("address") or {}
    params: dict[str, Any] = {
        "email": customer.get("email"),
        "phone": customer.get("phone"),
        "first_name": customer.get("first_name"),
        "last_name": customer.get("last_name"),
        "name": customer.get("name"),
        "tags": customer.get("tags"),
        "groups": customer.get("groups"),
        "custom_fields": customer.get("custom_fields"),
        "address_line1": address.get("line1"),
        "address_line2": address.get("line2"),
        "city": address.get("city"),
        "state": address.get("state"),
        "postal_code": address.get("postal_code"),
        "country": address.get("country"),
    }
    params.update(customer.get("extra") or {})
    # Drop unset keys so the request body stays minimal.
    return cast(ContactUpsertParams, {k: v for k, v in params.items() if v is not None})


def order_external_reference(order_id: str) -> str:
    """Deterministic deal idempotency reference for an order."""
    return f"order:{order_id}"


def order_receipt_idempotency_key(order_id: str) -> str:
    """Deterministic email idempotency key for an order's receipt."""
    return f"order:{order_id}:receipt"


class CommerceApi:
    def __init__(self, contacts: ContactsApi, deals: DealsApi, emails: EmailsApi) -> None:
        self._contacts = contacts
        self._deals = deals
        self._emails = emails

    def identify_customer(self, customer: CommerceCustomer) -> Contact:
        """Upsert a store customer as an oToK contact (matched by phone,
        falling back to email). Tags/groups are added, never removed — safe
        to call on every login/checkout.
        """
        return self._contacts.upsert(customer_to_contact_params(customer))

    def track_order(self, order: CommerceOrder) -> TrackOrderResult:
        """Record an order: upserts the customer, then creates (or
        idempotently updates) a deal keyed by the order id, and optionally
        sends a receipt email exactly once. Safe to retry and safe to call
        from at-least-once webhook handlers — replays converge on the same
        contact/deal/receipt.
        """
        order_id = order.get("order_id")
        if not order_id:
            raise ValueError("otok: order order_id is required")

        contact = self.identify_customer(order["customer"])

        deal_fields: dict[str, Any] = {
            "contact_id": contact["id"],
            "product_sku": order.get("product_sku"),
            "amount": order["total"],
            "currency": order.get("currency"),
            "pipeline_id": order.get("pipeline_id"),
            "stage_id": order.get("stage_id"),
            "note": order.get("note"),
            "external_reference": order_external_reference(order_id),
        }
        # While a product is attached the API derives the title from the
        # product name, so only send a title when there is no product SKU.
        if not order.get("product_sku"):
            deal_fields["title"] = order.get("title") or f"Order {order_id}"
        deal = self._deals.create(
            cast(DealCreateParams, {k: v for k, v in deal_fields.items() if v is not None})
        )

        receipt_result: Optional[EmailSendResult] = None
        receipt = order.get("receipt")
        if receipt is not None:
            to = order["customer"].get("email")
            if not to:
                raise ValueError("otok: an order receipt requires customer email to send to")
            email_fields: dict[str, Any] = {
                "to": to,
                "subject": receipt["subject"],
                "html": receipt.get("html"),
                "text": receipt.get("text"),
                "sender_profile_id": receipt.get("sender_profile_id"),
                "reply_to": receipt.get("reply_to"),
                "metadata": {"order_id": order_id},
                "idempotency_key": order_receipt_idempotency_key(order_id),
            }
            receipt_result = self._emails.send(
                cast(EmailSendParams, {k: v for k, v in email_fields.items() if v is not None})
            )

        return TrackOrderResult(contact=contact, deal=deal, receipt=receipt_result)
