/**
 * Types for the oToK public API (/v1).
 *
 * Request types mirror the API's wire contract exactly (snake_case field
 * names, the same required/optional split and enums as the server-side
 * validation). Unknown fields are rejected by the API with a 400, so only
 * documented fields are typed.
 *
 * Response types cover the stable, documented fields; servers may add fields
 * over time, so response records also allow unknown extras.
 */

// ─────────────────────────────── Shared ───────────────────────────────

/** Standard list envelope returned by paginated GET endpoints. */
export interface Paginated<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Shared list query params (contacts, tags, contact-groups, campaigns,
 * templates, meeting-types). `filter` is a JSON object of exact-match field
 * filters, e.g. `{ lifecycle_stage: "lead" }`. Filter values are type-checked
 * against the target field (dates, UUIDs, enums, numbers, booleans) — a
 * mistyped value is rejected with a 400 that names the field and expected
 * kind.
 */
export interface ListParams {
  filter?: Record<string, unknown>;
  /** Sort field; prefix with "-" for descending. Default: -created_at. */
  sort?: string;
  /** Page size (max 500, default 50). */
  limit?: number;
  /** Rows to skip (default 0). */
  offset?: number;
  /** Free-text search. */
  search?: string;
}

// ─────────────────────────────── Contacts ───────────────────────────────

export type LifecycleStage =
  | "lead"
  | "prospect"
  | "customer"
  | "inactive"
  | "archived";

export type ContactSource =
  | "manual"
  | "import"
  | "widget"
  | "campaign"
  | "api"
  | "form";

/**
 * Writable contact fields for POST /v1/contacts (create-or-update) and
 * PATCH /v1/contacts/:id.
 *
 * POST upserts by phone (canonicalized to E.164), falling back to email when
 * no phone is provided. `tags` / `groups` are NAMES — missing ones are
 * created automatically. On POST (upsert) they are ADDED to the existing
 * contact's sets; on PATCH they REPLACE the full set.
 */
export interface ContactUpsertParams {
  phone?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  avatar_url?: string;
  notes?: string;
  lifecycle_stage?: LifecycleStage;
  source?: ContactSource;
  block_state?: "none" | "workspace" | "global";
  company_name?: string;
  vat_number?: string;
  job_title?: string;
  industry?: string;
  company_website?: string;
  annual_revenue?: number;
  employee_count?: number;
  currency_preference?: string;
  address_line1?: string;
  address_line2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  country?: string;
  gender?: "male" | "female" | "other" | "prefer_not_to_say";
  /** ISO date, e.g. "1990-05-21". */
  date_of_birth?: string;
  language?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
  gclid?: string;
  fbclid?: string;
  /**
   * Lead score (0–100). Writable only while the workspace's lead-scoring
   * engine is disabled; ignored (engine-owned) when scoring is enabled.
   */
  lead_score?: number;
  linkedin_url?: string;
  facebook_url?: string;
  instagram_handle?: string;
  twitter_handle?: string;
  /** Workspace-defined custom fields, keyed by field key. */
  custom_fields?: Record<string, unknown>;
  /** Tag NAMES (max 100 chars each). */
  tags?: string[];
  /** Contact group NAMES (max 100 chars each). */
  groups?: string[];
}

export interface Contact {
  id: string;
  workspace_id: string;
  phone: string | null;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  lifecycle_stage: LifecycleStage | null;
  source: string | null;
  lead_score: number | null;
  /** Read-only: "cold" | "warm" | "hot", or null when never scored. */
  score_band: string | null;
  custom_fields: Record<string, unknown> | null;
  created_at: string;
  updated_at: string | null;
  [key: string]: unknown;
}

/**
 * Response of POST /v1/contacts. Both outcomes return HTTP 201; `duplicate`
 * tells them apart: `false` = a new contact was created, `true` = the upsert
 * matched an existing contact by phone/email and updated it (tags/groups
 * added, not replaced).
 */
export interface ContactUpsertResult extends Contact {
  duplicate: boolean;
}

/**
 * Contact note (GET /v1/contacts/:id/notes et al.). Plain-text annotation
 * on a contact; API note payloads are text only (rich text and mentions are
 * in-app features). Notes created via the API have no author user and are
 * attributed to source "api".
 */
export interface Note {
  id: string;
  workspace_id: string;
  contact_id: string;
  author_user_id: string | null;
  /** Included on list responses only. */
  author_name?: string | null;
  source: string;
  body: string;
  /** Rich-text body — in-app feature; null for API-created notes. */
  body_json: Record<string, unknown> | null;
  mentioned_user_ids: string[] | null;
  pinned_at: string | null;
  conversation_id: string | null;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

/**
 * PATCH /v1/notes/:id — both fields optional; sending neither returns the
 * note unchanged. A `body` change bumps `updated_at` (shows as "edited"
 * in-app); a pin toggle alone does not.
 */
export type ConsentChannel = "whatsapp" | "email";

/** `unknown` = no decision recorded yet (and never settable via the API). */
export type ConsentState = "subscribed" | "unsubscribed" | "unknown";

export type ConsentBasis =
  | "express_opt_in"
  | "double_opt_in"
  | "soft_opt_in"
  | "implied"
  | "imported";

/**
 * Provider-owned delivery health — never writable through the API.
 * `complained` is sticky: consent on that channel can never be re-subscribed
 * via the API.
 */
export type ConsentDeliverability =
  | "unknown"
  | "deliverable"
  | "temporarily_bounced"
  | "bounced"
  | "complained";

/**
 * One channel of a contact's consent picture. A channel without a stored
 * decision reads `consent_state`/`deliverability` "unknown" — treat unknown
 * as not sendable. On the EMAIL channel the object additionally carries the
 * composed send-time suppression verdict (`suppressed` +
 * `suppression_reason`), which is independent of the consent decision.
 */
export interface ContactConsentChannel {
  consent_state: ConsentState;
  consent_basis: ConsentBasis | null;
  /** Provenance — API writes read `api` or `api:<source>`. */
  consent_source: string | null;
  consent_at: string | null;
  consent_expires_at: string | null;
  deliverability: ConsentDeliverability;
  unsubscribed_at: string | null;
  complained_at: string | null;
  last_bounce_at: string | null;
  /** Email channel only: the composed send-time suppression verdict. */
  suppressed?: boolean;
  /**
   * Email channel only — why `suppressed` is true, prefixed by the layer
   * (e.g. `suppression:manual`, `blacklist:global`, `deliverability:bounced`).
   */
  suppression_reason?: string | null;
  [key: string]: unknown;
}

/** GET /v1/contacts/:id/consent — both channels at once. */
export interface ContactConsent {
  contact_id: string;
  /** Contact-level block state — independent of per-channel consent. */
  block_state: "none" | "workspace" | "global";
  channels: {
    whatsapp: ContactConsentChannel;
    email: ContactConsentChannel;
  };
  [key: string]: unknown;
}

/**
 * PUT /v1/contacts/:id/consent/:channel — record a consent decision with
 * its provenance (the evidence trail stores source, IP, and user agent).
 */
export interface SetConsentParams {
  /** "unknown" is a system state and cannot be set. */
  state: "subscribed" | "unsubscribed";
  /** Defaults to express_opt_in when subscribing. */
  basis?: ConsentBasis;
  /**
   * Where the decision came from in your system; recorded as `api:<source>`
   * (plain `api` when omitted). Max 100 chars.
   */
  source?: string;
  /** ISO 8601 — when this consent expires. */
  expires_at?: string;
  /** End-user IP captured with the decision (evidence trail). */
  ip?: string;
  /** End-user user agent captured with the decision (evidence trail). */
  user_agent?: string;
}

export interface NoteUpdateParams {
  /** New body (≤5000 chars; empty after trim → 400). */
  body?: string;
  /** Pin/unpin the note. */
  pinned?: boolean;
}

// ─────────────────────────── Tags / groups ───────────────────────────

export interface TagCreateParams {
  name: string;
  color?: string;
  type?: "contact" | "conversation" | "both";
}
export type TagUpdateParams = Partial<TagCreateParams>;

export interface Tag {
  id: string;
  workspace_id: string;
  name: string;
  color: string | null;
  type: string;
  created_at: string;
  [key: string]: unknown;
}

export interface ContactGroupCreateParams {
  name: string;
  description?: string;
  color?: string;
}
export type ContactGroupUpdateParams = Partial<ContactGroupCreateParams>;

export interface ContactGroup {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  color: string | null;
  created_at: string;
  [key: string]: unknown;
}

// ─────────────────────────── Pipelines / deals ───────────────────────────

export interface PipelineStage {
  id: string;
  name: string;
  position: number;
  color: string | null;
  /** 0–100; null behaves as 100% in forecasting. */
  win_probability: number | null;
  [key: string]: unknown;
}

export interface Pipeline {
  id: string;
  workspace_id: string;
  name: string;
  is_default: boolean;
  stages: PipelineStage[];
  [key: string]: unknown;
}

export type DealStatus = "open" | "won" | "lost";

/**
 * POST /v1/deals — create a deal (idempotent upsert via `external_reference`).
 *
 * Contact resolution: provide `contact_id` OR `phone`/`email` (a matching
 * contact is used, or created — `name` applies only on create).
 * A repeat POST with the same `external_reference` updates that deal's
 * mutable fields (and moves it when `stage_id` differs) instead of creating
 * a duplicate; status is never changed on a match.
 */
export interface DealCreateParams {
  contact_id?: string;
  phone?: string;
  email?: string;
  name?: string;
  /** Required unless a product is attached (then derived from the product). */
  title?: string;
  product_id?: string;
  product_sku?: string;
  product_external_id?: string;
  /** Defaults to the attached product's price, else 0. */
  amount?: number;
  /** 3-letter code; defaults to the workspace currency. */
  currency?: string;
  /** Defaults to the workspace default pipeline. */
  pipeline_id?: string;
  /** Defaults to the pipeline's first stage. */
  stage_id?: string;
  owner_user_id?: string;
  /** ISO 8601. */
  expected_close_at?: string;
  note?: string;
  /** Idempotency key — one reference maps to one deal. Max 255 chars. */
  external_reference?: string;
}

export interface DealUpdateParams {
  product_id?: string | null;
  /** Ignored while a product is attached. */
  title?: string;
  amount?: number;
  currency?: string;
  contact_id?: string;
  owner_user_id?: string | null;
  expected_close_at?: string | null;
  note?: string | null;
}

export interface DealMoveStageParams {
  /** Target stage id (any pipeline of the workspace). */
  stage_id: string;
  /** Row within the stage column (0 = top). Omitted = top. */
  index?: number;
}

export interface DealSetStatusParams {
  /** "open" reopens a closed deal. */
  status: DealStatus;
  /** Stored when marking the deal lost. */
  lost_reason?: string;
}

export interface DealListParams {
  pipeline_id?: string;
  stage_id?: string;
  status?: DealStatus;
  contact_id?: string;
  owner_user_id?: string;
  /** Exact-match lookup by idempotency reference. */
  external_reference?: string;
  /** Match title or contact name/phone/email. */
  search?: string;
  /** Page size (max 100, default 25). */
  limit?: number;
  offset?: number;
}

export interface Deal {
  id: string;
  workspace_id: string;
  pipeline_id: string;
  stage_id: string;
  contact_id: string;
  owner_user_id: string | null;
  title: string;
  product_id: string | null;
  amount: number | string | null;
  currency: string | null;
  status: DealStatus;
  lost_reason: string | null;
  closed_at: string | null;
  expected_close_at: string | null;
  external_reference: string | null;
  created_at: string;
  updated_at: string | null;
  [key: string]: unknown;
}

/**
 * Response of POST /v1/deals. Both outcomes return HTTP 201; `duplicate:
 * true` = `external_reference` matched an existing deal, whose mutable
 * fields were updated (and which moved when `stage_id` differs) — status is
 * never changed on a match.
 */
export interface DealCreateResult extends Deal {
  duplicate: boolean;
}

// ─────────────────────────── Products ───────────────────────────

/**
 * A row of the workspace product catalog, shared by deals and customer
 * payments. `price` null = dynamic pricing. `vat_mode`/`vat_rate` are one
 * both-or-neither pair (`null`s = the workspace payments default applies).
 */
export interface Product {
  id: string;
  workspace_id: string;
  name: string;
  /** Per-workspace-unique product code (human-facing). */
  sku: string | null;
  /** Per-workspace-unique id in your system — the POST idempotency key. */
  external_id: string | null;
  description: string | null;
  /** JSON number in the workspace payment currency; null = dynamic pricing. */
  price: number | null;
  vat_mode: PaymentVatMode | null;
  vat_rate: number | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

/**
 * POST /v1/products — create a product (idempotent upsert via `external_id`).
 * `name` is required on create; a repeat POST whose `external_id` matches an
 * existing product updates that product instead of creating a duplicate.
 */
export interface ProductCreateParams {
  name: string;
  /** Per-workspace-unique (409 `product_conflict` on a clash). Max 100 chars. */
  sku?: string | null;
  /** Per-workspace-unique idempotency key. Max 200 chars. */
  external_id?: string | null;
  description?: string | null;
  /** Default price; null = dynamic pricing (deals need an explicit amount). */
  price?: number | null;
  /** Both-or-neither with `vat_rate`; send both null to clear the override. */
  vat_mode?: PaymentVatMode | null;
  /** VAT percent (0–100, max 2 decimals); paired with `vat_mode`. */
  vat_rate?: number | null;
  /** Inactive products stay on existing records but can't attach to new ones. */
  is_active?: boolean;
}

/**
 * PATCH /v1/products/:id — partial update; only the fields present in the
 * body change. There is no DELETE: deactivate with `{ is_active: false }`.
 */
export type ProductUpdateParams = Partial<ProductCreateParams>;

export interface ProductListParams {
  /** Literal substring match on name or description (case-insensitive). */
  q?: string;
  /** Exact-match lookup by SKU. */
  sku?: string;
  /** Exact-match lookup by external id. */
  external_id?: string;
  is_active?: boolean;
  /** Page size (max 500, default 50). */
  limit?: number;
  offset?: number;
}

/**
 * Response of POST /v1/products. Both outcomes return HTTP 201; `duplicate:
 * true` = `external_id` matched an existing product, whose fields were
 * updated instead of a new product being created.
 */
export interface ProductUpsertResult extends Product {
  duplicate: boolean;
}

// ─────────────────────────── Transactional email ───────────────────────────

export interface EmailTracking {
  /** Append a hidden open-tracking pixel to the HTML part. Default false. */
  opens?: boolean;
  /** Route absolute http(s) links through the click-redirect endpoint. Default false. */
  clicks?: boolean;
}

/**
 * POST /v1/emails — transactional send. Content passes through verbatim
 * (no footer / tracking / List-Unsubscribe injection unless opted in).
 * At least one of `html` / `text` is required.
 */
export interface EmailSendParams {
  to: string;
  /** 1–998 chars, no control characters. */
  subject: string;
  /** HTML body, verbatim. Max 500 KB. Derived from `text` when omitted. */
  html?: string;
  /** Plain-text part, verbatim. Max 100 KB. Derived from `html` when omitted. */
  text?: string;
  /**
   * Idempotency key, unique per workspace (max 255 chars). A repeat POST with
   * the same key returns the original send (`duplicate: true`) and never
   * sends twice.
   */
  idempotency_key: string;
  /** Defaults to the workspace's default verified sender profile. */
  sender_profile_id?: string;
  reply_to?: string;
  /** Extra headers. Allowlist: `List-Unsubscribe`, `List-Unsubscribe-Post`. */
  headers?: Record<string, string>;
  /** Arbitrary JSON (max 2048 bytes serialized), echoed in webhook events. */
  metadata?: Record<string, unknown>;
  /** Opt-in open/click tracking (default off). */
  tracking?: EmailTracking;
}

/**
 * Response of POST /v1/emails. HTTP 201 = this request claimed the key;
 * 200 = duplicate replay (`duplicate: true`) or a suppressed recipient
 * (`status: "suppressed"` with a deliberately coarse `reason`).
 */
export interface EmailSendResult {
  id: string;
  status: "sent" | "suppressed";
  duplicate: boolean;
  to: string;
  idempotency_key: string;
  provider_message_id: string | null;
  reason: string | null;
  created_at: string;
}

// ─────────────────────────── Suppressions ───────────────────────────

/**
 * Why an address is suppressed. API adds write one of
 * `unsubscribe`/`bounce`/`complaint`/`manual`; system-created rows may carry
 * other values (e.g. `global`).
 */
export type SuppressionReason =
  | "unsubscribe"
  | "bounce"
  | "complaint"
  | "manual"
  | "global";

/**
 * A workspace email-suppression row — a send-time overlay deliberately
 * separate from consent: adding a row does NOT change any contact's consent
 * state, and removing one resubscribes no one; every email send checks both.
 */
export interface Suppression {
  id: string;
  email: string;
  reason: SuppressionReason;
  /** Which surface created the row — `api` for API adds. */
  source: string | null;
  note: string | null;
  created_at: string;
  [key: string]: unknown;
}

export interface SuppressionCreateParams {
  email: string;
  /** Defaults to `manual`. */
  reason?: "unsubscribe" | "bounce" | "complaint" | "manual";
  /** Free-form note stored with the row (max 500 chars). */
  note?: string;
}

export interface SuppressionListParams {
  /** Exact-match filter (case-insensitive). */
  email?: string;
  /** Page size (max 500, default 50). */
  limit?: number;
  offset?: number;
}

/**
 * Response of POST /v1/suppressions. Both outcomes return HTTP 201;
 * `duplicate: true` = the address was already suppressed and the existing
 * row is returned.
 */
export interface SuppressionCreateResult extends Suppression {
  duplicate: boolean;
}

// ─────────────────────────── Webhook endpoints ───────────────────────────

/**
 * Every email event type accepted by POST /v1/webhook-endpoints.
 *
 * `email.failed` is DEPRECATED: it is still accepted when listed explicitly
 * (existing registrations keep working) but it is NEVER delivered — nothing
 * produces this event. A failing POST /v1/emails fails synchronously on the
 * request itself, so handle send failures from that response instead.
 */
export const EMAIL_WEBHOOK_EVENT_TYPES = [
  "email.delivered",
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.opened",
  "email.clicked",
] as const;
export type EmailWebhookEventType = (typeof EMAIL_WEBHOOK_EVENT_TYPES)[number];

/**
 * The default subscription when `events` is omitted at registration: the
 * three delivery events. The engagement types (`email.opened`,
 * `email.clicked`) — and all `order.*` events — are opt-in by explicit
 * listing.
 */
export const DEFAULT_EMAIL_WEBHOOK_EVENT_TYPES = [
  "email.delivered",
  "email.bounced",
  "email.complained",
] as const satisfies readonly EmailWebhookEventType[];

/**
 * The five order lifecycle events. Opt-in by listing: an endpoint
 * registered without an explicit `events` list gets only the three default
 * email delivery events — order events flow only to endpoints that list
 * them. They fire for EVERY order write source (API, in-app, automations),
 * not just API-created orders.
 */
export const ORDER_WEBHOOK_EVENT_TYPES = [
  "order.created",
  "order.paid",
  "order.refunded",
  "order.cancelled",
  "order.fulfilled",
] as const;
export type OrderWebhookEventType = (typeof ORDER_WEBHOOK_EVENT_TYPES)[number];

/**
 * The four payment-request (pay-link) lifecycle events. Opt-in by listing,
 * like the order events: an endpoint registered without an explicit
 * `events` list receives none of them. They fire for hosted pay-links from
 * EVERY mint source (API and in-app) — never for direct saved-card charges
 * or internal dunning-recovery links.
 */
export const PAYMENT_REQUEST_WEBHOOK_EVENT_TYPES = [
  "payment_request.created",
  "payment_request.paid",
  "payment_request.expired",
  "payment_request.cancelled",
] as const;
export type PaymentRequestWebhookEventType =
  (typeof PAYMENT_REQUEST_WEBHOOK_EVENT_TYPES)[number];

/**
 * The four contact lifecycle + consent events. Opt-in by listing, like the
 * order events. created/updated/deleted fire for intentional writes only —
 * bulk edits, CSV-import updates, and contact merges are deliberately quiet
 * (bulk DELETES do emit per contact); consent_changed fires on real
 * consent-state transitions plus suppress escalations, never for the
 * contact-create consent seed, same-state re-assertions, or double-opt-in
 * ceremony markers.
 */
export const CONTACT_WEBHOOK_EVENT_TYPES = [
  "contact.created",
  "contact.updated",
  "contact.deleted",
  "contact.consent_changed",
] as const;
export type ContactWebhookEventType =
  (typeof CONTACT_WEBHOOK_EVENT_TYPES)[number];

/**
 * The inbound message event. Opt-in by listing. v1 = real WhatsApp inbound
 * only, exactly once per WhatsApp message: reactions, blocked contacts, and
 * WhatsApp coexistence echoes/history imports are all silent. Media rides as
 * metadata only — never presigned URLs or storage keys.
 */
export const MESSAGE_WEBHOOK_EVENT_TYPES = ["message.received"] as const;
export type MessageWebhookEventType =
  (typeof MESSAGE_WEBHOOK_EVENT_TYPES)[number];

/**
 * The four deal lifecycle events. Opt-in by listing, like the order events.
 * They fire for EVERY deal write source — manual, API, automations, and
 * Salesforce sync — `data.source` says which.
 */
export const DEAL_WEBHOOK_EVENT_TYPES = [
  "deal.created",
  "deal.stage_changed",
  "deal.won",
  "deal.lost",
] as const;
export type DealWebhookEventType = (typeof DEAL_WEBHOOK_EVENT_TYPES)[number];

/**
 * The four booking lifecycle events. Opt-in by listing, like the order
 * events. `booking.completed`/`booking.no_show` deliberately do not exist as
 * webhooks — those statuses are sweep-derived, not user actions.
 */
export const BOOKING_WEBHOOK_EVENT_TYPES = [
  "booking.created",
  "booking.rescheduled",
  "booking.cancelled",
  "booking.reassigned",
] as const;
export type BookingWebhookEventType =
  (typeof BOOKING_WEBHOOK_EVENT_TYPES)[number];

/**
 * The event-attendance event — ONE type for the whole family; the payload's
 * `status`/`previous_status` carry the transition. Opt-in by listing.
 */
export const EVENT_ATTENDANCE_WEBHOOK_EVENT_TYPES = [
  "event.attendance.changed",
] as const;
export type EventAttendanceWebhookEventType =
  (typeof EVENT_ATTENDANCE_WEBHOOK_EVENT_TYPES)[number];

/**
 * The form submission event — ONE type for every surface; the payload's
 * `origin` distinguishes standalone form / landing page / popup. Opt-in by
 * listing.
 */
export const FORM_WEBHOOK_EVENT_TYPES = ["form.submitted"] as const;
export type FormWebhookEventType = (typeof FORM_WEBHOOK_EVENT_TYPES)[number];

/** Any event type registrable on a webhook endpoint. */
export type WebhookEventType =
  | EmailWebhookEventType
  | OrderWebhookEventType
  | PaymentRequestWebhookEventType
  | ContactWebhookEventType
  | MessageWebhookEventType
  | DealWebhookEventType
  | BookingWebhookEventType
  | EventAttendanceWebhookEventType
  | FormWebhookEventType;

/**
 * POST /v1/webhook-endpoints (max 3 per workspace).
 * `events` defaults to the three delivery events (`email.delivered`,
 * `email.bounced`, `email.complained`); every other family is opt-in and
 * must be listed explicitly — the engagement types (`email.opened`,
 * `email.clicked`) and the `order.*`, `payment_request.*`, `contact.*`,
 * `message.received`, `deal.*`, `booking.*`, `event.attendance.changed`,
 * and `form.submitted` families. A pre-existing registration never starts
 * receiving a new family unasked. An empty array is rejected.
 * `email.failed` is deprecated — accepted when listed, never delivered.
 */
export interface WebhookEndpointCreateParams {
  url: string;
  events?: WebhookEventType[];
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: WebhookEventType[];
  created_at: string;
  [key: string]: unknown;
}

/** Registration response — the ONLY time the signing secret is returned. */
export interface WebhookEndpointCreated extends WebhookEndpoint {
  /** `whsec_…` signing secret. Store it now; it is never shown again. */
  secret: string;
}

// ─────────────────────────── Webhook events (inbound) ───────────────────────────

interface WebhookEventDataBase {
  send_id: string;
  idempotency_key: string | null;
  to: string;
  /** Echo of the `metadata` passed to POST /v1/emails (omitted when none). */
  metadata?: Record<string, unknown>;
}

export interface EmailDeliveredEvent {
  id: string;
  type: "email.delivered";
  created_at: string;
  data: WebhookEventDataBase;
}
export interface EmailBouncedEvent {
  id: string;
  type: "email.bounced";
  created_at: string;
  data: WebhookEventDataBase & {
    reason?: string;
    bounce_type?: "hard" | "soft" | "block";
  };
}
export interface EmailComplainedEvent {
  id: string;
  type: "email.complained";
  created_at: string;
  data: WebhookEventDataBase & { reason?: string };
}
/**
 * @deprecated Never delivered — nothing produces this event. A failing
 * POST /v1/emails fails synchronously on the request itself; handle send
 * failures from that response. Kept only so existing handlers keep
 * compiling.
 */
export interface EmailFailedEvent {
  id: string;
  type: "email.failed";
  created_at: string;
  data: WebhookEventDataBase;
}
export interface EmailOpenedEvent {
  id: string;
  type: "email.opened";
  created_at: string;
  /** `machine_open` flags Apple-MPP/prefetch opens (forwarded, not dropped). */
  data: WebhookEventDataBase & { machine_open: boolean };
}
export interface EmailClickedEvent {
  id: string;
  type: "email.clicked";
  created_at: string;
  /** `url` is the original (pre-redirect) href that was clicked. */
  data: WebhookEventDataBase & { url: string };
}

/**
 * Payload `data` of every `order.*` event — a snapshot of the order at
 * event time. Money fields are JSON numbers in the order's charge currency;
 * instants are ISO-8601 UTC or `null` (unlike email events, absent values
 * are explicit `null`s, never omitted keys). `number` is the store display
 * number when present, else the internal sequential order number as a
 * string. `external_id` and `store_connection_id` are populated for orders
 * synced from a connected store and are `null` otherwise.
 */
export interface OrderWebhookEventData {
  order_id: string;
  external_id: string | null;
  number: string;
  platform: string;
  store_connection_id: string | null;
  financial_status: OrderFinancialStatus;
  fulfillment_status: OrderFulfillmentStatus;
  currency: string;
  total: number;
  subtotal: number;
  discount_total: number;
  shipping_total: number;
  tax_total: number;
  refunded_total: number;
  coupon_codes: string[];
  item_count: number;
  first_item_name: string | null;
  placed_at: string;
  paid_at: string | null;
  cancelled_at: string | null;
  refunded_at: string | null;
  created_at: string;
}

/** The `refund` block carried by `order.refunded` events. */
export interface OrderRefundBlock {
  amount: number;
  external_refund_id: string | null;
  reason: string | null;
  refunded_at: string;
}

export interface OrderCreatedEvent {
  id: string;
  type: "order.created";
  created_at: string;
  data: OrderWebhookEventData;
}
export interface OrderPaidEvent {
  id: string;
  type: "order.paid";
  created_at: string;
  data: OrderWebhookEventData;
}
export interface OrderRefundedEvent {
  id: string;
  type: "order.refunded";
  created_at: string;
  data: OrderWebhookEventData & { refund: OrderRefundBlock };
}
export interface OrderCancelledEvent {
  id: string;
  type: "order.cancelled";
  created_at: string;
  data: OrderWebhookEventData;
}
export interface OrderFulfilledEvent {
  id: string;
  type: "order.fulfilled";
  created_at: string;
  data: OrderWebhookEventData;
}

/**
 * Payload `data` of every `payment_request.*` event — a snapshot of the
 * payment request at event time, following the order-event conventions:
 * money is a JSON number in the request's currency, instants are ISO-8601
 * UTC or `null`, and the full field set is always present (explicit nulls,
 * never omitted keys). `test_mode: true` marks authorise-only test rows —
 * their `paid` events never represent real money. `contact_payment_id`
 * links the settled /v1/payments ledger row once paid. Provider correlation
 * refs and row metadata are deliberately excluded — read
 * GET /v1/payment-requests/:id when you need them.
 */
export interface PaymentRequestWebhookEventData {
  payment_request_id: string;
  status: PaymentRequestStatus;
  contact_id: string | null;
  deal_id: string | null;
  provider: string;
  amount: number;
  currency: string;
  title: string | null;
  vat_mode: PaymentVatMode | null;
  vat_rate: number | null;
  test_mode: boolean;
  pay_url: string | null;
  contact_payment_id: string | null;
  expires_at: string | null;
  paid_at: string | null;
  cancelled_at: string | null;
  created_at: string | null;
}

export interface PaymentRequestCreatedEvent {
  id: string;
  type: "payment_request.created";
  created_at: string;
  data: PaymentRequestWebhookEventData;
}
export interface PaymentRequestPaidEvent {
  id: string;
  type: "payment_request.paid";
  created_at: string;
  data: PaymentRequestWebhookEventData;
}
export interface PaymentRequestExpiredEvent {
  id: string;
  type: "payment_request.expired";
  created_at: string;
  data: PaymentRequestWebhookEventData;
}
export interface PaymentRequestCancelledEvent {
  id: string;
  type: "payment_request.cancelled";
  created_at: string;
  data: PaymentRequestWebhookEventData;
}

/**
 * The compact `contact` block carried by `contact.created`/`contact.updated`
 * payloads — a FIXED scalar-core projection: never junction arrays
 * (tags/groups), custom fields, or engine-maintained columns. Fetch the full
 * row with `otok.contacts.get(contact_id)`.
 */
export interface ContactWebhookSummary {
  id: string;
  phone: string | null;
  email: string | null;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  lifecycle_stage: string | null;
  source: string | null;
  block_state: string | null;
  lead_score: number | null;
}

export interface ContactCreatedEvent {
  id: string;
  type: "contact.created";
  created_at: string;
  data: {
    contact_id: string;
    contact: ContactWebhookSummary;
    /** Which surface created the contact (e.g. `manual`, `api`, `form`). */
    source: string;
    /** Always `false` — the event fires only for fresh inserts. */
    duplicate: boolean;
  };
}
export interface ContactUpdatedEvent {
  id: string;
  type: "contact.updated";
  created_at: string;
  data: {
    contact_id: string;
    /**
     * The changed field names — the same list the in-app Activity timeline
     * records, including the `tags`/`groups` junction keys and
     * `custom_fields.<key>` entries.
     */
    changed_fields: string[];
    contact: ContactWebhookSummary;
    source: string;
  };
}
/** Last-known identifiers only — the row is gone; key on `contact_id`. */
export interface ContactDeletedEvent {
  id: string;
  type: "contact.deleted";
  created_at: string;
  data: {
    contact_id: string;
    phone: string | null;
    email: string | null;
    name: string | null;
  };
}
export interface ContactConsentChangedEvent {
  id: string;
  type: "contact.consent_changed";
  created_at: string;
  data: {
    contact_id: string;
    channel: ConsentChannel;
    /**
     * The consent-ledger action — e.g. `opt_in`, `double_opt_in_confirmed`,
     * `unsubscribe`, `resubscribe`, `suppress`. Tolerate unknown values.
     */
    action: string;
    consent_state: ConsentState;
    /** `null` when no prior decision was stored. */
    previous_state: ConsentState | null;
    basis: ConsentBasis | null;
    /** Provenance — API writes read `api` or `api:<source>`. */
    source: string;
    /** The consent-evidence ledger row this change wrote. */
    consent_event_id: string;
  };
}

/** `message.received` media block — METADATA only, never fetchable URLs. */
export interface MessageMediaBlock {
  mime_type: string | null;
  filename: string | null;
  bytes: number | null;
}

/**
 * Real WhatsApp inbound only, exactly once per WhatsApp message. `media` is
 * present on media messages only (omitted otherwise).
 */
export interface MessageReceivedEvent {
  id: string;
  type: "message.received";
  created_at: string;
  data: {
    message_id: string;
    conversation_id: string | null;
    contact_id: string | null;
    channel: "whatsapp_api";
    /** Message type (`text`, `image`, …). Tolerate unknown values. */
    type: string | null;
    /** Body text, or the media caption, else `null`. */
    text: string | null;
    media?: MessageMediaBlock;
    wa_message_id: string | null;
    /** The Meta-provided message timestamp (ISO 8601 UTC). */
    timestamp: string | null;
  };
}

/**
 * Known booking sources. Passed through verbatim from the booking row —
 * **tolerate unknown values**: new sources may appear without an SDK bump.
 */
export type BookingWebhookSource = "public_page" | "manual" | "api" | "embed";

/**
 * Payload `data` of every `deal.*` event — a snapshot of the deal at event
 * time, following the order-event conventions: money is a JSON number in the
 * deal's currency, instants are ISO-8601 UTC or `null`, and the full field
 * set is always present (explicit nulls, never omitted keys).
 * `from_stage_id`/`from_stage_name` are set on `deal.stage_changed` only.
 */
export interface DealWebhookEventData {
  deal_id: string;
  contact_id: string;
  pipeline_id: string;
  pipeline_name: string | null;
  stage_id: string;
  stage_name: string | null;
  from_stage_id: string | null;
  from_stage_name: string | null;
  status: DealStatus;
  title: string | null;
  amount: number | null;
  currency: string | null;
  owner_user_id: string | null;
  external_reference: string | null;
  /** `manual` | `api` | `automation` | `salesforce`. Tolerate unknown values. */
  source: string;
  expected_close_at: string | null;
  closed_at: string | null;
  lost_reason: string | null;
}

export interface DealCreatedEvent {
  id: string;
  type: "deal.created";
  created_at: string;
  data: DealWebhookEventData;
}
export interface DealStageChangedEvent {
  id: string;
  type: "deal.stage_changed";
  created_at: string;
  data: DealWebhookEventData;
}
export interface DealWonEvent {
  id: string;
  type: "deal.won";
  created_at: string;
  data: DealWebhookEventData;
}
export interface DealLostEvent {
  id: string;
  type: "deal.lost";
  created_at: string;
  data: DealWebhookEventData;
}

/**
 * Payload `data` of every `booking.*` event — a snapshot of the booking at
 * event time (full field set, explicit nulls). The booking module is
 * deliberately multi-timezone, so BOTH the host and invitee timezones ride
 * the payload. There is deliberately NO `manage_url` (a capability token).
 * `previous_host_name` is set on `booking.reassigned` only.
 */
export interface BookingWebhookEventData {
  booking_id: string;
  contact_id: string;
  meeting_type_id: string | null;
  meeting_type_name: string | null;
  host_user_id: string | null;
  host_name: string | null;
  previous_host_name: string | null;
  start_at: string | null;
  end_at: string | null;
  host_timezone: string | null;
  invitee_timezone: string | null;
  status: string | null;
  location_type: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  source: BookingWebhookSource | null;
}

export interface BookingCreatedEvent {
  id: string;
  type: "booking.created";
  created_at: string;
  data: BookingWebhookEventData;
}
export interface BookingRescheduledEvent {
  id: string;
  type: "booking.rescheduled";
  created_at: string;
  data: BookingWebhookEventData;
}
export interface BookingCancelledEvent {
  id: string;
  type: "booking.cancelled";
  created_at: string;
  data: BookingWebhookEventData;
}
export interface BookingReassignedEvent {
  id: string;
  type: "booking.reassigned";
  created_at: string;
  data: BookingWebhookEventData;
}

/**
 * ONE event type for the whole attendance family — filter on `data.status`;
 * `data.previous_status` carries the transition (`null` for fresh
 * registrations and set-based bulk status updates).
 */
export interface EventAttendanceChangedEvent {
  id: string;
  type: "event.attendance.changed";
  created_at: string;
  data: {
    attendance_id: string;
    event_id: string;
    contact_id: string;
    /** `registered` | `attending` | `attended` | `no_show` | `cancelled`. */
    status: string | null;
    previous_status: string | null;
    registered_at: string | null;
    attended_at: string | null;
    unregistered_at: string | null;
    /** Compact event snapshot — `null` when unavailable. */
    event: { id: string; name: string | null; start_at: string | null } | null;
  };
}

/** Known form-submission origins (the `data.origin` discriminator). */
export type FormSubmissionOrigin = "form" | "landing_page" | "popup";

/**
 * ONE event type for every submission surface — `data.origin` distinguishes
 * standalone form / landing page / popup. Fires even when no contact was
 * resolved (`data.contact_id` is then `null`).
 */
export interface FormSubmittedEvent {
  id: string;
  type: "form.submitted";
  created_at: string;
  data: {
    form_id: string;
    form_name: string;
    /** Unique per submission — a secondary dedup key for your CRM. */
    submission_id: string;
    contact_id: string | null;
    origin: FormSubmissionOrigin;
    /** Set when `origin` is `landing_page`, else `null`. */
    landing_page_id: string | null;
    /** Set when `origin` is `popup`, else `null`. */
    popup_id: string | null;
    /** The submitted answers, keyed by form field ids. */
    fields: Record<string, unknown>;
  };
}

export type OtokWebhookEvent =
  | EmailDeliveredEvent
  | EmailBouncedEvent
  | EmailComplainedEvent
  | EmailFailedEvent
  | EmailOpenedEvent
  | EmailClickedEvent
  | OrderCreatedEvent
  | OrderPaidEvent
  | OrderRefundedEvent
  | OrderCancelledEvent
  | OrderFulfilledEvent
  | PaymentRequestCreatedEvent
  | PaymentRequestPaidEvent
  | PaymentRequestExpiredEvent
  | PaymentRequestCancelledEvent
  | ContactCreatedEvent
  | ContactUpdatedEvent
  | ContactDeletedEvent
  | ContactConsentChangedEvent
  | MessageReceivedEvent
  | DealCreatedEvent
  | DealStageChangedEvent
  | DealWonEvent
  | DealLostEvent
  | BookingCreatedEvent
  | BookingRescheduledEvent
  | BookingCancelledEvent
  | BookingReassignedEvent
  | EventAttendanceChangedEvent
  | FormSubmittedEvent;

// ─────────────────────────── Campaigns ───────────────────────────

export interface CampaignCreateParams {
  name: string;
  description?: string;
  /** Only draft/scheduled may be set via the API. */
  status?: "draft" | "scheduled";
  type?: "broadcast" | "drip" | "triggered";
  template_id?: string;
  /** Template name as approved by Meta. */
  template_name?: string;
  /** Saved audience id; wins over `audience_filters`. */
  audience_id?: string;
  /**
   * Ad-hoc audience definition — a `$where` condition tree:
   * `{ combinator: "and"|"or", rules: [{ field, operator, value }] }`.
   * Validated on write. Ignored when `audience_id` is set.
   */
  audience_filters?: Record<string, unknown>;
  custom_message?: string;
  /** ISO 8601, e.g. "2026-07-01T09:00:00Z". */
  scheduled_at?: string;
  /** IANA timezone, default "UTC". */
  timezone?: string;
  /** WhatsApp instance to send from. */
  instance_id?: string;
  /** Template variable mappings. */
  variables?: Record<string, unknown>;
}
export type CampaignUpdateParams = Partial<CampaignCreateParams>;

export interface Campaign {
  id: string;
  workspace_id: string;
  name: string;
  status: string;
  type: string;
  template_id: string | null;
  audience_id: string | null;
  scheduled_at: string | null;
  created_at: string;
  [key: string]: unknown;
}

/**
 * Response of POST /v1/campaigns/:id/execute — HTTP 200 when the campaign
 * was queued. Failures are real HTTP errors thrown as OtokApiError:
 * 404 `campaign_not_found` (unknown id) and 409 `campaign_not_scheduled`
 * (only "scheduled" campaigns can be executed).
 */
export interface CampaignExecuteResult {
  /** Always true — failures throw instead of returning `success: false`. */
  success: true;
  message: string;
  /** Background job id, "execute-<campaignId>". */
  jobId: string;
  [key: string]: unknown;
}

// ─────────────────────────── Audiences ───────────────────────────

export type AudienceKind = "dynamic" | "static";

/**
 * A saved workspace audience summary row, as returned by GET /v1/audiences —
 * the reusable targeting selectors campaigns and email campaigns accept as
 * `audience_id`. The stored `definition` (the `$where` condition tree behind
 * a dynamic audience) is deliberately never exposed through the public API.
 * `last_count` is an advisory size cache stamped when the audience was last
 * counted or snapshotted in-app — never a live resolution (estimate a
 * campaign's real reach with `emailCampaigns.estimate`).
 */
export interface AudienceSummary {
  id: string;
  name: string;
  /** `dynamic` = re-evaluated live at every use; `static` = frozen membership. */
  kind: AudienceKind;
  /** Advisory size cache — may be stale or null (never counted). */
  last_count: number | null;
  /** When `last_count` was stamped. */
  last_counted_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  [key: string]: unknown;
}

/**
 * GET /v1/audiences query params. Pages like deals/payments (default 25,
 * cap 100). An unknown `kind` value 400s.
 */
export interface AudienceListParams {
  kind?: AudienceKind;
  /** Page size (max 100, default 25). */
  limit?: number;
  offset?: number;
}

// ─────────────────────────── Sender profiles ───────────────────────────

/**
 * An email from-identity, as returned by GET /v1/sender-profiles — the
 * selectors email campaigns accept as `sender_profile_id`. `verified` is the
 * send-readiness signal (`true` exactly when the linked sending domain's
 * status is `verified` — the same gate in-app sends assert); DKIM/DNS
 * verification material is never returned. Profiles are managed in-app
 * (Settings → Email).
 */
export interface SenderProfile {
  id: string;
  /** Display name recipients see. */
  from_name: string;
  /** The composed sending address (`local-part@domain`). */
  from_email: string;
  /** Reply-to address, when it differs from `from_email`. */
  reply_to: string | null;
  /** Email delivery backend behind this profile. */
  provider: "smtp" | "ses";
  /** Whether this is the workspace's default sender profile. */
  is_default: boolean;
  sending_domain_id: string;
  /** The sending domain (the part after `@` in `from_email`). */
  domain: string;
  /** The sending domain's verification state. */
  domain_status: "pending" | "verifying" | "verified" | "failed" | "disabled";
  /** `true` exactly when `domain_status` is `verified` — this profile can pass the launch gate. */
  verified: boolean;
  created_at: string | null;
  updated_at: string | null;
  [key: string]: unknown;
}

/**
 * GET /v1/sender-profiles query params. Pages like deals/payments (default
 * 25, cap 100).
 */
export interface SenderProfileListParams {
  /** Page size (max 100, default 25). */
  limit?: number;
  offset?: number;
}

// ─────────────────── Email campaigns & newsletters ───────────────────

export type ContentDirection = "ltr" | "rtl";

export type ContentBlockKind =
  | "heading"
  | "paragraph"
  | "button"
  | "bullets"
  | "spacer"
  | "image"
  | "divider"
  | "snippet";

/**
 * One block of the `blocks` content source. `kind` selects the shape; the
 * other fields apply per kind — an unknown `kind` or a mistyped field returns
 * 400 `invalid_content`. Text fields (`text`, `items` entries, button
 * `label`) may embed `[[…]]` variable tokens.
 *
 * | kind | fields | notes |
 * |---|---|---|
 * | `heading` | `text`, `level` | `level` 1–3 (out of range clamps; omitted → 2). |
 * | `paragraph` | `text` | Empty text drops the block. |
 * | `button` | `label`, `url` | Themed CTA button; non-http(s) URLs are replaced with a safe placeholder. |
 * | `bullets` | `items` | Bullet list. |
 * | `spacer` | — | Fixed vertical spacing. |
 * | `image` | `url`, `alt` | `url` must be absolute https (else 400 `invalid_content`). |
 * | `divider` | — | Horizontal rule. |
 * | `snippet` | `id` **or** `name` | Splices a workspace snippet (no match → 400 `unknown_snippet`). |
 */
export interface ContentBlock {
  kind: ContentBlockKind;
  /** `heading` / `paragraph` text (may embed `[[variable : fallback]]` tokens). */
  text?: string;
  /** `heading` only (1–3). */
  level?: number;
  /** `button` only — the button text. */
  label?: string;
  /** `button` link / `image` source (image URLs must be absolute https). */
  url?: string;
  /** `bullets` only. */
  items?: string[];
  /** `image` only — alt text. */
  alt?: string;
  /** `snippet` only — resolve by snippet UUID. */
  id?: string;
  /** `snippet` only — resolve by case-insensitive exact name. */
  name?: string;
}

/**
 * A CommonMark subset plus two directive lines (each on its own line):
 * `::button[Label](https://url)` → a themed CTA button block, and
 * `::snippet[name-or-uuid]` → splices a workspace snippet (unknown reference
 * → 400 `unknown_snippet`). `[[path : fallback]]` variable tokens become
 * per-recipient personalization pills. Raw HTML never passes through — tags
 * are stripped to their text content with a warning.
 */
export interface MarkdownContentInput {
  direction?: ContentDirection;
  markdown: string;
  blocks?: never;
  design_json?: never;
}

/** A typed block array — each item is one {@link ContentBlock}, rendered in order. */
export interface BlocksContentInput {
  direction?: ContentDirection;
  blocks: ContentBlock[];
  markdown?: never;
  design_json?: never;
}

/**
 * A raw editor document (the native design JSON the in-app email editor
 * submits), passed through after a structural sanity check. Use this to
 * replay a document read back from the API (a GET's `design_json`);
 * authoring from scratch is easier with `markdown` or `blocks`.
 */
export interface DesignJsonContentInput {
  direction?: ContentDirection;
  design_json: Record<string, unknown>;
  markdown?: never;
  blocks?: never;
}

/**
 * The shared authoring contract for email-campaign bodies and newsletter
 * issues: an optional `direction` plus EXACTLY ONE of `markdown` | `blocks` |
 * `design_json` (zero or two-plus sources → 400 `invalid_content`; total
 * content size capped at 512,000 characters). Whichever source is sent
 * compiles immediately — the write response's `compile` envelope reports
 * errors and warnings up front, not at send time.
 */
export type ContentInput =
  | MarkdownContentInput
  | BlocksContentInput
  | DesignJsonContentInput;

/**
 * Present on campaign/issue WRITE responses (create, PATCH, and idempotent
 * replays that updated the record — never on plain GETs; a post-launch
 * campaign replay omits it entirely). `errors` are render problems to fix
 * before sending; `warnings` are lossy-but-accepted conversions (stripped
 * raw HTML, a dropped non-https image, clamped heading levels, an unknown
 * `::directive` kept as text). `ok` is `true` when `errors` is empty; a
 * write with no `content` in the payload reports `ok: true` with empty
 * arrays.
 */
export interface CompileResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** Response of GET /v1/email-campaigns/:id/estimate. */
export interface AudienceEstimate {
  /** Recipients the stored targeting resolves to right now. */
  estimated_recipients: number;
}

/**
 * The API mutates only `draft`/`scheduled` campaigns; everything from the
 * launch claim onward (`sending`, `paused`, `sent`, `failed`, `cancelled`)
 * is system-managed.
 */
export type EmailCampaignStatus =
  | "draft"
  | "scheduled"
  | "sending"
  | "paused"
  | "sent"
  | "failed"
  | "cancelled";

/**
 * Broadcast email campaign as returned by the API. The stored
 * subject/preheader override columns are read AND written under the names
 * `subject`/`preheader`, so a GET → tweak → PATCH round-trip echoes cleanly.
 * List rows omit the content columns (`template_id`, `design_json`,
 * `compiled_html`, `compiled_styles`, `plain_text`) and the in-app-only A/B
 * fields; single reads and write responses include them.
 */
export interface EmailCampaign {
  id: string;
  name: string;
  status: EmailCampaignStatus;
  sender_profile_id: string | null;
  /** May embed `[[…]]` variable tokens, resolved per recipient. */
  subject: string | null;
  preheader: string | null;
  direction: ContentDirection | null;
  /** Preference-center topic — opted-out contacts are excluded at send. */
  topic_key: string | null;
  contact_group_ids: string[] | null;
  audience_id: string | null;
  /** A `$where` condition tree (same grammar as the contacts list filter). */
  audience_filters: Record<string, unknown> | null;
  scheduled_at: string | null;
  timezone: string | null;
  started_at: string | null;
  completed_at: string | null;
  total_recipients: number | null;
  sent_count: number | null;
  delivered_count: number | null;
  open_count: number | null;
  click_count: number | null;
  bounce_count: number | null;
  complaint_count: number | null;
  unsubscribe_count: number | null;
  failed_count: number | null;
  /** Terminal-but-not-failed recipients (suppression/eligibility skips). */
  skipped_count: number | null;
  pending_retry_count: number | null;
  /** Your idempotency reference, unique per workspace. */
  external_reference: string | null;
  created_at: string;
  updated_at: string | null;
  /**
   * In-app template reference — always null for API-authored content; a
   * PATCH with `content` clears it (the patched content is what sends).
   * Single reads/write responses only, omitted on list rows.
   */
  template_id?: string | null;
  /** The stored editor document. Omitted on list rows. */
  design_json?: Record<string, unknown> | null;
  /** Compiled body fragment. Omitted on list rows. */
  compiled_html?: string | null;
  /** Compiled head styles. Omitted on list rows. */
  compiled_styles?: string | null;
  /** Compiled plain-text part. Omitted on list rows. */
  plain_text?: string | null;
  [key: string]: unknown;
}

/**
 * POST /v1/email-campaigns — create a draft campaign (idempotent upsert via
 * `external_reference`). `content` compiles immediately; the campaign starts
 * as `draft` — launch with `send`/`schedule`.
 */
export interface EmailCampaignCreateParams {
  name: string;
  /** May embed `[[…]]` variable tokens. Max 400 chars. */
  subject: string;
  preheader?: string;
  /** Must belong to the workspace (400 `sender_profile_not_found`). */
  sender_profile_id: string;
  /**
   * Idempotency key (max 255 chars). A repeat POST with the same value
   * updates that campaign's fields while it is still draft/scheduled
   * (`duplicate: true`); once the launch claimed it the campaign returns
   * verbatim with nothing mutated (and no `compile` envelope).
   */
  external_reference?: string;
  content: ContentInput;
  /** Saved audience id; wins over `audience_filters`. */
  audience_id?: string;
  /** Ad-hoc `$where` condition tree; validated on write. */
  audience_filters?: Record<string, unknown>;
  /** Additional contact-group targeting (OR semantics), narrowing the audience. */
  contact_group_ids?: string[];
  /** Preference-center topic key — opted-out contacts are excluded. */
  topic_key?: string;
}

/**
 * PATCH /v1/email-campaigns/:id — same field set as create minus
 * `external_reference`; only present fields are touched. Nullable fields
 * clear on an explicit null; a `content` change recompiles (and detaches an
 * in-app template — the patched content is what sends).
 */
export interface EmailCampaignUpdateParams {
  name?: string;
  subject?: string | null;
  preheader?: string | null;
  sender_profile_id?: string;
  content?: ContentInput;
  audience_id?: string | null;
  audience_filters?: Record<string, unknown> | null;
  contact_group_ids?: string[] | null;
  topic_key?: string | null;
}

/**
 * GET /v1/email-campaigns query params. Pages like deals/payments (default
 * 25, cap 100). An unknown `status` value 400s.
 */
export interface EmailCampaignListParams {
  status?: EmailCampaignStatus;
  /** Page size (max 100, default 25). */
  limit?: number;
  offset?: number;
}

/**
 * Response of POST /v1/email-campaigns. Both outcomes return HTTP 201;
 * `duplicate: true` = `external_reference` matched an existing campaign —
 * still-draft/scheduled campaigns had their fields updated, post-launch
 * campaigns return verbatim (and `compile` is then absent, since nothing was
 * recompiled).
 */
export interface EmailCampaignCreateResult extends EmailCampaign {
  duplicate: boolean;
  /** Absent only on a post-launch verbatim replay. */
  compile?: CompileResult;
}

/** Response of PATCH /v1/email-campaigns/:id — the campaign plus the compile envelope. */
export interface EmailCampaignUpdateResult extends EmailCampaign {
  compile: CompileResult;
}

export type NewsletterStatus = "active" | "paused" | "archived";

/**
 * A smart newsletter (a sequence of issues with per-subscriber catch-up).
 * List rows carry the summary fields typed here; a single read additionally
 * returns the full stored configuration (enrollment policy, catch-up
 * cadence, tag auto-subscribe, chrome snippet assignments, public-archive
 * settings) — managed in-app and available via the index signature.
 */
export interface Newsletter {
  id: string;
  name: string;
  description: string | null;
  status: NewsletterStatus;
  /** null = the workspace default profile is used at send time. */
  sender_profile_id: string | null;
  /** Computed — subscriptions currently in `active` status. */
  active_subscriber_count: number;
  created_at: string;
  updated_at: string | null;
  [key: string]: unknown;
}

/**
 * POST /v1/newsletters — a `name` alone suffices; cadence, enrollment policy
 * and archive settings take their in-app defaults. Enforces the plan's
 * newsletter cap (403 `PLAN_LIMIT_EXCEEDED`); a duplicate name throws 409
 * `duplicate_name`.
 */
export interface NewsletterCreateParams {
  /** Unique per workspace, case-insensitive. Max 120 chars. */
  name: string;
  description?: string;
  /** Omit to fall back to the workspace default profile at send time. */
  sender_profile_id?: string;
}

/** GET /v1/newsletters query params (default 25, cap 100). */
export interface NewsletterListParams {
  /** Page size (max 100, default 25). */
  limit?: number;
  offset?: number;
}

export type NewsletterIssueStatus = "draft" | "scheduled" | "published";

/**
 * One issue in a newsletter's sequence. `issue_number` is assigned AT
 * PUBLISH (null on drafts/scheduled issues) — issue #N always means the Nth
 * published issue. List rows omit the content columns (`design_json`,
 * `compiled_html`, `compiled_styles`, `plain_text`); single reads and write
 * responses include them.
 */
export interface NewsletterIssue {
  id: string;
  newsletter_id: string;
  /** Assigned at publish; null until then. */
  issue_number: number | null;
  /** May embed `[[…]]` variable tokens, resolved per recipient. */
  subject: string | null;
  preheader: string | null;
  status: NewsletterIssueStatus;
  scheduled_at: string | null;
  published_at: string | null;
  /** Whether the issue appears in the newsletter's public archive (when enabled). */
  include_in_archive: boolean;
  /** Your idempotency reference, unique per workspace. */
  external_reference: string | null;
  created_at: string;
  updated_at: string | null;
  /** The stored editor document. Omitted on list rows. */
  design_json?: Record<string, unknown> | null;
  /** Compiled body fragment. Omitted on list rows. */
  compiled_html?: string | null;
  /** Compiled head styles. Omitted on list rows. */
  compiled_styles?: string | null;
  /** Compiled plain-text part. Omitted on list rows. */
  plain_text?: string | null;
  [key: string]: unknown;
}

/**
 * POST /v1/newsletters/:id/issues — all fields optional (an issue can start
 * as an empty placeholder), but publishing or scheduling requires a subject
 * and compiled content (409 `issue_missing_content`).
 */
export interface NewsletterIssueCreateParams {
  /** May embed `[[…]]` variable tokens. Max 400 chars. */
  subject?: string;
  preheader?: string;
  /** Default true. */
  include_in_archive?: boolean;
  /**
   * Idempotency key (max 255 chars). A repeat POST with the same value
   * updates the matched issue's content/fields instead of creating a
   * duplicate (`duplicate: true`) — never its `status`, `scheduled_at`, or
   * `issue_number`. One reference maps to one issue per WORKSPACE — a replay
   * under a different newsletter throws 409 `external_reference_in_use`.
   */
  external_reference?: string;
  content?: ContentInput;
}

/**
 * PATCH /v1/newsletter-issues/:id — only present fields are touched.
 * `subject`/`preheader` clear on an explicit null. Published issues stay
 * editable (a content change recompiles); a scheduled issue's content cannot
 * be cleared — unschedule first.
 */
export interface NewsletterIssueUpdateParams {
  subject?: string | null;
  preheader?: string | null;
  include_in_archive?: boolean;
  content?: ContentInput;
}

/**
 * GET /v1/newsletters/:id/issues query params (default 25, cap 100). An
 * unknown `status` value 400s.
 */
export interface NewsletterIssueListParams {
  status?: NewsletterIssueStatus;
  /** Page size (max 100, default 25). */
  limit?: number;
  offset?: number;
}

/**
 * Response of POST /v1/newsletters/:id/issues. Both outcomes return HTTP
 * 201; `duplicate: true` = `external_reference` matched an existing issue,
 * whose content/fields were updated — status, scheduled_at and issue_number
 * are never touched on a replay.
 */
export interface NewsletterIssueCreateResult extends NewsletterIssue {
  duplicate: boolean;
  compile: CompileResult;
}

/** Response of PATCH /v1/newsletter-issues/:id — the issue plus the compile envelope. */
export interface NewsletterIssueUpdateResult extends NewsletterIssue {
  compile: CompileResult;
}

// ─────────────────────────── Templates (WhatsApp) ───────────────────────────

export interface MessageTemplate {
  id: string;
  workspace_id: string;
  name: string;
  display_name: string | null;
  category: string | null;
  language: string | null;
  status: string;
  body_text: string | null;
  created_at: string;
  [key: string]: unknown;
}

/** POST /v1/templates/:id/send */
export interface TemplateSendParams {
  /** Recipient phone number in international format. */
  to: string;
  /** Body variable values, e.g. [{ type: "text", text: "Jane" }]. */
  body_variables?: Array<{ type: string; text: string; param_name?: string }>;
  header_config?: {
    type: "text" | "media";
    variables?: string[];
    media_type?: string;
    media_link?: string;
  };
  button_configs?: Array<{ type: string; index: number; parameters: string[] }>;
}

// ─────────────────────────── Payments ───────────────────────────

export type PaymentType = "one_time" | "recurring" | "installments";
export type PaymentEntryStatus = "pending" | "completed" | "failed" | "refunded";
export type PaymentInterval = "weekly" | "monthly" | "quarterly" | "yearly";
export type PaymentMethod = "cash" | "card" | "bank_transfer" | "other";
/**
 * VAT posture of a recurring plan / payment request: "inclusive" (VAT is
 * included in the amount) or "exclusive" (the amount is net; VAT is added on
 * top — exclusive + rate 0 = VAT-exempt). Always paired with a `vat_rate`.
 */
export type PaymentVatMode = "inclusive" | "exclusive";

/**
 * POST /v1/payments — idempotent upsert via `external_reference` (a repeat
 * POST updates that payment's mutable fields; the type/schedule is never
 * restructured on a match). Contact resolution as in deals.
 */
export interface PaymentCreateParams {
  contact_id?: string;
  phone?: string;
  email?: string;
  name?: string;
  type: PaymentType;
  /** one-time: the amount; recurring: per cycle; installments: total deal. */
  amount: number;
  product_id?: string;
  product_sku?: string;
  product_external_id?: string;
  title?: string;
  note?: string;
  method?: PaymentMethod;
  /** 3-letter code; defaults to the workspace currency. */
  currency?: string;
  /** ISO date; defaults to now. */
  purchase_date?: string;
  /** one-time only; defaults to "completed". */
  status?: PaymentEntryStatus;
  /** recurring only; defaults to "monthly". */
  interval?: PaymentInterval;
  /** recurring only: auto-generate each cycle's payment when due. */
  auto_generate?: boolean;
  /** recurring only: record the first cycle now (default true). */
  record_first_payment?: boolean;
  /** recurring only: ISO 8601 end date. */
  recurring_end_at?: string;
  /** recurring only: max charge cycles (min 1). */
  recurring_max_occurrences?: number;
  /**
   * Recurring only, always together with `vat_rate` (a full pair — a lone
   * leg 400s, and on other types the pair 400s). Omitted → the attached
   * product's pair, else the workspace default. On an `external_reference`
   * match a provided pair re-prices the plan.
   */
  vat_mode?: PaymentVatMode;
  /** Recurring only, with `vat_mode`: VAT percent (0–100, ≤2 decimals). */
  vat_rate?: number;
  /** installments only: number of installments (min 2). */
  installment_count?: number;
  external_reference?: string;
  /**
   * Free-form JSON stored on the payment — max 2048 bytes serialized (400
   * over the cap). On an `external_reference` match the provided object
   * REPLACES the stored one (omit to keep it).
   */
  metadata?: Record<string, unknown>;
}

export interface PaymentUpdateParams {
  product_id?: string | null;
  title?: string;
  note?: string;
  method?: PaymentMethod;
  /** one-time only. */
  amount?: number;
  /** one-time only. */
  status?: PaymentEntryStatus;
  /** recurring only. */
  auto_generate?: boolean;
  recurring_end_at?: string | null;
  recurring_max_occurrences?: number | null;
  /**
   * Recurring only: replace the plan's stored VAT pair — always together
   * with `vat_rate`. Unlike the other type-restricted fields this is NOT
   * silently ignored on other types (400), and lone legs / nulls are
   * rejected. Omit both to keep the stored pair.
   */
  vat_mode?: PaymentVatMode;
  /** Recurring only, with `vat_mode`: VAT percent (0–100, ≤2 decimals). */
  vat_rate?: number;
  /**
   * Replace the payment's metadata object (max 2048 bytes serialized), or
   * `null` to clear it. Omit to leave it as-is.
   */
  metadata?: Record<string, unknown> | null;
}

export interface PaymentListParams {
  type?: PaymentType;
  status?: "active" | "completed" | "cancelled";
  search?: string;
  /** Page size (max 100, default 25). */
  limit?: number;
  offset?: number;
}

export interface PaymentRefundParams {
  /** The charge entry to refund; optional when the payment has one charge. */
  entry_id?: string;
  /** Partial amount; defaults to the full remaining refundable balance. */
  amount?: number;
  note?: string;
}

export interface Payment {
  id: string;
  workspace_id: string;
  contact_id: string;
  type: PaymentType;
  title: string | null;
  amount: number | string;
  currency: string | null;
  status: string;
  external_reference: string | null;
  created_at: string;
  [key: string]: unknown;
}

/**
 * Response of POST /v1/payments. Both outcomes return HTTP 201; `duplicate:
 * true` = `external_reference` matched an existing payment, whose mutable
 * fields were updated — the type/schedule is never restructured on a match.
 */
export interface PaymentCreateResult extends Payment {
  duplicate: boolean;
}

// ─────────────────────────── Payment requests ───────────────────────────

export type PaymentRequestStatus = "pending" | "paid" | "expired" | "cancelled";

/** Currencies accepted by the workspace payment providers. */
export type PaymentRequestCurrency = "ILS" | "USD" | "EUR" | "GBP";

/** Canonical Israeli tax-document taxonomy (payment requests + contact documents). */
export type PaymentDocumentKind =
  | "tax_invoice"
  | "tax_invoice_receipt"
  | "receipt"
  | "receipt_for_invoice"
  | "proforma_invoice"
  | "donation_receipt"
  | "credit_invoice"
  | "credit_invoice_receipt"
  | "credit_receipt"
  | "credit_donation_receipt"
  | "order"
  | "price_quote"
  | "delivery_note"
  | "payment_demand";

/**
 * POST /v1/payment-requests — mint a hosted pay-link through the workspace's
 * own connected payment provider (Cardcom / Sumit).
 *
 * The payer resolves like payments/deals: provide `contact_id`, OR
 * `phone`/`email` (a matching contact is used, or created), OR a `deal_id`
 * alone (the deal's contact pays).
 *
 * **There is NO idempotency key on this resource** — a repeat POST mints a
 * second, independently payable link (cancel extras via
 * `paymentRequests.cancel`). Because of that, the SDK never auto-retries
 * this call on transient network errors.
 */
export interface PaymentRequestCreateParams {
  contact_id?: string;
  phone?: string;
  email?: string;
  /** Used only when a NEW contact is created. */
  name?: string;
  /** Deal to bind the request to; alone, the deal's contact is the payer. */
  deal_id?: string;
  /** Amount to collect, in major units (≤2 decimals, min 0.01). */
  amount: number;
  /** Omitted → the workspace payment currency. */
  currency?: PaymentRequestCurrency;
  /** Payer-facing charge title (≤200 chars). */
  title?: string;
  /** ≤2000 chars. */
  note?: string;
  /** Max card installments offered on the hosted page (1–36). */
  max_installments?: number;
  /** Tax-document kind to auto-issue; omitted → the provider/account default. */
  document_kind?: PaymentDocumentKind;
  /** Auto-issue an Israeli tax document on successful charge (default true). */
  auto_issue_document?: boolean;
  /**
   * Link expiry (ISO 8601). Clamped server-side to at most 72 hours from
   * now (1 hour for test-mode requests); omitted → the maximum.
   */
  expires_at?: string;
  /**
   * Authorise-only test run — 400 when the connected provider has no test
   * mode. Test requests never record real money.
   */
  test_mode?: boolean;
  /** Pre-expiry reminder emails; omitted → the workspace default. */
  reminders_enabled?: boolean;
  /**
   * Offer the payer a save-my-card checkbox on the pay page — honored only
   * when the connected provider supports card capture at checkout.
   */
  offer_card_save?: boolean;
  /**
   * Per-request VAT override — always together with `vat_rate` (a lone leg
   * 400s). Omitted → the workspace payments default.
   */
  vat_mode?: PaymentVatMode;
  /** With `vat_mode`: VAT percent (0–100, ≤2 decimals). */
  vat_rate?: number;
}

/**
 * GET /v1/payment-requests query params. Pages like deals/payments (default
 * 25, cap 100; malformed paging 400s). Unlike deals/payments, an unknown
 * `status` value 400s instead of being silently ignored.
 */
export interface PaymentRequestListParams {
  status?: PaymentRequestStatus;
  contact_id?: string;
  deal_id?: string;
  /** Page size (max 100, default 25). */
  limit?: number;
  offset?: number;
}

/**
 * Payment request (pay-link) as returned by the API. Lifecycle:
 * pending → paid | expired | cancelled. `pay_url` is the shareable hosted
 * pay-page URL (computed on create/get/list; the cancel response is the bare
 * row without computed fields; null on system-created `charge_kind: "token"`
 * saved-card rows, which also can never be cancelled). Once paid,
 * `contact_payment_id` links the settled /v1/payments ledger row and
 * `document` (get/list) carries the issued tax-document pointer. List rows
 * additionally join `contact_name`/`contact_phone`/`contact_email` and a
 * computed `refunded_total`.
 */
export interface PaymentRequest {
  id: string;
  workspace_id: string;
  contact_id: string | null;
  deal_id: string | null;
  provider: string;
  status: PaymentRequestStatus;
  /** "checkout" = hosted pay-link; "token" = internal saved-card charge row. */
  charge_kind: string;
  amount: number;
  currency: string;
  title: string | null;
  note: string | null;
  test_mode: boolean;
  vat_mode: PaymentVatMode | null;
  vat_rate: number | null;
  public_token: string;
  expires_at: string | null;
  paid_at: string | null;
  cancelled_at: string | null;
  /** The /v1/payments ledger row a verified payment landed on (once paid). */
  contact_payment_id: string | null;
  created_at: string;
  updated_at: string;
  /** Computed on create/get/list — absent on the cancel response. */
  pay_url?: string | null;
  /** Computed on get/list: `{provider, id, number, type, url}` once paid. */
  document?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/**
 * Response of POST /v1/payment-requests — the minted row plus checkout
 * diagnostics. On a provider failure at mint time the row is still created
 * (`pending`) with `checkout_error` set, and the link still works — the
 * hosted page lazily re-creates the provider session when opened. The URL to
 * share is always `pay_url`.
 */
export interface PaymentRequestCreateResult extends PaymentRequest {
  checkout_url: string | null;
  checkout_error: string | null;
}

// ─────────────────────────── Contact documents ───────────────────────────

/** GET /v1/contacts/:id/documents options. */
export interface ContactDocumentsOptions {
  /**
   * Default false (stored pointers only). True additionally queries the
   * connected payment provider for a live document listing and merges it in
   * (bounded ~2.5 s; failures degrade to the stored listing — see
   * `live.error` on the result).
   */
  live?: boolean;
}

export type ContactDocumentOrigin = "stored" | "live" | "merged";

/** One record a contact document was aggregated from. */
export type ContactDocumentSource =
  | { type: "contact_payment"; id: string }
  | { type: "payment_entry"; id: string; paymentId: string }
  | { type: "payment_request"; id: string }
  | { type: "provider"; provider: string };

/** One aggregated financial document (invoice / receipt / credit document). */
export interface ContactDocument {
  /** Aggregator-computed stable render key; carries no semantics. */
  key: string;
  /** Canonical kind when resolvable; else null with `rawType` set. */
  kind: PaymentDocumentKind | null;
  rawType: string | null;
  isCredit: boolean;
  provider: string | null;
  documentId: string | null;
  /** Human-facing document number. */
  number: string | null;
  /** MAY be null (legacy number-only rows) — check before opening. */
  url: string | null;
  /** ISO 8601 UTC. Stored: host-row instant; live: provider document date. */
  date: string | null;
  amount: number | null;
  currency: string | null;
  origin: ContactDocumentOrigin;
  sources: ContactDocumentSource[];
}

/**
 * Response of GET /v1/contacts/:id/documents. `documents` is sorted
 * date-descending (nulls last). `live` reports the opt-in provider lookup:
 * `attempted` (a lookup ran), `ok` (false = it failed/timed out), `complete`
 * (false = the live listing may be missing documents), and `error`.
 */
export interface ContactDocumentsResult {
  documents: ContactDocument[];
  live: {
    attempted: boolean;
    ok: boolean;
    complete: boolean;
    error: "timeout" | "provider_error" | null;
  };
}

// ─────────────────────────── Orders ───────────────────────────

export type OrderFinancialStatus =
  | "pending"
  | "paid"
  | "partially_paid"
  | "refunded"
  | "partially_refunded"
  | "voided";

/**
 * Read-only via the API — fulfillment is recorded in oToK (or by a
 * connected store); no /v1 route sets it.
 */
export type OrderFulfillmentStatus =
  | "unfulfilled"
  | "partially_fulfilled"
  | "fulfilled";

/**
 * A line item on POST /v1/orders (max 200 per order).
 *
 * Attach a catalog product with `product_id` (strict — unresolvable → 400
 * `INVALID_PRODUCT`) or `product_sku` / `product_external_id` (tolerant —
 * no match keeps the literal `title` with no product link); an inactive
 * product always rejects (400 `PRODUCT_INACTIVE`). Resolution order:
 * `product_id` → `product_sku` → `product_external_id`. When a product
 * resolves, the line title derives from the product name (a client `title`
 * is ignored); with no product, `title` is required (400 otherwise). The
 * per-line `line_total` is server-computed:
 * round2(quantity × unit_price × (1 − discount_percent/100)).
 */
export interface OrderItemParams {
  product_id?: string;
  product_sku?: string;
  product_external_id?: string;
  /** Required unless a product resolves (then derived from the product name). */
  title?: string;
  /** Denormalized SKU snapshot on the line (falls back to `product_sku`). */
  sku?: string;
  /**
   * In the order currency. Omitted with a priced product → the product's
   * price; omitted with a product that has no catalog price → 400
   * `ORDER_ITEM_PRICE_REQUIRED`; omitted with no product → 0.
   */
  unit_price?: number;
  /** Positive; decimals allowed (weight/hours). Default 1. */
  quantity?: number;
  /** Percent-only per-line discount, 0–100. */
  discount_percent?: number;
}

/**
 * POST /v1/orders — create an order (idempotent upsert via
 * `external_reference`).
 *
 * Contact resolution as in deals/payments: provide `contact_id` OR
 * `phone`/`email` (a matching contact is used, or created — `name` applies
 * only on create). A phone and an email resolving to two different contacts
 * throws 409 `CONTACT_MERGE_REQUIRED`.
 *
 * A repeat POST with the same `external_reference` UPDATES that order
 * instead of creating a duplicate: `note` / `coupon_codes` / `placed_at` /
 * `deal_id` always apply; the money fields (`items`, `currency`,
 * `discount_total`, `shipping_total`, `tax_total`) apply only while the
 * order is still `pending` — once paid, money is locked and corrections
 * flow through refunds/cancel; `financial_status` and the order's contact
 * never change on a match. Unlike the other create endpoints the response
 * carries NO top-level `duplicate` flag — see {@link Order}.
 */
export interface OrderCreateParams {
  contact_id?: string;
  phone?: string;
  email?: string;
  /** Used only when a NEW contact is created. */
  name?: string;
  /** Max 200 items. */
  items?: OrderItemParams[];
  /** 3-letter code, uppercased; defaults to the workspace currency. */
  currency?: string;
  /** Document-level discount (≥ 0). */
  discount_total?: number;
  shipping_total?: number;
  tax_total?: number;
  /**
   * `pending` (default) or `paid` — a paid create records the payment and
   * fires order-paid automations. Never applied on an `external_reference`
   * match.
   */
  financial_status?: "pending" | "paid";
  /** ISO 8601; defaults to now. */
  placed_at?: string;
  /** Applied discount/coupon codes (max 50). */
  coupon_codes?: string[];
  /** Max 5000 chars. */
  note?: string;
  /**
   * Link a deal of the SAME contact (404 `ORDER_DEAL_NOT_FOUND` when
   * unknown, 409 `ORDER_DEAL_CONTACT_MISMATCH` for another contact's).
   */
  deal_id?: string;
  /** Idempotency key — one reference maps to one order. Max 255 chars. */
  external_reference?: string;
}

/**
 * POST /v1/orders/:id/refunds — record a refund.
 *
 * `external_refund_id` is the idempotency key: a repeat POST with the same
 * value applies nothing and answers `duplicate: true`. WITHOUT it refunds
 * are NOT idempotent — every POST appends a new refund — so supply it
 * whenever your system can retry.
 */
export interface OrderRefundParams {
  /**
   * Positive, in the order's currency; must not exceed the remaining total
   * (`total` − `refunded_total`).
   */
  amount: number;
  /** Idempotency key per order (max 255 chars). */
  external_refund_id?: string;
  /** Max 1000 chars. */
  reason?: string;
  /** ISO 8601; defaults to now. */
  refunded_at?: string;
}

/** POST /v1/orders/:id/mark-paid (all fields optional). */
export interface OrderMarkPaidParams {
  /**
   * The `external_reference` of an EXISTING payment (e.g. one your system
   * already recorded via POST /v1/payments) to link the order onto instead
   * of recording a new payment. Link-only — the payment's amount is never
   * rewritten. Max 255 chars.
   */
  payment_reference?: string;
}

/**
 * GET /v1/orders query params (no `search` on this route). Ordering is
 * `placed_at` descending.
 */
export interface OrderListParams {
  /** Financial status; unknown values are silently ignored (unfiltered). */
  status?: OrderFinancialStatus;
  contact_id?: string;
  /**
   * Exact match — `manual`, `api`, `automation` (store platform values are
   * reserved for orders synced from a connected store).
   */
  source?: string;
  /** Matches orders synced from that connected store. */
  store_connection_id?: string;
  /** Exact-match lookup by idempotency reference. */
  external_reference?: string;
  /** Orders placed at/after (ISO 8601). */
  placed_from?: string;
  /** Orders placed at/before (ISO 8601). */
  placed_to?: string;
  /**
   * Page size (max 100, default 25). Out-of-range values are clamped
   * server-side rather than rejected.
   */
  limit?: number;
  offset?: number;
}

/**
 * Order line item (`items[]` on detail/write responses, ordered by
 * `position`).
 */
export interface OrderItem {
  id: string;
  workspace_id: string;
  order_id: string;
  /** 0-based. */
  position: number;
  /** Soft catalog link — null when no product resolved. */
  product_id: string | null;
  /** Store-side product id — null for API-created lines. */
  external_product_id: string | null;
  title: string;
  sku: string | null;
  /** Decimal quantities allowed (weight/hours). */
  quantity: number;
  unit_price: number;
  /** Percent-only per-line discount, 0–100. */
  discount_percent: number | null;
  /** Server-computed: round2(quantity × unit_price × (1 − discount%/100)). */
  line_total: number;
  created_at: string;
  [key: string]: unknown;
}

/**
 * Recorded refund (`refunds[]` on detail/write responses, ordered by
 * `refunded_at` ascending).
 */
export interface OrderRefund {
  id: string;
  workspace_id: string;
  order_id: string;
  /** Caller idempotency key; null for keyless refunds. */
  external_refund_id: string | null;
  /** Positive, in the order's currency. */
  amount: number;
  currency: string;
  reason: string | null;
  /** Defaults to record time. */
  refunded_at: string;
  created_at: string;
  [key: string]: unknown;
}

/**
 * Order record as returned by the API. Money fields (`total`, `subtotal`,
 * `discount_total`, `shipping_total`, `tax_total`, `refunded_total`, line
 * `unit_price`/`line_total`, refund `amount`) are JSON numbers in the
 * order's currency. List rows omit `items`/`refunds`; the detail read and
 * every write response include them (plus the joined contact identity).
 * Store-sync provenance fields (`store_connection_id`, `store_domain`,
 * `external_order_id`, `number`, `external_updated_at`) are populated for
 * orders synced from a connected store and are `null` otherwise.
 *
 * Unlike the other create endpoints, POST /v1/orders responses carry NO
 * top-level `duplicate` flag — create and upsert-match both return 201 with
 * the same full-order body. To distinguish, compare `created_at` or
 * pre-check with `GET /v1/orders?external_reference=…`.
 */
export interface Order {
  id: string;
  workspace_id: string;
  /** The order's contact (required, always set). */
  contact_id: string;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  /** Internal per-workspace sequential number, assigned at create. */
  order_number: number;
  /** Store-side display number (e.g. "#1001") — null for API/app orders. */
  number: string | null;
  /** Origin: "api", "manual", "automation" (store platform names reserved). */
  platform: string;
  /** Same vocabulary as `platform` for non-store orders. */
  source: string;
  store_connection_id: string | null;
  store_domain: string | null;
  external_order_id: string | null;
  /** Your idempotency key, unique per workspace. */
  external_reference: string | null;
  /** Optional link to a deal of the same contact. */
  deal_id: string | null;
  financial_status: OrderFinancialStatus;
  fulfillment_status: OrderFulfillmentStatus;
  /** 3-letter uppercase; defaults to the workspace currency. */
  currency: string;
  total: number;
  subtotal: number;
  discount_total: number;
  shipping_total: number;
  tax_total: number;
  /** Rollup of the refund ledger. */
  refunded_total: number;
  /** Quantity sum rounded to the nearest integer. */
  item_count: number;
  first_item_name: string | null;
  coupon_codes: string[];
  /** Order time (defaults to creation time). */
  placed_at: string;
  /** Stamped on first entry into a paid state; kept through refund states. */
  paid_at: string | null;
  /** The cancellation stamp — cancellation is NOT a financial status. */
  cancelled_at: string | null;
  /** Last refund instant. */
  refunded_at: string | null;
  external_updated_at: string | null;
  /** Reference of the recorded payment backing this order. */
  payment_reference: string | null;
  /** Payment-recording convergence stamp (informational). */
  payment_synced_at: string | null;
  note: string | null;
  /** Read-only via the API — not settable on any /v1 route. */
  metadata: Record<string, unknown> | null;
  /** Null for API writes. */
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /** Detail/write responses only, ordered by `position`. */
  items?: OrderItem[];
  /** Detail/write responses only, ordered by `refunded_at` ascending. */
  refunds?: OrderRefund[];
  [key: string]: unknown;
}

/**
 * Response of POST /v1/orders/:id/refunds (201 either way).
 *
 * `duplicate: true` = the `external_refund_id` was already recorded on this
 * order; nothing was applied and the current order state is returned.
 */
export interface OrderRefundResult {
  duplicate: boolean;
  order: Order;
}

// ─────────────────────────── Bookings ───────────────────────────

export type BookingStatus = "confirmed" | "cancelled" | "completed" | "no_show";

export interface BookingInvitee {
  name: string;
  email: string;
  phone?: string;
}

/**
 * POST /v1/bookings — provide EITHER `contact_id` OR an `invitee` object
 * (upserted into contacts by phone/email). A taken slot returns
 * 409 SLOT_TAKEN.
 */
export interface BookingCreateParams {
  meeting_type_id: string;
  /** Slot start, ISO-8601 instant. Must be an open slot. */
  start_at: string;
  /** Invitee's IANA time zone. */
  timezone: string;
  contact_id?: string;
  invitee?: BookingInvitee;
  notes?: string;
  /** Round-robin types only: pin the booking to this pool host. */
  host_user_id?: string;
}

export interface BookingListParams {
  status?: BookingStatus;
  meeting_type_id?: string;
  /** Only bookings with start_at >= from (ISO 8601). */
  from?: string;
  /** Only bookings with start_at <= to (ISO 8601). */
  to?: string;
  /** Default: -start_at. */
  sort?: string;
  /** Page size (max 500, default 50). */
  limit?: number;
  offset?: number;
}

export interface BookingRescheduleParams {
  start_at: string;
  timezone?: string;
}

export interface BookingReassignParams {
  /** Target host; omit to auto-pick via round-robin (excluding current host). */
  user_id?: string;
  reason?: string;
  /** Overrides HOST_UNAVAILABLE only; never bypasses the double-booking guard. */
  force?: boolean;
}

export interface Booking {
  id: string;
  workspace_id: string;
  meeting_type_id: string;
  contact_id: string | null;
  status: BookingStatus;
  start_at: string;
  created_at: string;
  [key: string]: unknown;
}

/**
 * Response of POST /v1/bookings. Both outcomes return HTTP 201; `duplicate:
 * true` = a double-submit of the same slot/invitee returned the original
 * booking instead of creating a second one.
 */
export interface BookingCreateResult extends Booking {
  duplicate: boolean;
}

export interface MeetingType {
  id: string;
  workspace_id: string;
  name: string;
  created_at: string;
  [key: string]: unknown;
}

export interface SlotsParams {
  /** ISO 8601 range start. */
  from: string;
  /** ISO 8601 range end (exclusive). Range may not exceed 62 days. */
  to: string;
}

/**
 * Response of GET /v1/meeting-types/:id/embed — everything needed to put the
 * booking calendar on your own website.
 *
 * `embed_key` is the workspace's **publishable** embed key (`bk_…`) — safe to
 * ship in page HTML by design, and NOT the secret API key. Rotation, the
 * origin allowlist, and the embed on/off switch live in the oToK app under
 * Settings → Booking. Bookings made through the embed carry
 * `source: "embed"`.
 */
export interface MeetingTypeEmbed {
  /** The workspace's public ref used in hosted booking URLs. */
  workspace_ref: string;
  /** The meeting type's slug. */
  slug: string;
  /** Publishable workspace embed key (`bk_…`) — NOT the secret API key. */
  embed_key: string;
  /** The hosted booking page URL for this meeting type. */
  page_url: string;
  /** Ready-to-paste two-line HTML embed snippet. */
  snippet_html: string;
}
