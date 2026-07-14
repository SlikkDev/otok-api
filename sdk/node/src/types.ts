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
 * filters, e.g. `{ lifecycle_stage: "lead" }`.
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
 * POST /v1/webhook-endpoints (max 3 per workspace).
 * `events` defaults to the four delivery events; the engagement types
 * (`email.opened`, `email.clicked`) must be listed explicitly. An empty
 * array is rejected.
 */
export interface WebhookEndpointCreateParams {
  url: string;
  events?: EmailWebhookEventType[];
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: EmailWebhookEventType[];
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

export type OtokWebhookEvent =
  | EmailDeliveredEvent
  | EmailBouncedEvent
  | EmailComplainedEvent
  | EmailFailedEvent
  | EmailOpenedEvent
  | EmailClickedEvent;

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
