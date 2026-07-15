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

#: Every event type accepted at registration. ``email.failed`` is DEPRECATED:
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


class _WebhookEndpointCreateRequired(TypedDict):
    url: str


class WebhookEndpointCreateParams(_WebhookEndpointCreateRequired, total=False):
    """``POST /v1/webhook-endpoints`` (max 3 per workspace).

    ``events`` defaults to the three delivery events (``email.delivered``,
    ``email.bounced``, ``email.complained``); the engagement types
    (``email.opened``, ``email.clicked``) must be listed explicitly. An
    empty list is rejected. ``email.failed`` is deprecated — accepted at
    registration, but it never fires.
    """

    events: list[EmailWebhookEventType]


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


#: Any inbound webhook event. Discriminate on ``event["type"]``.
OtokWebhookEvent = Union[
    EmailDeliveredEvent,
    EmailBouncedEvent,
    EmailComplainedEvent,
    EmailFailedEvent,
    EmailOpenedEvent,
    EmailClickedEvent,
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
    #: installments only: number of installments (min 2).
    installment_count: int
    external_reference: str


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
