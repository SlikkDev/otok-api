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

/** Any event type registrable on a webhook endpoint. */
export type WebhookEventType = EmailWebhookEventType | OrderWebhookEventType;

/**
 * POST /v1/webhook-endpoints (max 3 per workspace).
 * `events` defaults to the three delivery events (`email.delivered`,
 * `email.bounced`, `email.complained`); the engagement types
 * (`email.opened`, `email.clicked`) and the `order.*` lifecycle events must
 * be listed explicitly. An empty array is rejected. `email.failed` is
 * deprecated — accepted when listed, never delivered.
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
  | OrderFulfilledEvent;

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
  /** installments only: number of installments (min 2). */
  installment_count?: number;
  external_reference?: string;
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
