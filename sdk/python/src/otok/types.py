"""Types for the oToK public API (/v1).

Request types mirror the API's wire contract exactly (snake_case field
names, the same required/optional split and enums as the server-side
validation). Unknown fields are rejected by the API with a 400, so only
documented fields are typed.

Response records are open dictionaries — servers may add fields over time —
so most response types are ``Dict[str, Any]`` aliases. Envelopes and
webhook events with a fixed documented shape are typed as ``TypedDict``s.
"""

from __future__ import annotations

from typing import Any, Literal, Optional, TypedDict, Union

# ─────────────────────────────── Shared ───────────────────────────────


class Paginated(TypedDict):
    """Standard list envelope returned by paginated GET endpoints."""

    data: list[dict[str, Any]]
    total: int
    limit: int
    offset: int


class ListParams(TypedDict, total=False):
    """Shared list query params (contacts, tags, contact-groups, campaigns,
    templates, meeting-types). ``filter`` is a JSON object of exact-match
    field filters, e.g. ``{"lifecycle_stage": "lead"}``.

    Filter values are type-checked against the target field: a mistyped
    value (bad date, UUID, enum, number, or boolean) raises a 400 with a
    descriptive message, e.g.
    ``Invalid filter value for "created_at": "not-a-date" is not a date``.
    """

    filter: dict[str, Any]
    #: Sort field; prefix with "-" for descending. Default: -created_at.
    sort: str
    #: Page size (max 500, default 50).
    limit: int
    #: Rows to skip (default 0).
    offset: int
    #: Free-text search.
    search: str


# ─────────────────────────────── Contacts ───────────────────────────────

LifecycleStage = Literal["lead", "prospect", "customer", "inactive", "archived"]
ContactSource = Literal["manual", "import", "widget", "campaign", "api", "form"]
BlockState = Literal["none", "workspace", "global"]
Gender = Literal["male", "female", "other", "prefer_not_to_say"]


class ContactUpsertParams(TypedDict, total=False):
    """Writable contact fields for ``POST /v1/contacts`` (create-or-update)
    and ``PATCH /v1/contacts/:id``.

    POST upserts by phone (canonicalized to E.164), falling back to email
    when no phone is provided. ``tags`` / ``groups`` are NAMES — missing ones
    are created automatically. On POST (upsert) they are ADDED to the
    existing contact's sets; on PATCH they REPLACE the full set.
    """

    phone: str
    name: str
    first_name: str
    last_name: str
    email: str
    avatar_url: str
    notes: str
    lifecycle_stage: LifecycleStage
    source: ContactSource
    block_state: BlockState
    company_name: str
    vat_number: str
    job_title: str
    industry: str
    company_website: str
    annual_revenue: float
    employee_count: int
    currency_preference: str
    address_line1: str
    address_line2: str
    city: str
    state: str
    postal_code: str
    country: str
    gender: Gender
    #: ISO date, e.g. "1990-05-21".
    date_of_birth: str
    language: str
    utm_source: str
    utm_medium: str
    utm_campaign: str
    utm_term: str
    utm_content: str
    gclid: str
    fbclid: str
    #: Lead score (0–100). Writable only while the workspace's lead-scoring
    #: engine is disabled; ignored (engine-owned) when scoring is enabled.
    lead_score: float
    linkedin_url: str
    facebook_url: str
    instagram_handle: str
    twitter_handle: str
    #: Workspace-defined custom fields, keyed by field key.
    custom_fields: dict[str, Any]
    #: Tag NAMES (max 100 chars each).
    tags: list[str]
    #: Contact group NAMES (max 100 chars each).
    groups: list[str]


#: Contact record as returned by the API (open — servers may add fields).
#: ``POST /v1/contacts`` responses additionally carry a top-level
#: ``duplicate: bool`` — ``True`` when the upsert matched (and updated) an
#: existing contact instead of creating one (201 either way).
Contact = dict[str, Any]

#: Contact note record (``GET /v1/contacts/:id/notes`` et al.).
Note = dict[str, Any]

# ─────────────────────────── Tags / groups ───────────────────────────

TagType = Literal["contact", "conversation", "both"]


class _TagCreateRequired(TypedDict):
    name: str


class TagCreateParams(_TagCreateRequired, total=False):
    color: str
    type: TagType


class TagUpdateParams(TypedDict, total=False):
    name: str
    color: str
    type: TagType


Tag = dict[str, Any]


class _ContactGroupCreateRequired(TypedDict):
    name: str


class ContactGroupCreateParams(_ContactGroupCreateRequired, total=False):
    description: str
    color: str


class ContactGroupUpdateParams(TypedDict, total=False):
    name: str
    description: str
    color: str


ContactGroup = dict[str, Any]

# ─────────────────────────── Pipelines / deals ───────────────────────────

PipelineStage = dict[str, Any]
Pipeline = dict[str, Any]

DealStatus = Literal["open", "won", "lost"]


class DealCreateParams(TypedDict, total=False):
    """``POST /v1/deals`` — create a deal (idempotent upsert via
    ``external_reference``).

    Contact resolution: provide ``contact_id`` OR ``phone``/``email`` (a
    matching contact is used, or created — ``name`` applies only on create).
    A repeat POST with the same ``external_reference`` updates that deal's
    mutable fields (and moves it when ``stage_id`` differs) instead of
    creating a duplicate; status is never changed on a match. The response
    carries ``duplicate: true`` when an existing deal was matched.
    """

    contact_id: str
    phone: str
    email: str
    name: str
    #: Required unless a product is attached (then derived from the product).
    title: str
    product_id: str
    product_sku: str
    product_external_id: str
    #: Defaults to the attached product's price, else 0.
    amount: float
    #: 3-letter code; defaults to the workspace currency.
    currency: str
    #: Defaults to the workspace default pipeline.
    pipeline_id: str
    #: Defaults to the pipeline's first stage.
    stage_id: str
    owner_user_id: str
    #: ISO 8601.
    expected_close_at: str
    note: str
    #: Idempotency key — one reference maps to one deal. Max 255 chars.
    external_reference: str


class DealUpdateParams(TypedDict, total=False):
    product_id: Optional[str]
    #: Ignored while a product is attached.
    title: str
    amount: float
    currency: str
    contact_id: str
    owner_user_id: Optional[str]
    expected_close_at: Optional[str]
    note: Optional[str]


class _DealMoveStageRequired(TypedDict):
    #: Target stage id (any pipeline of the workspace).
    stage_id: str


class DealMoveStageParams(_DealMoveStageRequired, total=False):
    #: Row within the stage column (0 = top). Omitted = top.
    index: int


class _DealSetStatusRequired(TypedDict):
    #: "open" reopens a closed deal.
    status: DealStatus


class DealSetStatusParams(_DealSetStatusRequired, total=False):
    #: Stored when marking the deal lost.
    lost_reason: str


class DealListParams(TypedDict, total=False):
    pipeline_id: str
    stage_id: str
    status: DealStatus
    contact_id: str
    owner_user_id: str
    #: Exact-match lookup by idempotency reference.
    external_reference: str
    #: Match title or contact name/phone/email.
    search: str
    #: Page size (max 100, default 25).
    limit: int
    offset: int


#: Deal record as returned by the API (open — servers may add fields).
#: ``POST /v1/deals`` responses additionally carry a top-level
#: ``duplicate: bool`` — ``True`` when ``external_reference`` matched an
#: existing deal that was updated instead (201 either way).
Deal = dict[str, Any]

# ─────────────────────────── Transactional email ───────────────────────────


class EmailTracking(TypedDict, total=False):
    #: Append a hidden open-tracking pixel to the HTML part. Default False.
    opens: bool
    #: Route absolute http(s) links through the click-redirect endpoint. Default False.
    clicks: bool


class _EmailSendRequired(TypedDict):
    to: str
    #: 1–998 chars, no control characters.
    subject: str
    #: Idempotency key, unique per workspace (max 255 chars). A repeat POST
    #: with the same key returns the original send (``duplicate: true``) and
    #: never sends twice.
    idempotency_key: str


class EmailSendParams(_EmailSendRequired, total=False):
    """``POST /v1/emails`` — transactional send. Content passes through
    verbatim (no footer / tracking / List-Unsubscribe injection unless opted
    in). At least one of ``html`` / ``text`` is required.
    """

    #: HTML body, verbatim. Max 500 KB. Derived from ``text`` when omitted.
    html: str
    #: Plain-text part, verbatim. Max 100 KB. Derived from ``html`` when omitted.
    text: str
    #: Defaults to the workspace's default verified sender profile.
    sender_profile_id: str
    reply_to: str
    #: Extra headers. Allowlist: ``List-Unsubscribe``, ``List-Unsubscribe-Post``.
    headers: dict[str, str]
    #: Arbitrary JSON (max 2048 bytes serialized), echoed in webhook events.
    metadata: dict[str, Any]
    #: Opt-in open/click tracking (default off).
    tracking: EmailTracking


class EmailSendResult(TypedDict):
    """Response of ``POST /v1/emails``. HTTP 201 = this request claimed the
    key; 200 = duplicate replay (``duplicate: true``) or a suppressed
    recipient (``status: "suppressed"`` with a deliberately coarse
    ``reason``).
    """

    id: str
    status: Literal["sent", "suppressed"]
    duplicate: bool
    to: str
    idempotency_key: str
    provider_message_id: Optional[str]
    reason: Optional[str]
    created_at: str


# ─────────────────────────── Webhook endpoints ───────────────────────────

EmailWebhookEventType = Literal[
    "email.delivered",
    "email.bounced",
    "email.complained",
    "email.failed",
    "email.opened",
    "email.clicked",
]

#: Every email event type accepted at registration. ``email.failed`` is DEPRECATED:
#: still accepted in ``events`` for backward compatibility, but never
#: delivered — a failing ``POST /v1/emails`` fails synchronously on the
#: request itself, so there is no asynchronous failure callback.
EMAIL_WEBHOOK_EVENT_TYPES: tuple[EmailWebhookEventType, ...] = (
    "email.delivered",
    "email.bounced",
    "email.complained",
    "email.failed",
    "email.opened",
    "email.clicked",
)

#: The server-side default subscription when ``events`` is omitted at
#: registration: the three delivery events.
DEFAULT_EMAIL_WEBHOOK_EVENT_TYPES: tuple[EmailWebhookEventType, ...] = (
    "email.delivered",
    "email.bounced",
    "email.complained",
)

OrderWebhookEventType = Literal[
    "order.created",
    "order.paid",
    "order.refunded",
    "order.cancelled",
    "order.fulfilled",
]

#: The five order lifecycle events. Opt-in by listing: an endpoint
#: registered without an explicit ``events`` list gets only the three
#: default email delivery events — order events flow only to endpoints that
#: list them. They fire for EVERY order write source (API, in-app,
#: automations), not just API-created orders.
ORDER_WEBHOOK_EVENT_TYPES: tuple[OrderWebhookEventType, ...] = (
    "order.created",
    "order.paid",
    "order.refunded",
    "order.cancelled",
    "order.fulfilled",
)

PaymentRequestWebhookEventType = Literal[
    "payment_request.created",
    "payment_request.paid",
    "payment_request.expired",
    "payment_request.cancelled",
]

#: The four payment-request (pay-link) lifecycle events. Opt-in by listing,
#: like the order events: an endpoint registered without an explicit
#: ``events`` list receives none of them. They fire for hosted pay-links
#: from EVERY mint source (API and in-app) — never for direct saved-card
#: charges or internal dunning-recovery links.
PAYMENT_REQUEST_WEBHOOK_EVENT_TYPES: tuple[PaymentRequestWebhookEventType, ...] = (
    "payment_request.created",
    "payment_request.paid",
    "payment_request.expired",
    "payment_request.cancelled",
)

#: Any event type registrable on a webhook endpoint.
WebhookEventType = Union[
    EmailWebhookEventType,
    OrderWebhookEventType,
    PaymentRequestWebhookEventType,
]


class _WebhookEndpointCreateRequired(TypedDict):
    url: str


class WebhookEndpointCreateParams(_WebhookEndpointCreateRequired, total=False):
    """``POST /v1/webhook-endpoints`` (max 3 per workspace).

    ``events`` defaults to the three delivery events (``email.delivered``,
    ``email.bounced``, ``email.complained``); the engagement types
    (``email.opened``, ``email.clicked``), the ``order.*`` lifecycle
    events, and the ``payment_request.*`` lifecycle events must be listed
    explicitly. An empty list is rejected.
    ``email.failed`` is deprecated — accepted at registration, but it never
    fires.
    """

    events: list[WebhookEventType]


WebhookEndpoint = dict[str, Any]


class WebhookEndpointList(TypedDict):
    data: list[dict[str, Any]]


#: Registration response — the ONLY time the ``whsec_…`` signing ``secret``
#: is returned. Store it now; it is never shown again.
WebhookEndpointCreated = dict[str, Any]

# ─────────────────────────── Webhook events (inbound) ───────────────────────────


class _WebhookEventDataRequired(TypedDict):
    send_id: str
    idempotency_key: Optional[str]
    to: str


class WebhookEventDataBase(_WebhookEventDataRequired, total=False):
    #: Echo of the ``metadata`` passed to POST /v1/emails (omitted when none).
    metadata: dict[str, Any]


class EmailBouncedEventData(WebhookEventDataBase, total=False):
    reason: str
    bounce_type: Literal["hard", "soft", "block"]


class EmailComplainedEventData(WebhookEventDataBase, total=False):
    reason: str


class EmailOpenedEventData(WebhookEventDataBase):
    #: Flags Apple-MPP/prefetch opens (forwarded, not dropped).
    machine_open: bool


class EmailClickedEventData(WebhookEventDataBase):
    #: The original (pre-redirect) href that was clicked.
    url: str


class EmailDeliveredEvent(TypedDict):
    id: str
    type: Literal["email.delivered"]
    created_at: str
    data: WebhookEventDataBase


class EmailBouncedEvent(TypedDict):
    id: str
    type: Literal["email.bounced"]
    created_at: str
    data: EmailBouncedEventData


class EmailComplainedEvent(TypedDict):
    id: str
    type: Literal["email.complained"]
    created_at: str
    data: EmailComplainedEventData


class EmailFailedEvent(TypedDict):
    """DEPRECATED — never delivered. Subscriptions to ``email.failed`` are
    accepted at registration for backward compatibility, but nothing
    produces this event: a failing ``POST /v1/emails`` fails synchronously
    on the request itself. Handle send failures from that response.
    """

    id: str
    type: Literal["email.failed"]
    created_at: str
    data: WebhookEventDataBase


class EmailOpenedEvent(TypedDict):
    id: str
    type: Literal["email.opened"]
    created_at: str
    data: EmailOpenedEventData


class EmailClickedEvent(TypedDict):
    id: str
    type: Literal["email.clicked"]
    created_at: str
    data: EmailClickedEventData


class OrderWebhookEventData(TypedDict):
    """Payload ``data`` of every ``order.*`` event. Money fields are JSON
    numbers in the order's charge currency; instants are ISO-8601 UTC or
    ``None``. ``number`` is the store display number when present, else the
    per-workspace sequential order number as a string. ``external_id`` and
    ``store_connection_id`` are populated for orders synced from a connected
    store and are ``None`` otherwise.
    """

    order_id: str
    external_id: Optional[str]
    number: str
    platform: str
    store_connection_id: Optional[str]
    financial_status: OrderFinancialStatus
    fulfillment_status: OrderFulfillmentStatus
    currency: str
    total: float
    subtotal: float
    discount_total: float
    shipping_total: float
    tax_total: float
    refunded_total: float
    coupon_codes: list[str]
    item_count: int
    first_item_name: Optional[str]
    placed_at: str
    paid_at: Optional[str]
    cancelled_at: Optional[str]
    refunded_at: Optional[str]
    created_at: str


class OrderRefundBlock(TypedDict):
    """The ``refund`` block carried by ``order.refunded`` events."""

    amount: float
    external_refund_id: Optional[str]
    reason: Optional[str]
    refunded_at: str


class OrderRefundedEventData(OrderWebhookEventData):
    refund: OrderRefundBlock


class OrderCreatedEvent(TypedDict):
    id: str
    type: Literal["order.created"]
    created_at: str
    data: OrderWebhookEventData


class OrderPaidEvent(TypedDict):
    id: str
    type: Literal["order.paid"]
    created_at: str
    data: OrderWebhookEventData


class OrderRefundedEvent(TypedDict):
    id: str
    type: Literal["order.refunded"]
    created_at: str
    data: OrderRefundedEventData


class OrderCancelledEvent(TypedDict):
    id: str
    type: Literal["order.cancelled"]
    created_at: str
    data: OrderWebhookEventData


class OrderFulfilledEvent(TypedDict):
    id: str
    type: Literal["order.fulfilled"]
    created_at: str
    data: OrderWebhookEventData


class PaymentRequestWebhookEventData(TypedDict):
    """Payload ``data`` of every ``payment_request.*`` event — a snapshot of
    the payment request at event time, following the order-event
    conventions: money is a JSON number in the request's currency, instants
    are ISO-8601 UTC or ``None``, and the full field set is always present
    (explicit nulls, never omitted keys). ``test_mode: True`` marks
    authorise-only test rows — their ``paid`` events never represent real
    money. ``contact_payment_id`` links the settled /v1/payments ledger row
    once paid. Provider correlation refs and row metadata are deliberately
    excluded — read ``GET /v1/payment-requests/:id`` when you need them.
    """

    payment_request_id: str
    status: PaymentRequestStatus
    contact_id: Optional[str]
    deal_id: Optional[str]
    provider: str
    amount: float
    currency: str
    title: Optional[str]
    vat_mode: Optional[PaymentVatMode]
    vat_rate: Optional[float]
    test_mode: bool
    pay_url: Optional[str]
    contact_payment_id: Optional[str]
    expires_at: Optional[str]
    paid_at: Optional[str]
    cancelled_at: Optional[str]
    created_at: Optional[str]


class PaymentRequestCreatedEvent(TypedDict):
    id: str
    type: Literal["payment_request.created"]
    created_at: str
    data: PaymentRequestWebhookEventData


class PaymentRequestPaidEvent(TypedDict):
    id: str
    type: Literal["payment_request.paid"]
    created_at: str
    data: PaymentRequestWebhookEventData


class PaymentRequestExpiredEvent(TypedDict):
    id: str
    type: Literal["payment_request.expired"]
    created_at: str
    data: PaymentRequestWebhookEventData


class PaymentRequestCancelledEvent(TypedDict):
    id: str
    type: Literal["payment_request.cancelled"]
    created_at: str
    data: PaymentRequestWebhookEventData


#: Any inbound webhook event. Discriminate on ``event["type"]``.
OtokWebhookEvent = Union[
    EmailDeliveredEvent,
    EmailBouncedEvent,
    EmailComplainedEvent,
    EmailFailedEvent,
    EmailOpenedEvent,
    EmailClickedEvent,
    OrderCreatedEvent,
    OrderPaidEvent,
    OrderRefundedEvent,
    OrderCancelledEvent,
    OrderFulfilledEvent,
    PaymentRequestCreatedEvent,
    PaymentRequestPaidEvent,
    PaymentRequestExpiredEvent,
    PaymentRequestCancelledEvent,
]

# ─────────────────────────── Campaigns ───────────────────────────


class _CampaignCreateRequired(TypedDict):
    name: str


class CampaignCreateParams(_CampaignCreateRequired, total=False):
    description: str
    #: Only draft/scheduled may be set via the API.
    status: Literal["draft", "scheduled"]
    type: Literal["broadcast", "drip", "triggered"]
    template_id: str
    #: Template name as approved by Meta.
    template_name: str
    #: Saved audience id; wins over ``audience_filters``.
    audience_id: str
    #: Ad-hoc audience definition — a ``$where`` condition tree:
    #: ``{"combinator": "and"|"or", "rules": [{"field", "operator", "value"}]}``.
    #: Validated on write. Ignored when ``audience_id`` is set.
    audience_filters: dict[str, Any]
    custom_message: str
    #: ISO 8601, e.g. "2026-07-01T09:00:00Z".
    scheduled_at: str
    #: IANA timezone, default "UTC".
    timezone: str
    #: WhatsApp instance to send from.
    instance_id: str
    #: Template variable mappings.
    variables: dict[str, Any]


class CampaignUpdateParams(TypedDict, total=False):
    name: str
    description: str
    status: Literal["draft", "scheduled"]
    type: Literal["broadcast", "drip", "triggered"]
    template_id: str
    template_name: str
    audience_id: str
    audience_filters: dict[str, Any]
    custom_message: str
    scheduled_at: str
    timezone: str
    instance_id: str
    variables: dict[str, Any]


Campaign = dict[str, Any]

# ─────────────────────────── Templates (WhatsApp) ───────────────────────────

MessageTemplate = dict[str, Any]


class _TemplateBodyVariableRequired(TypedDict):
    type: str
    text: str


class TemplateBodyVariable(_TemplateBodyVariableRequired, total=False):
    param_name: str


class _TemplateHeaderConfigRequired(TypedDict):
    type: Literal["text", "media"]


class TemplateHeaderConfig(_TemplateHeaderConfigRequired, total=False):
    variables: list[str]
    media_type: str
    media_link: str


class TemplateButtonConfig(TypedDict):
    type: str
    index: int
    parameters: list[str]


class _TemplateSendRequired(TypedDict):
    #: Recipient phone number in international format.
    to: str


class TemplateSendParams(_TemplateSendRequired, total=False):
    """``POST /v1/templates/:id/send``."""

    #: Body variable values, e.g. ``[{"type": "text", "text": "Jane"}]``.
    body_variables: list[TemplateBodyVariable]
    header_config: TemplateHeaderConfig
    button_configs: list[TemplateButtonConfig]


# ─────────────────────────── Payments ───────────────────────────

PaymentType = Literal["one_time", "recurring", "installments"]
PaymentEntryStatus = Literal["pending", "completed", "failed", "refunded"]
PaymentInterval = Literal["weekly", "monthly", "quarterly", "yearly"]
PaymentMethod = Literal["cash", "card", "bank_transfer", "other"]
#: VAT posture of a recurring plan / payment request: "inclusive" (VAT is
#: included in the amount) or "exclusive" (the amount is net; VAT is added on
#: top — exclusive + rate 0 = VAT-exempt). Always paired with a ``vat_rate``.
PaymentVatMode = Literal["inclusive", "exclusive"]


class _PaymentCreateRequired(TypedDict):
    type: PaymentType
    #: one-time: the amount; recurring: per cycle; installments: total deal.
    amount: float


class PaymentCreateParams(_PaymentCreateRequired, total=False):
    """``POST /v1/payments`` — idempotent upsert via ``external_reference``
    (a repeat POST updates that payment's mutable fields; the type/schedule
    is never restructured on a match — the response then carries
    ``duplicate: true``). Contact resolution as in deals.
    """

    contact_id: str
    phone: str
    email: str
    name: str
    product_id: str
    product_sku: str
    product_external_id: str
    title: str
    note: str
    method: PaymentMethod
    #: 3-letter code; defaults to the workspace currency.
    currency: str
    #: ISO date; defaults to now.
    purchase_date: str
    #: one-time only; defaults to "completed".
    status: PaymentEntryStatus
    #: recurring only; defaults to "monthly".
    interval: PaymentInterval
    #: recurring only: auto-generate each cycle's payment when due.
    auto_generate: bool
    #: recurring only: record the first cycle now (default True).
    record_first_payment: bool
    #: recurring only: ISO 8601 end date.
    recurring_end_at: str
    #: recurring only: max charge cycles (min 1).
    recurring_max_occurrences: int
    #: Recurring only, always together with ``vat_rate`` (a full pair — a
    #: lone leg 400s, and on other types the pair 400s). Omitted → the
    #: attached product's pair, else the workspace default. On an
    #: ``external_reference`` match a provided pair re-prices the plan.
    vat_mode: PaymentVatMode
    #: Recurring only, with ``vat_mode``: VAT percent (0–100, ≤2 decimals).
    vat_rate: float
    #: installments only: number of installments (min 2).
    installment_count: int
    external_reference: str
    #: Free-form JSON stored on the payment — max 2048 bytes serialized (400
    #: over the cap). On an ``external_reference`` match the provided object
    #: REPLACES the stored one (omit to keep it).
    metadata: dict[str, Any]


class PaymentUpdateParams(TypedDict, total=False):
    product_id: Optional[str]
    title: str
    note: str
    method: PaymentMethod
    #: one-time only.
    amount: float
    #: one-time only.
    status: PaymentEntryStatus
    #: recurring only.
    auto_generate: bool
    recurring_end_at: Optional[str]
    recurring_max_occurrences: Optional[int]
    #: Recurring only: replace the plan's stored VAT pair — always together
    #: with ``vat_rate``. Unlike the other type-restricted fields this is NOT
    #: silently ignored on other types (400), and lone legs / ``None``s are
    #: rejected. Omit both to keep the stored pair.
    vat_mode: PaymentVatMode
    #: Recurring only, with ``vat_mode``: VAT percent (0–100, ≤2 decimals).
    vat_rate: float
    #: Replace the payment's metadata object (max 2048 bytes serialized), or
    #: ``None`` to clear it. Omit to leave it as-is.
    metadata: Optional[dict[str, Any]]


class PaymentListParams(TypedDict, total=False):
    type: PaymentType
    status: Literal["active", "completed", "cancelled"]
    search: str
    #: Page size (max 100, default 25).
    limit: int
    offset: int


class PaymentRefundParams(TypedDict, total=False):
    #: The charge entry to refund; optional when the payment has one charge.
    entry_id: str
    #: Partial amount; defaults to the full remaining refundable balance.
    amount: float
    note: str


#: Payment record as returned by the API (open — servers may add fields).
#: ``POST /v1/payments`` responses additionally carry a top-level
#: ``duplicate: bool`` — ``True`` when ``external_reference`` matched an
#: existing payment that was updated instead (201 either way).
Payment = dict[str, Any]

# ─────────────────────────── Payment requests ───────────────────────────

PaymentRequestStatus = Literal["pending", "paid", "expired", "cancelled"]

#: Currencies accepted by the workspace payment providers.
PaymentRequestCurrency = Literal["ILS", "USD", "EUR", "GBP"]

#: Canonical Israeli tax-document taxonomy (payment requests + contact
#: documents).
PaymentDocumentKind = Literal[
    "tax_invoice",
    "tax_invoice_receipt",
    "receipt",
    "receipt_for_invoice",
    "proforma_invoice",
    "donation_receipt",
    "credit_invoice",
    "credit_invoice_receipt",
    "credit_receipt",
    "credit_donation_receipt",
    "order",
    "price_quote",
    "delivery_note",
    "payment_demand",
]


class _PaymentRequestCreateRequired(TypedDict):
    #: Amount to collect, in major units (≤2 decimals, min 0.01).
    amount: float


class PaymentRequestCreateParams(_PaymentRequestCreateRequired, total=False):
    """``POST /v1/payment-requests`` — mint a hosted pay-link through the
    workspace's own connected payment provider (Cardcom / Sumit).

    The payer resolves like payments/deals: provide ``contact_id``, OR
    ``phone``/``email`` (a matching contact is used, or created), OR a
    ``deal_id`` alone (the deal's contact pays).

    **There is NO idempotency key on this resource** — a repeat POST mints
    a second, independently payable link (cancel extras via
    ``payment_requests.cancel``). Because of that, the SDK never
    auto-retries this call on transient network errors.
    """

    contact_id: str
    phone: str
    email: str
    #: Used only when a NEW contact is created.
    name: str
    #: Deal to bind the request to; alone, the deal's contact is the payer.
    deal_id: str
    #: Omitted → the workspace payment currency.
    currency: PaymentRequestCurrency
    #: Payer-facing charge title (≤200 chars).
    title: str
    #: ≤2000 chars.
    note: str
    #: Max card installments offered on the hosted page (1–36).
    max_installments: int
    #: Tax-document kind to auto-issue; omitted → the provider/account default.
    document_kind: PaymentDocumentKind
    #: Auto-issue an Israeli tax document on successful charge (default True).
    auto_issue_document: bool
    #: Link expiry (ISO 8601). Clamped server-side to at most 72 hours from
    #: now (1 hour for test-mode requests); omitted → the maximum.
    expires_at: str
    #: Authorise-only test run — 400 when the connected provider has no test
    #: mode. Test requests never record real money.
    test_mode: bool
    #: Pre-expiry reminder emails; omitted → the workspace default.
    reminders_enabled: bool
    #: Offer the payer a save-my-card checkbox on the pay page — honored only
    #: when the connected provider supports card capture at checkout.
    offer_card_save: bool
    #: Per-request VAT override — always together with ``vat_rate`` (a lone
    #: leg 400s). Omitted → the workspace payments default.
    vat_mode: PaymentVatMode
    #: With ``vat_mode``: VAT percent (0–100, ≤2 decimals).
    vat_rate: float


class PaymentRequestListParams(TypedDict, total=False):
    """``GET /v1/payment-requests`` query params. Pages like deals/payments
    (default 25, cap 100; malformed paging 400s). Unlike deals/payments, an
    unknown ``status`` value 400s instead of being silently ignored.
    """

    status: PaymentRequestStatus
    contact_id: str
    deal_id: str
    #: Page size (max 100, default 25).
    limit: int
    offset: int


#: Payment request (pay-link) record as returned by the API (open — servers
#: may add fields). Lifecycle: pending → paid | expired | cancelled.
#: ``pay_url`` is the shareable hosted pay-page URL (computed on
#: create/get/list; the cancel response is the bare row without computed
#: fields; ``None`` on system-created ``charge_kind: "token"`` saved-card
#: rows). Once paid, ``contact_payment_id`` links the settled /v1/payments
#: ledger row and ``document`` (get/list) carries the issued tax-document
#: pointer. Create responses additionally carry ``checkout_url`` /
#: ``checkout_error`` (a provider failure at mint leaves the row pending
#: with ``checkout_error`` set — the link still works; the hosted page
#: retries the provider session on open). List rows join
#: ``contact_name``/``contact_phone``/``contact_email`` and a computed
#: ``refunded_total``.
PaymentRequest = dict[str, Any]

# ─────────────────────────── Contact documents ───────────────────────────

ContactDocumentOrigin = Literal["stored", "live", "merged"]


class _ContactDocumentSourceRequired(TypedDict):
    type: Literal["contact_payment", "payment_entry", "payment_request", "provider"]


class ContactDocumentSource(_ContactDocumentSourceRequired, total=False):
    """One record a contact document was aggregated from. ``id`` is present
    on the row-backed types; ``paymentId`` on ``payment_entry`` sources;
    ``provider`` on ``provider`` sources.
    """

    id: str
    paymentId: str
    provider: str


class ContactDocument(TypedDict):
    """One aggregated financial document (invoice / receipt / credit
    document) of a contact. ``url`` MAY be ``None`` (legacy number-only
    rows) — check before opening.
    """

    #: Aggregator-computed stable render key; carries no semantics.
    key: str
    #: Canonical kind when resolvable; else ``None`` with ``rawType`` set.
    kind: Optional[PaymentDocumentKind]
    rawType: Optional[str]
    isCredit: bool
    provider: Optional[str]
    documentId: Optional[str]
    #: Human-facing document number.
    number: Optional[str]
    url: Optional[str]
    #: ISO 8601 UTC. Stored: host-row instant; live: provider document date.
    date: Optional[str]
    amount: Optional[float]
    currency: Optional[str]
    origin: ContactDocumentOrigin
    sources: list[ContactDocumentSource]


class ContactDocumentsLive(TypedDict):
    """Status of the opt-in live provider lookup."""

    #: A live provider lookup was attempted.
    attempted: bool
    #: ``False`` = the provider lookup failed or timed out.
    ok: bool
    #: ``False`` = the live listing may be missing documents (partial).
    complete: bool
    error: Optional[Literal["timeout", "provider_error"]]


class ContactDocumentsResult(TypedDict):
    """Response of ``GET /v1/contacts/:id/documents``. ``documents`` is
    sorted date-descending (nulls last).
    """

    documents: list[ContactDocument]
    live: ContactDocumentsLive


# ─────────────────────────── Orders ───────────────────────────

OrderFinancialStatus = Literal[
    "pending",
    "paid",
    "partially_paid",
    "refunded",
    "partially_refunded",
    "voided",
]

#: Read-only via the API — fulfillment is recorded in oToK (or by a
#: connected store); no /v1 route sets it.
OrderFulfillmentStatus = Literal["unfulfilled", "partially_fulfilled", "fulfilled"]


class OrderItemParams(TypedDict, total=False):
    """A line item on ``POST /v1/orders`` (max 200 per order).

    Attach a catalog product with ``product_id`` (strict — unresolvable →
    400 ``INVALID_PRODUCT``) or ``product_sku`` / ``product_external_id``
    (tolerant — no match keeps the literal ``title`` with no product link);
    an inactive product always rejects (400 ``PRODUCT_INACTIVE``).
    Resolution order: ``product_id`` → ``product_sku`` →
    ``product_external_id``. When a product resolves, the line title
    derives from the product name (a client ``title`` is ignored); with no
    product, ``title`` is required (400 otherwise). The per-line
    ``line_total`` is server-computed:
    round2(quantity × unit_price × (1 − discount_percent/100)).
    """

    product_id: str
    product_sku: str
    product_external_id: str
    #: Required unless a product resolves (then derived from the product name).
    title: str
    #: Denormalized SKU snapshot on the line (falls back to ``product_sku``).
    sku: str
    #: In the order currency. Omitted with a priced product → the product's
    #: price; omitted with a product that has no catalog price → 400
    #: ``ORDER_ITEM_PRICE_REQUIRED``; omitted with no product → 0.
    unit_price: float
    #: Positive; decimals allowed (weight/hours). Default 1.
    quantity: float
    #: Percent-only per-line discount, 0–100.
    discount_percent: float


class OrderCreateParams(TypedDict, total=False):
    """``POST /v1/orders`` — create an order (idempotent upsert via
    ``external_reference``).

    Contact resolution as in deals/payments: provide ``contact_id`` OR
    ``phone``/``email`` (a matching contact is used, or created — ``name``
    applies only on create). A phone and an email resolving to two
    different contacts raises a 409 ``CONTACT_MERGE_REQUIRED``.

    A repeat POST with the same ``external_reference`` UPDATES that order
    instead of creating a duplicate: ``note`` / ``coupon_codes`` /
    ``placed_at`` / ``deal_id`` always apply; the money fields (``items``,
    ``currency``, ``discount_total``, ``shipping_total``, ``tax_total``)
    apply only while the order is still ``pending`` — once paid, money is
    locked and corrections flow through refunds/cancel; ``financial_status``
    and the order's contact never change on a match. Unlike the other
    create endpoints the response carries NO top-level ``duplicate`` flag —
    see :data:`Order`.
    """

    contact_id: str
    phone: str
    email: str
    #: Used only when a NEW contact is created.
    name: str
    #: Max 200 items.
    items: list[OrderItemParams]
    #: 3-letter code, uppercased; defaults to the workspace currency.
    currency: str
    #: Document-level discount (≥ 0).
    discount_total: float
    shipping_total: float
    tax_total: float
    #: ``pending`` (default) or ``paid`` — a paid create records the payment
    #: and fires order-paid automations. Never applied on an
    #: ``external_reference`` match.
    financial_status: Literal["pending", "paid"]
    #: ISO 8601; defaults to now.
    placed_at: str
    #: Applied discount/coupon codes (max 50).
    coupon_codes: list[str]
    #: Max 5000 chars.
    note: str
    #: Link a deal of the SAME contact (404 ``ORDER_DEAL_NOT_FOUND`` when
    #: unknown, 409 ``ORDER_DEAL_CONTACT_MISMATCH`` for another contact's).
    deal_id: str
    #: Idempotency key — one reference maps to one order. Max 255 chars.
    external_reference: str


class _OrderRefundRequired(TypedDict):
    #: Positive, in the order's currency; must not exceed the remaining
    #: total (``total − refunded_total``).
    amount: float


class OrderRefundParams(_OrderRefundRequired, total=False):
    """``POST /v1/orders/:id/refunds`` — record a refund.

    ``external_refund_id`` is the idempotency key: a repeat POST with the
    same value applies nothing and answers ``duplicate: True``. WITHOUT it
    refunds are NOT idempotent — every POST appends a new refund — so
    supply it whenever your system can retry.
    """

    #: Idempotency key per order (max 255 chars).
    external_refund_id: str
    #: Max 1000 chars.
    reason: str
    #: ISO 8601; defaults to now.
    refunded_at: str


class OrderMarkPaidParams(TypedDict, total=False):
    """``POST /v1/orders/:id/mark-paid`` (all fields optional)."""

    #: The ``external_reference`` of an EXISTING payment (e.g. one your
    #: system already recorded via ``POST /v1/payments``) to link the order
    #: onto instead of recording a new payment. Link-only — the payment's
    #: amount is never rewritten. Max 255 chars.
    payment_reference: str


class OrderListParams(TypedDict, total=False):
    """``GET /v1/orders`` query params (no ``search`` on this route).
    Ordering is ``placed_at`` descending.
    """

    #: Financial status; unknown values are silently ignored (unfiltered).
    status: OrderFinancialStatus
    contact_id: str
    #: Exact match — ``manual``, ``api``, ``automation`` (store platform
    #: values are reserved for orders synced from a connected store).
    source: str
    #: Matches orders synced from that connected store.
    store_connection_id: str
    #: Exact-match lookup by idempotency reference.
    external_reference: str
    #: Orders placed at/after (ISO 8601).
    placed_from: str
    #: Orders placed at/before (ISO 8601).
    placed_to: str
    #: Page size (max 100, default 25). Out-of-range values are clamped
    #: server-side rather than rejected.
    limit: int
    offset: int


#: Order record as returned by the API (open — servers may add fields).
#: Money fields (``total``, ``subtotal``, ``discount_total``,
#: ``shipping_total``, ``tax_total``, ``refunded_total``, line
#: ``unit_price``/``line_total``, refund ``amount``) are JSON numbers in
#: the order's currency. Every response joins the contact identity
#: (``contact_name``/``contact_phone``/``contact_email``); list rows omit
#: ``items``/``refunds``, which the detail read and every write response
#: include. Store-sync provenance fields (``store_connection_id``,
#: ``store_domain``, ``external_order_id``, ``number``,
#: ``external_updated_at``) are populated for orders synced from a
#: connected store and are ``None`` otherwise.
#:
#: Unlike the other create endpoints, ``POST /v1/orders`` responses carry
#: NO top-level ``duplicate`` flag — create and upsert-match both answer
#: 201 with the same full-order body. To distinguish, compare
#: ``created_at`` or pre-check with ``GET /v1/orders?external_reference=…``.
Order = dict[str, Any]

#: Order line item (``items[]`` on detail/write responses, ordered by
#: ``position``).
OrderItem = dict[str, Any]

#: Recorded refund (``refunds[]`` on detail/write responses, ordered by
#: ``refunded_at`` ascending).
OrderRefund = dict[str, Any]


class OrderRefundResult(TypedDict):
    """Response of ``POST /v1/orders/:id/refunds`` (201 either way).

    ``duplicate: True`` = the ``external_refund_id`` was already recorded
    on this order; nothing was applied and the current order state is
    returned.
    """

    duplicate: bool
    order: dict[str, Any]


# ─────────────────────────── Bookings ───────────────────────────

BookingStatus = Literal["confirmed", "cancelled", "completed", "no_show"]


class _BookingInviteeRequired(TypedDict):
    name: str
    email: str


class BookingInvitee(_BookingInviteeRequired, total=False):
    phone: str


class _BookingCreateRequired(TypedDict):
    meeting_type_id: str
    #: Slot start, ISO-8601 instant. Must be an open slot.
    start_at: str
    #: Invitee's IANA time zone.
    timezone: str


class BookingCreateParams(_BookingCreateRequired, total=False):
    """``POST /v1/bookings`` — provide EITHER ``contact_id`` OR an
    ``invitee`` object (upserted into contacts by phone/email). A taken
    slot raises a 409 ``SLOT_TAKEN`` error.
    """

    contact_id: str
    invitee: BookingInvitee
    notes: str
    #: Round-robin types only: pin the booking to this pool host.
    host_user_id: str


BookingListParams = TypedDict(
    "BookingListParams",
    {
        "status": BookingStatus,
        "meeting_type_id": str,
        # Only bookings with start_at >= from (ISO 8601).
        "from": str,
        # Only bookings with start_at <= to (ISO 8601).
        "to": str,
        # Default: -start_at.
        "sort": str,
        # Page size (max 500, default 50).
        "limit": int,
        "offset": int,
    },
    total=False,
)


class _BookingRescheduleRequired(TypedDict):
    start_at: str


class BookingRescheduleParams(_BookingRescheduleRequired, total=False):
    timezone: str


class BookingReassignParams(TypedDict, total=False):
    #: Target host; omit to auto-pick via round-robin (excluding current host).
    user_id: str
    reason: str
    #: Overrides HOST_UNAVAILABLE only; never bypasses the double-booking guard.
    force: bool


#: Booking record as returned by the API (open — servers may add fields).
#: ``POST /v1/bookings`` responses additionally carry a top-level
#: ``duplicate: bool`` — ``True`` when a double-submit of the same
#: slot/invitee returned the original booking (201 either way).
Booking = dict[str, Any]
MeetingType = dict[str, Any]

SlotsParams = TypedDict(
    "SlotsParams",
    {
        # ISO 8601 range start.
        "from": str,
        # ISO 8601 range end (exclusive). Range may not exceed 62 days.
        "to": str,
    },
)
