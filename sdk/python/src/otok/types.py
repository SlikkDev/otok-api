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

ConsentChannel = Literal["whatsapp", "email"]

#: ``unknown`` = no decision recorded yet (and never settable via the API).
ConsentState = Literal["subscribed", "unsubscribed", "unknown"]

ConsentBasis = Literal[
    "express_opt_in",
    "double_opt_in",
    "soft_opt_in",
    "implied",
    "imported",
]

#: Provider-owned delivery health — never writable through the API.
#: ``complained`` is sticky: consent on that channel can never be
#: re-subscribed via the API.
ConsentDeliverability = Literal[
    "unknown",
    "deliverable",
    "temporarily_bounced",
    "bounced",
    "complained",
]

#: One channel of a contact's consent picture (open — servers may add
#: fields). A channel without a stored decision reads
#: ``consent_state``/``deliverability`` ``"unknown"`` — treat unknown as not
#: sendable. The EMAIL channel additionally carries the composed send-time
#: suppression verdict (``suppressed`` + ``suppression_reason``), which is
#: independent of the consent decision.
ContactConsentChannel = dict[str, Any]

#: ``GET /v1/contacts/:id/consent`` — ``{"contact_id", "block_state",
#: "channels": {"whatsapp": …, "email": …}}``, both channels at once.
ContactConsent = dict[str, Any]


class _SetConsentRequired(TypedDict):
    #: ``"unknown"`` is a system state and cannot be set.
    state: Literal["subscribed", "unsubscribed"]


class SetConsentParams(_SetConsentRequired, total=False):
    """``PUT /v1/contacts/:id/consent/:channel`` — record a consent decision
    with its provenance (the evidence trail stores source, IP, and user
    agent).
    """

    #: Defaults to ``express_opt_in`` when subscribing.
    basis: ConsentBasis
    #: Where the decision came from in your system; recorded as
    #: ``api:<source>`` (plain ``api`` when omitted). Max 100 chars.
    source: str
    #: ISO 8601 — when this consent expires.
    expires_at: str
    #: End-user IP captured with the decision (evidence trail).
    ip: str
    #: End-user user agent captured with the decision (evidence trail).
    user_agent: str


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

# ─────────────────────────── Products ───────────────────────────


class _ProductCreateRequired(TypedDict):
    name: str


class ProductCreateParams(_ProductCreateRequired, total=False):
    """``POST /v1/products`` — create a product (idempotent upsert via
    ``external_id``: a repeat POST whose ``external_id`` matches an existing
    product updates that product instead of creating a duplicate — the
    response then carries ``duplicate: True``; 201 either way).
    """

    #: Per-workspace-unique product code (409 ``product_conflict`` on a
    #: clash). Max 100 chars.
    sku: Optional[str]
    #: Per-workspace-unique idempotency key. Max 200 chars.
    external_id: Optional[str]
    description: Optional[str]
    #: Default price in the workspace payment currency; ``None`` = dynamic
    #: pricing (deals need an explicit amount).
    price: Optional[float]
    #: Both-or-neither with ``vat_rate``; send both ``None`` to clear.
    vat_mode: Optional[PaymentVatMode]
    #: VAT percent (0–100, max 2 decimals); paired with ``vat_mode``.
    vat_rate: Optional[float]
    #: Inactive products stay on existing records but can't attach to new ones.
    is_active: bool


class ProductUpdateParams(TypedDict, total=False):
    """``PATCH /v1/products/:id`` — partial update; only the fields present
    change. There is no DELETE: deactivate with ``{"is_active": False}``.
    """

    name: str
    sku: Optional[str]
    external_id: Optional[str]
    description: Optional[str]
    price: Optional[float]
    vat_mode: Optional[PaymentVatMode]
    vat_rate: Optional[float]
    is_active: bool


class ProductListParams(TypedDict, total=False):
    #: Literal substring match on name or description (case-insensitive).
    q: str
    #: Exact-match lookup by SKU.
    sku: str
    #: Exact-match lookup by external id.
    external_id: str
    is_active: bool
    #: Page size (max 500, default 50).
    limit: int
    offset: int


#: Product record as returned by the API (open — servers may add fields).
#: ``POST /v1/products`` responses additionally carry a top-level
#: ``duplicate: bool`` — ``True`` when ``external_id`` matched an existing
#: product that was updated instead (201 either way).
Product = dict[str, Any]

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


# ─────────────────────────── Suppressions ───────────────────────────

#: Why an address is suppressed. API adds write one of
#: ``unsubscribe``/``bounce``/``complaint``/``manual``; system-created rows
#: may carry other values (e.g. ``global``).
SuppressionReason = Literal["unsubscribe", "bounce", "complaint", "manual", "global"]


class _SuppressionCreateRequired(TypedDict):
    email: str


class SuppressionCreateParams(_SuppressionCreateRequired, total=False):
    """``POST /v1/suppressions`` — idempotent add: re-adding an
    already-suppressed address returns the existing row with
    ``duplicate: True`` (201 either way). Adding a suppression does NOT
    change the contact's consent state — the two compose at send time.
    """

    #: Defaults to ``manual``.
    reason: Literal["unsubscribe", "bounce", "complaint", "manual"]
    #: Free-form note stored with the row (max 500 chars).
    note: str


class SuppressionListParams(TypedDict, total=False):
    #: Exact-match filter (case-insensitive).
    email: str
    #: Page size (max 500, default 50).
    limit: int
    offset: int


#: Suppression record as returned by the API (open — servers may add
#: fields). ``POST /v1/suppressions`` responses additionally carry a
#: top-level ``duplicate: bool``.
Suppression = dict[str, Any]

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

ContactWebhookEventType = Literal[
    "contact.created",
    "contact.updated",
    "contact.deleted",
    "contact.consent_changed",
]

#: The four contact lifecycle + consent events. Opt-in by listing, like the
#: order events. created/updated/deleted fire for intentional writes only —
#: bulk edits, CSV-import updates, and contact merges are deliberately quiet
#: (bulk DELETES do emit per contact); consent_changed fires on real
#: consent-state transitions plus suppress escalations, never for the
#: contact-create consent seed, same-state re-assertions, or double-opt-in
#: ceremony markers.
CONTACT_WEBHOOK_EVENT_TYPES: tuple[ContactWebhookEventType, ...] = (
    "contact.created",
    "contact.updated",
    "contact.deleted",
    "contact.consent_changed",
)

MessageWebhookEventType = Literal["message.received"]

#: The inbound message event. Opt-in by listing. v1 = real WhatsApp inbound
#: only, exactly once per WhatsApp message: reactions, blocked contacts, and
#: WhatsApp coexistence echoes/history imports are all silent. Media rides
#: as metadata only — never presigned URLs or storage keys.
MESSAGE_WEBHOOK_EVENT_TYPES: tuple[MessageWebhookEventType, ...] = ("message.received",)

DealWebhookEventType = Literal[
    "deal.created",
    "deal.stage_changed",
    "deal.won",
    "deal.lost",
]

#: The four deal lifecycle events. Opt-in by listing, like the order events.
#: They fire for EVERY deal write source — manual, API, automations, and
#: Salesforce sync — ``data["source"]`` says which.
DEAL_WEBHOOK_EVENT_TYPES: tuple[DealWebhookEventType, ...] = (
    "deal.created",
    "deal.stage_changed",
    "deal.won",
    "deal.lost",
)

BookingWebhookEventType = Literal[
    "booking.created",
    "booking.rescheduled",
    "booking.cancelled",
    "booking.reassigned",
]

#: The four booking lifecycle events. Opt-in by listing, like the order
#: events. ``booking.completed``/``booking.no_show`` deliberately do not
#: exist as webhooks — those statuses are sweep-derived, not user actions.
BOOKING_WEBHOOK_EVENT_TYPES: tuple[BookingWebhookEventType, ...] = (
    "booking.created",
    "booking.rescheduled",
    "booking.cancelled",
    "booking.reassigned",
)

EventAttendanceWebhookEventType = Literal["event.attendance.changed"]

#: The event-attendance event — ONE type for the whole family; the payload's
#: ``status``/``previous_status`` carry the transition. Opt-in by listing.
EVENT_ATTENDANCE_WEBHOOK_EVENT_TYPES: tuple[EventAttendanceWebhookEventType, ...] = (
    "event.attendance.changed",
)

FormWebhookEventType = Literal["form.submitted"]

#: The form submission event — ONE type for every surface; the payload's
#: ``origin`` distinguishes standalone form / landing page / popup. Opt-in
#: by listing.
FORM_WEBHOOK_EVENT_TYPES: tuple[FormWebhookEventType, ...] = ("form.submitted",)

#: Any event type registrable on a webhook endpoint.
WebhookEventType = Union[
    EmailWebhookEventType,
    OrderWebhookEventType,
    PaymentRequestWebhookEventType,
    ContactWebhookEventType,
    MessageWebhookEventType,
    DealWebhookEventType,
    BookingWebhookEventType,
    EventAttendanceWebhookEventType,
    FormWebhookEventType,
]


class _WebhookEndpointCreateRequired(TypedDict):
    url: str


class WebhookEndpointCreateParams(_WebhookEndpointCreateRequired, total=False):
    """``POST /v1/webhook-endpoints`` (max 3 per workspace).

    ``events`` defaults to the three delivery events (``email.delivered``,
    ``email.bounced``, ``email.complained``); every other family is opt-in
    and must be listed explicitly — the engagement types (``email.opened``,
    ``email.clicked``) and the ``order.*``, ``payment_request.*``,
    ``contact.*``, ``message.received``, ``deal.*``, ``booking.*``,
    ``event.attendance.changed``, and ``form.submitted`` families. A
    pre-existing registration never starts receiving a new family unasked.
    An empty list is rejected. ``email.failed`` is deprecated — accepted at
    registration, but it never fires.
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


class ContactWebhookSummary(TypedDict):
    """The compact ``contact`` block carried by ``contact.created`` /
    ``contact.updated`` payloads — a FIXED scalar-core projection: never
    junction arrays (tags/groups), custom fields, or engine-maintained
    columns. Fetch the full row with ``client.contacts.get(contact_id)``.
    """

    id: str
    phone: Optional[str]
    email: Optional[str]
    name: Optional[str]
    first_name: Optional[str]
    last_name: Optional[str]
    lifecycle_stage: Optional[str]
    source: Optional[str]
    block_state: Optional[str]
    lead_score: Optional[float]


class ContactCreatedEventData(TypedDict):
    contact_id: str
    contact: ContactWebhookSummary
    #: Which surface created the contact (e.g. ``manual``, ``api``, ``form``).
    source: str
    #: Always ``False`` — the event fires only for fresh inserts.
    duplicate: bool


class ContactUpdatedEventData(TypedDict):
    contact_id: str
    #: The changed field names — the same list the in-app Activity timeline
    #: records, including the ``tags``/``groups`` junction keys and
    #: ``custom_fields.<key>`` entries.
    changed_fields: list[str]
    contact: ContactWebhookSummary
    source: str


class ContactDeletedEventData(TypedDict):
    """Last-known identifiers only — the row is gone; key on ``contact_id``."""

    contact_id: str
    phone: Optional[str]
    email: Optional[str]
    name: Optional[str]


class ContactConsentChangedEventData(TypedDict):
    contact_id: str
    channel: ConsentChannel
    #: The consent-ledger action — e.g. ``opt_in``,
    #: ``double_opt_in_confirmed``, ``unsubscribe``, ``resubscribe``,
    #: ``suppress``. Tolerate unknown values.
    action: str
    consent_state: ConsentState
    #: ``None`` when no prior decision was stored.
    previous_state: Optional[ConsentState]
    basis: Optional[ConsentBasis]
    #: Provenance — API writes read ``api`` or ``api:<source>``.
    source: str
    #: The consent-evidence ledger row this change wrote.
    consent_event_id: str


class ContactCreatedEvent(TypedDict):
    id: str
    type: Literal["contact.created"]
    created_at: str
    data: ContactCreatedEventData


class ContactUpdatedEvent(TypedDict):
    id: str
    type: Literal["contact.updated"]
    created_at: str
    data: ContactUpdatedEventData


class ContactDeletedEvent(TypedDict):
    id: str
    type: Literal["contact.deleted"]
    created_at: str
    data: ContactDeletedEventData


class ContactConsentChangedEvent(TypedDict):
    id: str
    type: Literal["contact.consent_changed"]
    created_at: str
    data: ContactConsentChangedEventData


class MessageMediaBlock(TypedDict):
    """``message.received`` media block — METADATA only, never fetchable
    URLs.
    """

    mime_type: Optional[str]
    filename: Optional[str]
    bytes: Optional[int]


class _MessageReceivedEventDataRequired(TypedDict):
    message_id: str
    conversation_id: Optional[str]
    contact_id: Optional[str]
    channel: Literal["whatsapp_api"]
    #: Message type (``text``, ``image``, …). Tolerate unknown values.
    type: Optional[str]
    #: Body text, or the media caption, else ``None``.
    text: Optional[str]
    wa_message_id: Optional[str]
    #: The Meta-provided message timestamp (ISO 8601 UTC).
    timestamp: Optional[str]


class MessageReceivedEventData(_MessageReceivedEventDataRequired, total=False):
    """Real WhatsApp inbound only, exactly once per WhatsApp message.
    Every key except ``media`` is always present; ``media`` appears on
    media messages only.
    """

    #: Media messages only — omitted otherwise.
    media: MessageMediaBlock


class MessageReceivedEvent(TypedDict):
    id: str
    type: Literal["message.received"]
    created_at: str
    data: MessageReceivedEventData


class DealWebhookEventData(TypedDict):
    """Payload ``data`` of every ``deal.*`` event — a snapshot of the deal
    at event time, following the order-event conventions: money is a JSON
    number in the deal's currency, instants are ISO-8601 UTC or ``None``,
    and the full field set is always present (explicit nulls, never omitted
    keys). ``from_stage_id``/``from_stage_name`` are set on
    ``deal.stage_changed`` only.
    """

    deal_id: str
    contact_id: str
    pipeline_id: str
    pipeline_name: Optional[str]
    stage_id: str
    stage_name: Optional[str]
    from_stage_id: Optional[str]
    from_stage_name: Optional[str]
    status: DealStatus
    title: Optional[str]
    amount: Optional[float]
    currency: Optional[str]
    owner_user_id: Optional[str]
    external_reference: Optional[str]
    #: ``manual`` | ``api`` | ``automation`` | ``salesforce``. Tolerate
    #: unknown values.
    source: str
    expected_close_at: Optional[str]
    closed_at: Optional[str]
    lost_reason: Optional[str]


class DealCreatedEvent(TypedDict):
    id: str
    type: Literal["deal.created"]
    created_at: str
    data: DealWebhookEventData


class DealStageChangedEvent(TypedDict):
    id: str
    type: Literal["deal.stage_changed"]
    created_at: str
    data: DealWebhookEventData


class DealWonEvent(TypedDict):
    id: str
    type: Literal["deal.won"]
    created_at: str
    data: DealWebhookEventData


class DealLostEvent(TypedDict):
    id: str
    type: Literal["deal.lost"]
    created_at: str
    data: DealWebhookEventData


#: Known booking sources. Passed through verbatim from the booking row —
#: **tolerate unknown values**: new sources may appear without an SDK bump.
BookingWebhookSource = Literal["public_page", "manual", "api", "embed"]


class BookingWebhookEventData(TypedDict):
    """Payload ``data`` of every ``booking.*`` event — a snapshot of the
    booking at event time (full field set, explicit nulls). The booking
    module is deliberately multi-timezone, so BOTH the host and invitee
    timezones ride the payload. There is deliberately NO ``manage_url`` (a
    capability token). ``previous_host_name`` is set on
    ``booking.reassigned`` only.
    """

    booking_id: str
    contact_id: str
    meeting_type_id: Optional[str]
    meeting_type_name: Optional[str]
    host_user_id: Optional[str]
    host_name: Optional[str]
    previous_host_name: Optional[str]
    start_at: Optional[str]
    end_at: Optional[str]
    host_timezone: Optional[str]
    invitee_timezone: Optional[str]
    status: Optional[str]
    location_type: Optional[str]
    cancelled_by: Optional[str]
    cancel_reason: Optional[str]
    source: Optional[BookingWebhookSource]


class BookingCreatedEvent(TypedDict):
    id: str
    type: Literal["booking.created"]
    created_at: str
    data: BookingWebhookEventData


class BookingRescheduledEvent(TypedDict):
    id: str
    type: Literal["booking.rescheduled"]
    created_at: str
    data: BookingWebhookEventData


class BookingCancelledEvent(TypedDict):
    id: str
    type: Literal["booking.cancelled"]
    created_at: str
    data: BookingWebhookEventData


class BookingReassignedEvent(TypedDict):
    id: str
    type: Literal["booking.reassigned"]
    created_at: str
    data: BookingWebhookEventData


class EventAttendanceEventSnapshot(TypedDict):
    """The compact ``event`` block on ``event.attendance.changed``."""

    id: str
    name: Optional[str]
    start_at: Optional[str]


class EventAttendanceChangedEventData(TypedDict):
    attendance_id: str
    event_id: str
    contact_id: str
    #: ``registered`` | ``attending`` | ``attended`` | ``no_show`` |
    #: ``cancelled``. Tolerate unknown values.
    status: Optional[str]
    #: ``None`` for fresh registrations and set-based bulk status updates.
    previous_status: Optional[str]
    registered_at: Optional[str]
    attended_at: Optional[str]
    unregistered_at: Optional[str]
    #: Compact event snapshot — ``None`` when unavailable.
    event: Optional[EventAttendanceEventSnapshot]


class EventAttendanceChangedEvent(TypedDict):
    """ONE event type for the whole attendance family — filter on
    ``data["status"]``; ``data["previous_status"]`` carries the transition.
    """

    id: str
    type: Literal["event.attendance.changed"]
    created_at: str
    data: EventAttendanceChangedEventData


#: Known form-submission origins (the ``data["origin"]`` discriminator).
FormSubmissionOrigin = Literal["form", "landing_page", "popup"]


class FormSubmittedEventData(TypedDict):
    form_id: str
    form_name: str
    #: Unique per submission — a secondary dedup key for your CRM.
    submission_id: str
    #: ``None`` when contact auto-creation is off and no contact matched.
    contact_id: Optional[str]
    origin: FormSubmissionOrigin
    #: Set when ``origin`` is ``landing_page``, else ``None``.
    landing_page_id: Optional[str]
    #: Set when ``origin`` is ``popup``, else ``None``.
    popup_id: Optional[str]
    #: The submitted answers, keyed by form field ids.
    fields: dict[str, Any]


class FormSubmittedEvent(TypedDict):
    """ONE event type for every submission surface — ``data["origin"]``
    distinguishes standalone form / landing page / popup. Fires even when no
    contact was resolved (``data["contact_id"]`` is then ``None``).
    """

    id: str
    type: Literal["form.submitted"]
    created_at: str
    data: FormSubmittedEventData


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
    ContactCreatedEvent,
    ContactUpdatedEvent,
    ContactDeletedEvent,
    ContactConsentChangedEvent,
    MessageReceivedEvent,
    DealCreatedEvent,
    DealStageChangedEvent,
    DealWonEvent,
    DealLostEvent,
    BookingCreatedEvent,
    BookingRescheduledEvent,
    BookingCancelledEvent,
    BookingReassignedEvent,
    EventAttendanceChangedEvent,
    FormSubmittedEvent,
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

# ─────────────────────────── Audiences ───────────────────────────

#: ``dynamic`` — a stored condition tree re-evaluated live at every use;
#: ``static`` — a frozen membership list.
AudienceKind = Literal["dynamic", "static"]


class AudienceListParams(TypedDict, total=False):
    #: Exact kind filter; an unknown value raises a 400.
    kind: AudienceKind
    #: Page size (max 100, default 25).
    limit: int
    offset: int


#: Audience summary row as returned by ``GET /v1/audiences`` (open — servers
#: may add fields): id, name, kind, the advisory ``last_count`` /
#: ``last_counted_at`` size cache, and timestamps. The stored ``definition``
#: is deliberately never exposed through the public API.
AudienceSummary = dict[str, Any]

# ─────────────────────────── Sender profiles ───────────────────────────


class SenderProfileListParams(TypedDict, total=False):
    #: Page size (max 100, default 25).
    limit: int
    offset: int


#: Sender-profile row as returned by ``GET /v1/sender-profiles`` (open —
#: servers may add fields): the from identity (``from_name``, the composed
#: ``from_email``, ``reply_to``), ``provider``, ``is_default``, and the
#: sending-domain linkage (``sending_domain_id`` / ``domain`` /
#: ``domain_status``) with the ``verified`` send-readiness signal
#: (``domain_status == "verified"``). DKIM/DNS material is never returned.
SenderProfile = dict[str, Any]

# ─────────────── Email campaigns & newsletters ───────────────

EmailCampaignStatus = Literal[
    "draft",
    "scheduled",
    "sending",
    "paused",
    "sent",
    "failed",
    "cancelled",
]

NewsletterIssueStatus = Literal["draft", "scheduled", "published"]

#: Text direction of authored email content. Default "ltr".
ContentDirection = Literal["ltr", "rtl"]


class _ContentBlockRequired(TypedDict):
    kind: Literal[
        "heading",
        "paragraph",
        "button",
        "bullets",
        "spacer",
        "image",
        "divider",
        "snippet",
    ]


class ContentBlock(_ContentBlockRequired, total=False):
    """One typed block in ``ContentInput.blocks``. Field use per ``kind``:
    heading (``text`` + ``level`` 1–3), paragraph (``text``), button
    (``label`` + ``url``), bullets (``items``), spacer (no fields), image
    (``url`` — absolute https — + ``alt``), divider (no fields), snippet
    (``id`` or ``name``). Mistyped fields or an unknown ``kind`` raise a
    400 ``invalid_content``.
    """

    #: heading | paragraph text (may embed ``[[variable : fallback]]`` tokens).
    text: Optional[str]
    #: heading only — 1–3.
    level: Optional[int]
    #: button only.
    label: Optional[str]
    #: button | image target (image URLs must be absolute https).
    url: Optional[str]
    #: bullets only.
    items: Optional[list[str]]
    #: image only.
    alt: Optional[str]
    #: snippet only — resolve by snippet id.
    id: Optional[str]
    #: snippet only — resolve by case-insensitive exact name.
    name: Optional[str]


class ContentInput(TypedDict, total=False):
    """The shared authoring contract for email-campaign and newsletter-issue
    bodies: ``{direction?}`` plus EXACTLY ONE of ``markdown`` | ``blocks`` |
    ``design_json`` (zero or two-plus sources raise a 400
    ``invalid_content``). Content compiles immediately at write time — the
    response's ``compile`` envelope reports the result. Max source size
    512,000 chars.
    """

    #: "ltr" (default) or "rtl".
    direction: ContentDirection
    #: CommonMark subset (headings 1–3, bold/italic, links, lists, ``---``,
    #: blockquote, https images) plus the directive lines
    #: ``::button[Label](https://url)`` / ``::snippet[name-or-uuid]`` and
    #: ``[[variable : fallback]]`` tokens. Unsupported constructs degrade
    #: with ``compile.warnings``; raw HTML is stripped to its text.
    markdown: str
    #: Typed block array (see :class:`ContentBlock`).
    blocks: list[ContentBlock]
    #: A raw editor document (the native design JSON the in-app email editor
    #: submits), passed through with a structural sanity check only —
    #: snippets resolve by id, not name, in this form.
    design_json: dict[str, Any]


class CompileResult(TypedDict):
    """Write-time compile report on campaign/issue write responses (omitted
    only on a post-launch verbatim replay of a campaign create).
    ``ok: False`` means the stored content will not send as-is.
    """

    ok: bool
    errors: list[str]
    warnings: list[str]


class AudienceEstimate(TypedDict):
    """Response of ``GET /v1/email-campaigns/:id/estimate``."""

    estimated_recipients: int


class _EmailCampaignCreateRequired(TypedDict):
    #: Internal campaign name (≤200 chars).
    name: str
    #: Subject line (≤400 chars; may embed ``[[variable : fallback]]`` tokens).
    subject: str
    #: Sender profile id; must belong to the workspace (400
    #: ``sender_profile_not_found``). Send-readiness is asserted at launch.
    sender_profile_id: str
    content: ContentInput


class EmailCampaignCreateParams(_EmailCampaignCreateRequired, total=False):
    """``POST /v1/email-campaigns`` — create a draft campaign (idempotent
    upsert via ``external_reference``; 201 both outcomes). With no targeting
    fields the campaign goes to every send-eligible contact — check
    ``estimate`` before sending.
    """

    #: Preview snippet (≤400 chars).
    preheader: str
    #: Idempotency key (≤255 chars) — one reference maps to one campaign per
    #: workspace. A repeat POST updates the campaign while it is still
    #: draft/scheduled (never status or scheduled_at) and returns it
    #: verbatim once the launch claimed it; ``duplicate: True`` either way.
    external_reference: str
    #: Saved audience id; wins over ``audience_filters``.
    audience_id: str
    #: Ad-hoc audience definition — a ``$where`` condition tree (validated
    #: on write). Ignored when ``audience_id`` is set.
    audience_filters: dict[str, Any]
    #: Narrow to members of ANY of these contact groups.
    contact_group_ids: list[str]
    #: Preference-center topic key — contacts opted out of the topic are
    #: excluded from the audience.
    topic_key: str


class EmailCampaignUpdateParams(TypedDict, total=False):
    """``PATCH /v1/email-campaigns/:id`` — draft/scheduled campaigns only
    (409 ``campaign_not_editable`` otherwise). Same field set as create
    minus ``external_reference``; a ``content`` change recompiles (and
    detaches an in-app template — the patched content is what sends).
    ``None`` clears the nullable fields.
    """

    name: str
    subject: Optional[str]
    preheader: Optional[str]
    sender_profile_id: str
    content: ContentInput
    audience_id: Optional[str]
    audience_filters: Optional[dict[str, Any]]
    contact_group_ids: Optional[list[str]]
    topic_key: Optional[str]


class EmailCampaignListParams(TypedDict, total=False):
    #: Exact status filter; an unknown value raises a 400.
    status: EmailCampaignStatus
    #: Page size (max 100, default 25).
    limit: int
    offset: int


#: Email-campaign record as returned by the API (open — servers may add
#: fields). The stored subject/preheader answer under the request field
#: names ``subject``/``preheader``. Write responses carry a ``compile``
#: envelope (see :class:`CompileResult`) and POST responses a top-level
#: ``duplicate: bool``; list rows omit the content columns
#: (design_json/compiled_html/plain_text) and the in-app-only A/B fields.
EmailCampaign = dict[str, Any]


class _NewsletterCreateRequired(TypedDict):
    #: ≤120 chars; unique per workspace (409 ``duplicate_name``).
    name: str


class NewsletterCreateParams(_NewsletterCreateRequired, total=False):
    """``POST /v1/newsletters`` — a name alone suffices; cadence, enrollment
    policy and archive settings take their defaults (tune them in-app).
    Enforces the plan's ``max_newsletters`` limit (403
    ``PLAN_LIMIT_EXCEEDED``).
    """

    #: ≤2000 chars.
    description: str
    #: Omit to fall back to the workspace default sender at send time (400
    #: ``sender_profile_not_found`` when unknown).
    sender_profile_id: str


class NewsletterListParams(TypedDict, total=False):
    #: Page size (max 100, default 25).
    limit: int
    offset: int


#: Newsletter record as returned by the API (open — servers may add
#: fields); reads include a computed ``active_subscriber_count``. List rows
#: are a slim column subset.
Newsletter = dict[str, Any]


class NewsletterIssueCreateParams(TypedDict, total=False):
    """``POST /v1/newsletters/:id/issues`` — create a draft issue
    (idempotent upsert via ``external_reference``; 201 both outcomes).
    Everything is optional — an empty draft is fine; publish/schedule
    require a subject and content (409 ``issue_missing_content``).
    """

    #: ≤400 chars.
    subject: str
    #: ≤400 chars.
    preheader: str
    #: Default True.
    include_in_archive: bool
    #: Idempotency key (≤255 chars) — one reference maps to one issue per
    #: workspace. A repeat POST updates that issue's content/fields — never
    #: its status, scheduled_at or issue_number — with ``duplicate: True``;
    #: a reference held by an issue of a DIFFERENT newsletter raises a 409
    #: ``external_reference_in_use``.
    external_reference: str
    content: ContentInput


class NewsletterIssueUpdateParams(TypedDict, total=False):
    """``PATCH /v1/newsletter-issues/:id``. Published issues stay editable
    (a content change recompiles); a scheduled issue's content cannot be
    cleared — unschedule first. ``None`` clears subject/preheader.
    """

    subject: Optional[str]
    preheader: Optional[str]
    include_in_archive: bool
    content: ContentInput


class NewsletterIssueListParams(TypedDict, total=False):
    #: Exact status filter; an unknown value raises a 400.
    status: NewsletterIssueStatus
    #: Page size (max 100, default 25).
    limit: int
    offset: int


#: Newsletter-issue record as returned by the API (open — servers may add
#: fields). ``issue_number`` is null until publish assigns it. Write
#: responses carry a ``compile`` envelope (see :class:`CompileResult`) and
#: POST responses a top-level ``duplicate: bool``; list rows omit the
#: content columns.
NewsletterIssue = dict[str, Any]

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


class MeetingTypeEmbed(TypedDict):
    """Response of ``GET /v1/meeting-types/:id/embed`` — everything needed
    to put the booking calendar on your own website.

    ``embed_key`` is the workspace's **publishable** embed key (``bk_…``) —
    safe to ship in page HTML by design, and NOT the secret API key.
    Rotation, the origin allowlist, and the embed on/off switch live in the
    oToK app under Settings → Booking. Bookings made through the embed
    carry ``source: "embed"``.
    """

    #: The workspace's public ref used in hosted booking URLs.
    workspace_ref: str
    #: The meeting type's slug.
    slug: str
    #: Publishable workspace embed key (``bk_…``) — NOT the secret API key.
    embed_key: str
    #: The hosted booking page URL for this meeting type.
    page_url: str
    #: Ready-to-paste two-line HTML embed snippet.
    snippet_html: str
