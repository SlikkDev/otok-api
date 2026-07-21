import type { HttpClient, QueryValue } from "./http";
import type {
  AudienceEstimate,
  AudienceListParams,
  AudienceSummary,
  Booking,
  BookingCreateParams,
  BookingCreateResult,
  BookingListParams,
  BookingReassignParams,
  BookingRescheduleParams,
  Campaign,
  CampaignCreateParams,
  CampaignExecuteResult,
  CampaignUpdateParams,
  ConsentChannel,
  Contact,
  ContactConsent,
  ContactConsentChannel,
  ContactDocumentsOptions,
  ContactDocumentsResult,
  ContactGroup,
  ContactGroupCreateParams,
  ContactGroupUpdateParams,
  ContactUpsertParams,
  ContactUpsertResult,
  Deal,
  DealCreateParams,
  DealCreateResult,
  DealListParams,
  DealMoveStageParams,
  DealSetStatusParams,
  DealUpdateParams,
  EmailCampaign,
  EmailCampaignCreateParams,
  EmailCampaignCreateResult,
  EmailCampaignListParams,
  EmailCampaignUpdateParams,
  EmailCampaignUpdateResult,
  EmailSendParams,
  EmailSendResult,
  ListParams,
  MeetingType,
  MeetingTypeEmbed,
  MessageTemplate,
  Newsletter,
  NewsletterCreateParams,
  NewsletterIssue,
  NewsletterIssueCreateParams,
  NewsletterIssueCreateResult,
  NewsletterIssueListParams,
  NewsletterIssueUpdateParams,
  NewsletterIssueUpdateResult,
  NewsletterListParams,
  Note,
  NoteUpdateParams,
  Order,
  OrderCreateParams,
  OrderListParams,
  OrderMarkPaidParams,
  OrderRefundParams,
  OrderRefundResult,
  Paginated,
  Payment,
  PaymentCreateParams,
  PaymentCreateResult,
  PaymentEntryStatus,
  PaymentListParams,
  PaymentRefundParams,
  PaymentRequest,
  PaymentRequestCreateParams,
  PaymentRequestCreateResult,
  PaymentRequestListParams,
  PaymentUpdateParams,
  Pipeline,
  Product,
  ProductCreateParams,
  ProductListParams,
  ProductUpdateParams,
  ProductUpsertResult,
  SenderProfile,
  SenderProfileListParams,
  SetConsentParams,
  SlotsParams,
  Suppression,
  SuppressionCreateParams,
  SuppressionCreateResult,
  SuppressionListParams,
  Tag,
  TagCreateParams,
  TagUpdateParams,
  TemplateSendParams,
  WebhookEndpoint,
  WebhookEndpointCreateParams,
  WebhookEndpointCreated,
} from "./types";

/** Serialize the shared list params (filter is sent as a JSON string). */
function listQuery(params: ListParams = {}): Record<string, QueryValue> {
  return {
    filter: params.filter ? JSON.stringify(params.filter) : undefined,
    sort: params.sort,
    limit: params.limit,
    offset: params.offset,
    search: params.search,
  };
}

/** Documented `limit` cap for standard list endpoints (default 50). */
const STANDARD_PAGE_CAP = 500;
/**
 * Documented `limit` cap for GET /v1/deals, /v1/payments and /v1/orders
 * (default 25).
 */
const DEALS_PAYMENTS_PAGE_CAP = 100;

/**
 * Auto-paginate a `{ data, total, limit, offset }` list endpoint, yielding
 * rows one by one until `total` is exhausted.
 *
 * Pages are requested at the endpoint's documented `limit` cap unless the
 * caller passed a smaller `limit` (a larger one is clamped to the cap —
 * matching the server, which never returns more than the cap per page). A
 * caller `offset` sets the starting position.
 */
async function* paginate<T>(
  fetchPage: (limit: number, offset: number) => Promise<Paginated<T>>,
  cap: number,
  limit?: number,
  offset?: number,
): AsyncGenerator<T, void, undefined> {
  const pageSize = Math.min(limit ?? cap, cap);
  let cursor = offset ?? 0;
  for (;;) {
    const page = await fetchPage(pageSize, cursor);
    for (const item of page.data) yield item;
    cursor += page.data.length;
    if (page.data.length === 0 || cursor >= page.total) return;
  }
}

// ─────────────────────────────── Contacts ───────────────────────────────

export class ContactsApi {
  constructor(private readonly http: HttpClient) {}

  list(params?: ListParams): Promise<Paginated<Contact>> {
    return this.http.request("GET", "/v1/contacts", { query: listQuery(params) });
  }

  /**
   * Iterate every matching contact, auto-paginating GET /v1/contacts
   * (`limit` cap 500). Accepts the same params as `list`.
   */
  iter(params: ListParams = {}): AsyncGenerator<Contact, void, undefined> {
    return paginate(
      (limit, offset) => this.list({ ...params, limit, offset }),
      STANDARD_PAGE_CAP,
      params.limit,
      params.offset,
    );
  }

  get(id: string): Promise<Contact> {
    return this.http.request("GET", `/v1/contacts/${id}`);
  }

  /**
   * Create OR update (upsert) a contact. Matches by phone (canonicalized to
   * E.164), falling back to email. `tags`/`groups` are ADDED on upsert.
   * Both outcomes return 201 — `duplicate` on the result is `true` when an
   * existing contact was matched and updated.
   */
  upsert(params: ContactUpsertParams): Promise<ContactUpsertResult> {
    return this.http.request("POST", "/v1/contacts", { body: params });
  }

  /**
   * Update by id (404 when unknown). `tags`/`groups` REPLACE the full set.
   *
   * Setting `phone`/`email` to an identifier another contact holds (or
   * previously held) throws 409 `CONTACT_MERGE_REQUIRED` and the write is
   * NOT applied — a merge request is parked for review in oToK instead. Its
   * id is on the error body (`merge_request_id`), and non-identity fields
   * from the same call are applied when the request is resolved.
   */
  update(id: string, params: ContactUpsertParams): Promise<Contact> {
    return this.http.request("PATCH", `/v1/contacts/${id}`, { body: params });
  }

  // ── Documents ──

  /**
   * List the contact's financial documents (invoices, receipts, credit
   * documents), aggregated from the stored document pointers on its
   * payments, payment entries, and payment requests — sorted
   * date-descending. Requires the Payments plan feature (403
   * `FEATURE_NOT_INCLUDED_IN_PLAN` otherwise); 404s exactly like
   * `contacts.get` for an unknown contact.
   *
   * Pass `{ live: true }` to additionally query the connected payment
   * provider and merge its live listing in (bounded ~2.5 s; failures
   * degrade to the stored listing — check `result.live`). Default is
   * stored-only. A document's `url` may be null — check before opening.
   */
  listDocuments(
    contactId: string,
    options: ContactDocumentsOptions = {},
  ): Promise<ContactDocumentsResult> {
    return this.http.request("GET", `/v1/contacts/${contactId}/documents`, {
      query: { live: options.live },
    });
  }

  // ── Consent ──

  /**
   * Get the contact's per-channel marketing consent — both channels at
   * once. A channel without a stored decision reads
   * `consent_state`/`deliverability` "unknown" — treat unknown as not
   * sendable. The email channel additionally carries the composed send-time
   * `suppressed` verdict (suppression list + blacklist + deliverability),
   * which is independent of the consent decision.
   */
  getConsent(contactId: string): Promise<ContactConsent> {
    return this.http.request("GET", `/v1/contacts/${contactId}/consent`);
  }

  /**
   * Record a subscribed/unsubscribed decision on one channel, with its
   * provenance (evidence trail included) — the same path every in-app
   * consent change takes. "unknown" is a system state and cannot be set;
   * `deliverability` is provider-owned and not writable. Subscribing a
   * channel with a spam complaint on record throws 409
   * `consent_sticky_complained`. Returns the resulting channel object in
   * the same shape `getConsent` uses.
   */
  setConsent(
    contactId: string,
    channel: ConsentChannel,
    params: SetConsentParams,
  ): Promise<ContactConsentChannel> {
    return this.http.request(
      "PUT",
      `/v1/contacts/${contactId}/consent/${channel}`,
      { body: params },
    );
  }

  // ── Notes ──

  /**
   * All the contact's notes (pinned first, then newest-first) — the
   * endpoint is unpaginated.
   */
  listNotes(contactId: string): Promise<Note[]> {
    return this.http.request("GET", `/v1/contacts/${contactId}/notes`);
  }

  /** Add a plain-text note (≤5000 chars) to a contact. */
  createNote(
    contactId: string,
    body: string,
    options: { pinned?: boolean } = {},
  ): Promise<Note> {
    const payload: Record<string, unknown> = { body };
    if (options.pinned !== undefined) payload.pinned = options.pinned;
    return this.http.request("POST", `/v1/contacts/${contactId}/notes`, {
      body: payload,
    });
  }

  /**
   * Edit a note's body and/or pin/unpin it. Sending neither returns the
   * note unchanged.
   */
  updateNote(noteId: string, params: NoteUpdateParams): Promise<Note> {
    return this.http.request("PATCH", `/v1/notes/${noteId}`, { body: params });
  }

  /** Delete a note. Returns `{ success: true }`. */
  deleteNote(noteId: string): Promise<{ success: boolean }> {
    return this.http.request("DELETE", `/v1/notes/${noteId}`);
  }
}

// ─────────────────────────────── Tags ───────────────────────────────

export class TagsApi {
  constructor(private readonly http: HttpClient) {}

  list(params?: ListParams): Promise<Paginated<Tag>> {
    return this.http.request("GET", "/v1/tags", { query: listQuery(params) });
  }

  /**
   * Iterate every matching tag, auto-paginating GET /v1/tags (`limit` cap
   * 500). Accepts the same params as `list`.
   */
  iter(params: ListParams = {}): AsyncGenerator<Tag, void, undefined> {
    return paginate(
      (limit, offset) => this.list({ ...params, limit, offset }),
      STANDARD_PAGE_CAP,
      params.limit,
      params.offset,
    );
  }

  get(id: string): Promise<Tag> {
    return this.http.request("GET", `/v1/tags/${id}`);
  }

  /** A name that already exists in the workspace (case-insensitive) throws 409. */
  create(params: TagCreateParams): Promise<Tag> {
    return this.http.request("POST", "/v1/tags", { body: params });
  }

  /** Renaming to a name that already exists (case-insensitive) throws 409. */
  update(id: string, params: TagUpdateParams): Promise<Tag> {
    return this.http.request("PATCH", `/v1/tags/${id}`, { body: params });
  }
}

// ─────────────────────────── Contact groups ───────────────────────────

export class ContactGroupsApi {
  constructor(private readonly http: HttpClient) {}

  list(params?: ListParams): Promise<Paginated<ContactGroup>> {
    return this.http.request("GET", "/v1/contact-groups", {
      query: listQuery(params),
    });
  }

  /**
   * Iterate every matching group, auto-paginating GET /v1/contact-groups
   * (`limit` cap 500). Accepts the same params as `list`.
   */
  iter(params: ListParams = {}): AsyncGenerator<ContactGroup, void, undefined> {
    return paginate(
      (limit, offset) => this.list({ ...params, limit, offset }),
      STANDARD_PAGE_CAP,
      params.limit,
      params.offset,
    );
  }

  get(id: string): Promise<ContactGroup> {
    return this.http.request("GET", `/v1/contact-groups/${id}`);
  }

  /** A name that already exists in the workspace (case-insensitive) throws 409. */
  create(params: ContactGroupCreateParams): Promise<ContactGroup> {
    return this.http.request("POST", "/v1/contact-groups", { body: params });
  }

  /** Renaming to a name that already exists (case-insensitive) throws 409. */
  update(id: string, params: ContactGroupUpdateParams): Promise<ContactGroup> {
    return this.http.request("PATCH", `/v1/contact-groups/${id}`, {
      body: params,
    });
  }
}

// ─────────────────────────── Pipelines / deals ───────────────────────────

/**
 * Requires the Deals feature on the workspace's plan — every route throws
 * 403 `FEATURE_NOT_INCLUDED_IN_PLAN` otherwise.
 */
export class PipelinesApi {
  constructor(private readonly http: HttpClient) {}

  /** List pipelines, each with its ordered stages. */
  list(): Promise<Pipeline[]> {
    return this.http.request("GET", "/v1/pipelines");
  }
}

/**
 * Requires the Deals feature on the workspace's plan — every route throws
 * 403 `FEATURE_NOT_INCLUDED_IN_PLAN` otherwise.
 */
export class DealsApi {
  constructor(private readonly http: HttpClient) {}

  list(params: DealListParams = {}): Promise<Paginated<Deal>> {
    return this.http.request("GET", "/v1/deals", {
      query: { ...params },
    });
  }

  /**
   * Iterate every matching deal, auto-paginating GET /v1/deals (`limit`
   * cap 100 — deals paginate differently from the standard lists). Accepts
   * the same params as `list`.
   */
  iter(params: DealListParams = {}): AsyncGenerator<Deal, void, undefined> {
    return paginate(
      (limit, offset) => this.list({ ...params, limit, offset }),
      DEALS_PAYMENTS_PAGE_CAP,
      params.limit,
      params.offset,
    );
  }

  get(id: string): Promise<Deal> {
    return this.http.request("GET", `/v1/deals/${id}`);
  }

  /**
   * Create a deal. Idempotent when `external_reference` is set: a repeat POST
   * with the same reference updates that deal instead of creating a duplicate
   * — the result then carries `duplicate: true` (status is never changed on
   * a match).
   */
  create(params: DealCreateParams): Promise<DealCreateResult> {
    return this.http.request("POST", "/v1/deals", { body: params });
  }

  update(id: string, params: DealUpdateParams): Promise<Deal> {
    return this.http.request("PATCH", `/v1/deals/${id}`, { body: params });
  }

  /** Move a deal to a stage (cross-pipeline moves are handled). */
  moveStage(id: string, params: DealMoveStageParams): Promise<Deal> {
    return this.http.request("POST", `/v1/deals/${id}/stage`, { body: params });
  }

  /** Mark a deal won/lost, or reopen it with status "open". */
  setStatus(id: string, params: DealSetStatusParams): Promise<Deal> {
    return this.http.request("POST", `/v1/deals/${id}/status`, { body: params });
  }
}

// ─────────────────────────── Products ───────────────────────────

/**
 * The workspace product catalog shared by deals and customer payments.
 * Ungated (plan-wide API access only). There is deliberately no delete —
 * deactivate with `update(id, { is_active: false })` so existing
 * deals/payments keep resolving their attached product.
 */
export class ProductsApi {
  constructor(private readonly http: HttpClient) {}

  list(params: ProductListParams = {}): Promise<Paginated<Product>> {
    return this.http.request("GET", "/v1/products", { query: { ...params } });
  }

  /**
   * Iterate every matching product, auto-paginating GET /v1/products
   * (`limit` cap 500). Accepts the same params as `list`.
   */
  iter(params: ProductListParams = {}): AsyncGenerator<Product, void, undefined> {
    return paginate(
      (limit, offset) => this.list({ ...params, limit, offset }),
      STANDARD_PAGE_CAP,
      params.limit,
      params.offset,
    );
  }

  get(id: string): Promise<Product> {
    return this.http.request("GET", `/v1/products/${id}`);
  }

  /**
   * Create a product. Idempotent when `external_id` is set: a repeat POST
   * with the same value updates that product instead of creating a
   * duplicate — the result then carries `duplicate: true`. A `sku`/
   * `external_id` clash with a DIFFERENT product throws 409
   * `product_conflict`; `vat_mode` + `vat_rate` travel as one
   * both-or-neither pair (400 when only one leg is sent).
   */
  create(params: ProductCreateParams): Promise<ProductUpsertResult> {
    return this.http.request("POST", "/v1/products", { body: params });
  }

  /**
   * Partial update — only the fields you send change. Deactivate with
   * `{ is_active: false }` (there is no DELETE).
   */
  update(id: string, params: ProductUpdateParams): Promise<Product> {
    return this.http.request("PATCH", `/v1/products/${id}`, { body: params });
  }
}

// ─────────────────────────── Suppressions ───────────────────────────

/**
 * The workspace's email suppression list — a send-time overlay deliberately
 * separate from consent: adding a row does NOT change any contact's consent
 * state, and removing one resubscribes no one; every email send checks both.
 *
 * Requires the Email marketing feature (`email_marketing`) on the
 * workspace's plan — every route throws 403 `FEATURE_NOT_INCLUDED_IN_PLAN`
 * otherwise.
 */
export class SuppressionsApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * List the workspace's suppression rows, newest first. Workspace-scoped
   * rows only — the HQ-managed global list is enforced at send time but is
   * never returned here.
   */
  list(params: SuppressionListParams = {}): Promise<Paginated<Suppression>> {
    return this.http.request("GET", "/v1/suppressions", {
      query: { ...params },
    });
  }

  /**
   * Iterate every matching suppression, auto-paginating GET
   * /v1/suppressions (`limit` cap 500). Accepts the same params as `list`.
   */
  iter(
    params: SuppressionListParams = {},
  ): AsyncGenerator<Suppression, void, undefined> {
    return paginate(
      (limit, offset) => this.list({ ...params, limit, offset }),
      STANDARD_PAGE_CAP,
      params.limit,
      params.offset,
    );
  }

  /**
   * Suppress an email address (idempotent): re-adding an already-suppressed
   * address returns the existing row with `duplicate: true` — 201 either
   * way. Adding a suppression does NOT change the contact's consent state.
   */
  create(params: SuppressionCreateParams): Promise<SuppressionCreateResult> {
    return this.http.request("POST", "/v1/suppressions", { body: params });
  }

  /**
   * Remove a suppression (204). Lifts this workspace's suppression only —
   * it does NOT resubscribe anyone, and HQ-managed global rows cannot be
   * removed (404 `suppression_not_found`).
   */
  async delete(id: string): Promise<void> {
    await this.http.request("DELETE", `/v1/suppressions/${id}`);
  }
}

// ─────────────────────────── Transactional email ───────────────────────────

export class EmailsApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * Send a transactional email. `idempotency_key` is required — a repeat call
   * with the same key returns the original send (`duplicate: true`) and never
   * sends twice, so this is safe to retry.
   */
  send(params: EmailSendParams): Promise<EmailSendResult> {
    return this.http.request("POST", "/v1/emails", { body: params });
  }
}

// ─────────────────────────── Webhook endpoints ───────────────────────────

export class WebhookEndpointsApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * Register a webhook endpoint (max 3 per workspace). The returned `secret`
   * (`whsec_…`) is shown ONCE — store it; you need it to verify signatures.
   */
  create(params: WebhookEndpointCreateParams): Promise<WebhookEndpointCreated> {
    return this.http.request("POST", "/v1/webhook-endpoints", { body: params });
  }

  /** List endpoints (secrets are never returned). */
  list(): Promise<{ data: WebhookEndpoint[] }> {
    return this.http.request("GET", "/v1/webhook-endpoints");
  }

  /** Delete an endpoint (stops deliveries immediately). */
  async delete(id: string): Promise<void> {
    await this.http.request("DELETE", `/v1/webhook-endpoints/${id}`);
  }
}

// ─────────────────────────── Campaigns ───────────────────────────

/**
 * Requires the Campaigns feature on the workspace's plan — every route
 * throws 403 `FEATURE_NOT_INCLUDED_IN_PLAN` otherwise.
 */
export class CampaignsApi {
  constructor(private readonly http: HttpClient) {}

  list(params?: ListParams): Promise<Paginated<Campaign>> {
    return this.http.request("GET", "/v1/campaigns", {
      query: listQuery(params),
    });
  }

  /**
   * Iterate every matching campaign, auto-paginating GET /v1/campaigns
   * (`limit` cap 500). Accepts the same params as `list`.
   */
  iter(params: ListParams = {}): AsyncGenerator<Campaign, void, undefined> {
    return paginate(
      (limit, offset) => this.list({ ...params, limit, offset }),
      STANDARD_PAGE_CAP,
      params.limit,
      params.offset,
    );
  }

  get(id: string): Promise<Campaign> {
    return this.http.request("GET", `/v1/campaigns/${id}`);
  }

  create(params: CampaignCreateParams): Promise<Campaign> {
    return this.http.request("POST", "/v1/campaigns", { body: params });
  }

  update(id: string, params: CampaignUpdateParams): Promise<Campaign> {
    return this.http.request("PATCH", `/v1/campaigns/${id}`, { body: params });
  }

  /**
   * Enqueue a campaign for background execution — resolves (HTTP 200) only
   * when the campaign was queued. Failures throw OtokApiError: 404
   * `campaign_not_found` (unknown id) or 409 `campaign_not_scheduled` (only
   * "scheduled" campaigns can be executed; campaigns are created as "draft"
   * unless `status: "scheduled"` is set on create or via update).
   */
  execute(id: string): Promise<CampaignExecuteResult> {
    return this.http.request("POST", `/v1/campaigns/${id}/execute`);
  }
}

// ─────────────────────────── Audiences ───────────────────────────

/**
 * Read-only discovery of the workspace's saved audiences — the reusable
 * targeting selectors campaigns and email campaigns accept as `audience_id`.
 * Rows never include the stored `definition` (the `$where` condition tree
 * behind a dynamic audience); audiences are managed in-app and are not
 * writable through the public API.
 */
export class AudiencesApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * List the workspace's audiences, newest first (default 25, cap 100).
   * `last_count` is an advisory size cache, never a live resolution — use
   * `emailCampaigns.estimate` for a campaign's real reach. An unknown `kind`
   * value 400s.
   */
  list(params: AudienceListParams = {}): Promise<Paginated<AudienceSummary>> {
    return this.http.request("GET", "/v1/audiences", { query: { ...params } });
  }

  /**
   * Iterate every matching audience, auto-paginating GET /v1/audiences
   * (`limit` cap 100 — the deals/payments family). Accepts the same params
   * as `list`.
   */
  iter(
    params: AudienceListParams = {},
  ): AsyncGenerator<AudienceSummary, void, undefined> {
    return paginate(
      (limit, offset) => this.list({ ...params, limit, offset }),
      DEALS_PAYMENTS_PAGE_CAP,
      params.limit,
      params.offset,
    );
  }
}

// ─────────────────────────── Sender profiles ───────────────────────────

/**
 * Read-only discovery of the workspace's email from-identities — the
 * selectors email campaigns accept as `sender_profile_id`. Each row carries
 * the composed `from_email` plus the sending domain's verification status
 * (`verified: true` = the profile can pass the launch gate); DKIM/DNS
 * material is never returned. Profiles are managed in-app (Settings →
 * Email) and are not writable through the public API.
 *
 * Requires the Email marketing feature (`email_marketing`) on the
 * workspace's plan — throws 403 `FEATURE_NOT_INCLUDED_IN_PLAN` otherwise.
 */
export class SenderProfilesApi {
  constructor(private readonly http: HttpClient) {}

  /** List the workspace's sender profiles, newest first (default 25, cap 100). */
  list(
    params: SenderProfileListParams = {},
  ): Promise<Paginated<SenderProfile>> {
    return this.http.request("GET", "/v1/sender-profiles", {
      query: { ...params },
    });
  }

  /**
   * Iterate every sender profile, auto-paginating GET /v1/sender-profiles
   * (`limit` cap 100 — the deals/payments family). Accepts the same params
   * as `list`.
   */
  iter(
    params: SenderProfileListParams = {},
  ): AsyncGenerator<SenderProfile, void, undefined> {
    return paginate(
      (limit, offset) => this.list({ ...params, limit, offset }),
      DEALS_PAYMENTS_PAGE_CAP,
      params.limit,
      params.offset,
    );
  }
}

// ─────────────────────────── Email campaigns ───────────────────────────

/**
 * Broadcast one-off emails, authored through the shared `content` contract
 * (markdown | typed blocks | raw design_json) and compiled at write time —
 * write responses carry a `compile: {ok, errors, warnings}` envelope. A/B
 * testing is deliberately not exposed on the public API.
 *
 * Requires the Email marketing feature (`email_marketing`) on the
 * workspace's plan — every route throws 403 `FEATURE_NOT_INCLUDED_IN_PLAN`
 * otherwise.
 */
export class EmailCampaignsApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * List campaigns, newest first. Rows omit the content columns
   * (design_json / compiled_html / plain_text) and include the delivery
   * counters — use `get` for the content. Pages like deals/payments
   * (default 25, cap 100); an unknown `status` value 400s.
   */
  list(params: EmailCampaignListParams = {}): Promise<Paginated<EmailCampaign>> {
    return this.http.request("GET", "/v1/email-campaigns", {
      query: { ...params },
    });
  }

  /**
   * Iterate every matching campaign, auto-paginating GET /v1/email-campaigns
   * (`limit` cap 100 — the deals/payments family). Accepts the same params
   * as `list`.
   */
  iter(
    params: EmailCampaignListParams = {},
  ): AsyncGenerator<EmailCampaign, void, undefined> {
    return paginate(
      (limit, offset) => this.list({ ...params, limit, offset }),
      DEALS_PAYMENTS_PAGE_CAP,
      params.limit,
      params.offset,
    );
  }

  /** Get a campaign (full — including design_json and the delivery counters). */
  get(id: string): Promise<EmailCampaign> {
    return this.http.request("GET", `/v1/email-campaigns/${id}`);
  }

  /**
   * Create a draft campaign (idempotent upsert via `external_reference`).
   * `content` compiles immediately — check `result.compile` for errors and
   * warnings. The campaign starts as `draft`; launch it with `send` or
   * `schedule`. A repeat POST with the same reference updates the campaign's
   * fields while it is still draft/scheduled (`duplicate: true` — never
   * status or scheduled_at); once the launch claimed it, replays return the
   * campaign verbatim without a `compile` envelope.
   */
  create(params: EmailCampaignCreateParams): Promise<EmailCampaignCreateResult> {
    return this.http.request("POST", "/v1/email-campaigns", { body: params });
  }

  /**
   * Update a draft/scheduled campaign — same field set as create minus
   * `external_reference`. A content change recompiles (and detaches an
   * in-app template — the patched content is what sends). Campaigns the
   * launch already claimed throw 409 `campaign_not_editable`.
   */
  update(
    id: string,
    params: EmailCampaignUpdateParams,
  ): Promise<EmailCampaignUpdateResult> {
    return this.http.request("PATCH", `/v1/email-campaigns/${id}`, {
      body: params,
    });
  }

  /**
   * Estimate the campaign's audience size — the campaign's STORED targeting
   * run through the same resolver pipeline the send path uses (email
   * consent + suppressions baseline, audience, groups, topic opt-outs).
   */
  estimate(id: string): Promise<AudienceEstimate> {
    return this.http.request("GET", `/v1/email-campaigns/${id}/estimate`);
  }

  /**
   * Launch the campaign now (draft/scheduled only — otherwise 409
   * `campaign_not_sendable`). The launch gates (sender readiness, inline
   * compile, content lint) run synchronously; success (HTTP 200) returns the
   * campaign with its post-launch status. A gate failure throws 422
   * `launch_failed` with the gate's message — the campaign's final status
   * (the gate marks it `failed`) rides the error body as
   * `error.campaign_status`.
   */
  send(id: string): Promise<EmailCampaign> {
    return this.http.request("POST", `/v1/email-campaigns/${id}/send`);
  }

  /**
   * Schedule (or reschedule) a future launch — draft/scheduled only
   * (otherwise 409 `campaign_not_schedulable`). `scheduledAt` is an ISO 8601
   * UTC instant in the future (otherwise 400 `invalid_scheduled_at`); the
   * every-minute sweep launches the campaign when due.
   */
  schedule(id: string, scheduledAt: string): Promise<EmailCampaign> {
    return this.http.request("POST", `/v1/email-campaigns/${id}/schedule`, {
      body: { scheduled_at: scheduledAt },
    });
  }

  /**
   * Cancel a scheduled launch (back to draft). Conditional on status
   * "scheduled" — when the send sweep already claimed the campaign the call
   * throws 409 `already_sending`; any other status throws 409
   * `campaign_not_scheduled`.
   */
  unschedule(id: string): Promise<EmailCampaign> {
    return this.http.request("POST", `/v1/email-campaigns/${id}/unschedule`);
  }
}

// ─────────────────────────── Newsletters ───────────────────────────

/**
 * Smart newsletters and their sequenced issues. Issue content is authored
 * through the shared `content` contract (markdown | typed blocks | raw
 * design_json) and compiles on save; publish assigns the issue number and
 * wakes caught-up subscribers — the drip engine behaves exactly as an
 * in-app publish.
 *
 * Requires the Newsletters feature (`newsletters`) on the workspace's plan —
 * every route throws 403 `FEATURE_NOT_INCLUDED_IN_PLAN` otherwise.
 */
export class NewslettersApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * List newsletters, newest first, each with its computed
   * `active_subscriber_count`. Pages like deals/payments (default 25,
   * cap 100).
   */
  list(params: NewsletterListParams = {}): Promise<Paginated<Newsletter>> {
    return this.http.request("GET", "/v1/newsletters", {
      query: { ...params },
    });
  }

  /**
   * Iterate every newsletter, auto-paginating GET /v1/newsletters (`limit`
   * cap 100 — the deals/payments family). Accepts the same params as `list`.
   */
  iter(
    params: NewsletterListParams = {},
  ): AsyncGenerator<Newsletter, void, undefined> {
    return paginate(
      (limit, offset) => this.list({ ...params, limit, offset }),
      DEALS_PAYMENTS_PAGE_CAP,
      params.limit,
      params.offset,
    );
  }

  /**
   * Create a newsletter — a `name` alone suffices (cadence, enrollment
   * policy and archive settings take their defaults; configure them in-app).
   * A duplicate name throws 409 `duplicate_name`; the plan's newsletter cap
   * throws 403 `PLAN_LIMIT_EXCEEDED`.
   */
  create(params: NewsletterCreateParams): Promise<Newsletter> {
    return this.http.request("POST", "/v1/newsletters", { body: params });
  }

  /** Get a newsletter (with its active subscriber count). */
  get(id: string): Promise<Newsletter> {
    return this.http.request("GET", `/v1/newsletters/${id}`);
  }

  // ── Issues ──

  /**
   * List a newsletter's issues, newest first. Rows omit the content columns
   * (design_json / compiled_html / plain_text) — use `getIssue` for those.
   * Pages like deals/payments (default 25, cap 100); an unknown `status`
   * value 400s.
   */
  listIssues(
    newsletterId: string,
    params: NewsletterIssueListParams = {},
  ): Promise<Paginated<NewsletterIssue>> {
    return this.http.request("GET", `/v1/newsletters/${newsletterId}/issues`, {
      query: { ...params },
    });
  }

  /**
   * Iterate every matching issue, auto-paginating GET
   * /v1/newsletters/:id/issues (`limit` cap 100 — the deals/payments
   * family). Accepts the same params as `listIssues`.
   */
  iterIssues(
    newsletterId: string,
    params: NewsletterIssueListParams = {},
  ): AsyncGenerator<NewsletterIssue, void, undefined> {
    return paginate(
      (limit, offset) => this.listIssues(newsletterId, { ...params, limit, offset }),
      DEALS_PAYMENTS_PAGE_CAP,
      params.limit,
      params.offset,
    );
  }

  /**
   * Create a draft issue (idempotent upsert via `external_reference`).
   * `content` compiles immediately — check `result.compile`. A repeat POST
   * with the same reference updates the matched issue's content/fields
   * (`duplicate: true`) and never touches status, scheduled_at or
   * issue_number; a reference belonging to an issue of a DIFFERENT
   * newsletter throws 409 `external_reference_in_use`.
   */
  createIssue(
    newsletterId: string,
    params: NewsletterIssueCreateParams = {},
  ): Promise<NewsletterIssueCreateResult> {
    return this.http.request("POST", `/v1/newsletters/${newsletterId}/issues`, {
      body: params,
    });
  }

  /** Get an issue (full — including design_json, compiled_html and plain_text). */
  getIssue(issueId: string): Promise<NewsletterIssue> {
    return this.http.request("GET", `/v1/newsletter-issues/${issueId}`);
  }

  /**
   * Update an issue. Published issues stay editable (a content change
   * recompiles); a scheduled issue's content cannot be cleared — unschedule
   * first.
   */
  updateIssue(
    issueId: string,
    params: NewsletterIssueUpdateParams,
  ): Promise<NewsletterIssueUpdateResult> {
    return this.http.request("PATCH", `/v1/newsletter-issues/${issueId}`, {
      body: params,
    });
  }

  /**
   * Delete a draft/scheduled issue. Published issues cannot be deleted (400
   * `issue_published`) — exclude them from the archive instead. Returns
   * `{ success: true }`.
   */
  deleteIssue(issueId: string): Promise<{ success: boolean }> {
    return this.http.request("DELETE", `/v1/newsletter-issues/${issueId}`);
  }

  /**
   * Publish an issue now — assigns the next issue number and wakes
   * caught-up subscribers. Idempotent: an already-published issue is
   * returned as-is. Requires a subject and compiled content (otherwise 409
   * `issue_missing_content`).
   */
  publishIssue(issueId: string): Promise<NewsletterIssue> {
    return this.http.request("POST", `/v1/newsletter-issues/${issueId}/publish`);
  }

  /**
   * Schedule (or reschedule) a future publish. `scheduledAt` is an ISO 8601
   * UTC instant in the future (otherwise 400 `invalid_scheduled_at`).
   * Already-published issues throw 409 `issue_already_published`; missing
   * subject/content throws 409 `issue_missing_content`.
   */
  scheduleIssue(issueId: string, scheduledAt: string): Promise<NewsletterIssue> {
    return this.http.request(
      "POST",
      `/v1/newsletter-issues/${issueId}/schedule`,
      { body: { scheduled_at: scheduledAt } },
    );
  }

  /**
   * Cancel a scheduled publish (back to draft). Issues not currently
   * scheduled throw 409 `issue_not_scheduled`.
   */
  unscheduleIssue(issueId: string): Promise<NewsletterIssue> {
    return this.http.request(
      "POST",
      `/v1/newsletter-issues/${issueId}/unschedule`,
    );
  }
}

// ─────────────────────────── Templates (WhatsApp) ───────────────────────────

export class TemplatesApi {
  constructor(private readonly http: HttpClient) {}

  list(params?: ListParams): Promise<Paginated<MessageTemplate>> {
    return this.http.request("GET", "/v1/templates", {
      query: listQuery(params),
    });
  }

  /**
   * Iterate every matching template, auto-paginating GET /v1/templates
   * (`limit` cap 500). Accepts the same params as `list`.
   */
  iter(
    params: ListParams = {},
  ): AsyncGenerator<MessageTemplate, void, undefined> {
    return paginate(
      (limit, offset) => this.list({ ...params, limit, offset }),
      STANDARD_PAGE_CAP,
      params.limit,
      params.offset,
    );
  }

  get(id: string): Promise<MessageTemplate> {
    return this.http.request("GET", `/v1/templates/${id}`);
  }

  /**
   * Send a template message via WhatsApp. The contact (matched by phone) and
   * its conversation are created automatically when they don't exist.
   */
  send(
    id: string,
    params: TemplateSendParams,
  ): Promise<Record<string, unknown>> {
    return this.http.request("POST", `/v1/templates/${id}/send`, {
      body: params,
    });
  }
}

// ─────────────────────────── Payments ───────────────────────────

/**
 * Requires the Payments feature on the workspace's plan — every route
 * throws 403 `FEATURE_NOT_INCLUDED_IN_PLAN` otherwise.
 */
export class PaymentsApi {
  constructor(private readonly http: HttpClient) {}

  list(params: PaymentListParams = {}): Promise<Paginated<Payment>> {
    return this.http.request("GET", "/v1/payments", { query: { ...params } });
  }

  /**
   * Iterate every matching payment, auto-paginating GET /v1/payments
   * (`limit` cap 100 — payments paginate differently from the standard
   * lists). Accepts the same params as `list`.
   */
  iter(params: PaymentListParams = {}): AsyncGenerator<Payment, void, undefined> {
    return paginate(
      (limit, offset) => this.list({ ...params, limit, offset }),
      DEALS_PAYMENTS_PAGE_CAP,
      params.limit,
      params.offset,
    );
  }

  /** Get a payment with its entry schedule. */
  get(id: string): Promise<Payment> {
    return this.http.request("GET", `/v1/payments/${id}`);
  }

  /**
   * Create a payment (idempotent upsert via `external_reference` — a repeat
   * POST updates that payment's mutable fields and the result carries
   * `duplicate: true`).
   */
  create(params: PaymentCreateParams): Promise<PaymentCreateResult> {
    return this.http.request("POST", "/v1/payments", { body: params });
  }

  update(id: string, params: PaymentUpdateParams): Promise<Payment> {
    return this.http.request("PATCH", `/v1/payments/${id}`, { body: params });
  }

  /** Cancel a recurring payment plan. */
  cancel(id: string): Promise<Payment> {
    return this.http.request("POST", `/v1/payments/${id}/cancel`);
  }

  /** Mark a payment entry (installment/cycle) failed, refunded, etc. */
  markEntry(
    id: string,
    entryId: string,
    status: PaymentEntryStatus,
  ): Promise<Payment> {
    return this.http.request("POST", `/v1/payments/${id}/entries/${entryId}/mark`, {
      body: { status },
    });
  }

  /** Refund a payment (full or partial). */
  refund(id: string, params: PaymentRefundParams = {}): Promise<Payment> {
    return this.http.request("POST", `/v1/payments/${id}/refund`, {
      body: params,
    });
  }
}

// ─────────────────────────── Payment requests ───────────────────────────

/**
 * Hosted pay-by-link requests collected through the workspace's own
 * connected payment provider (Cardcom / Sumit).
 *
 * Requires the Workspace payments feature (`workspace_payments`) on the
 * workspace's plan — a DIFFERENT feature from the `payments` ledger gate on
 * `otok.payments` — and every route throws 403
 * `FEATURE_NOT_INCLUDED_IN_PLAN` without it. Minting additionally requires a
 * connected provider (400 `NO_PAYMENT_PROVIDER` otherwise).
 */
export class PaymentRequestsApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * List payment requests, newest first. Pages like deals/payments (default
   * 25, cap 100; malformed paging 400s). Unlike deals/payments, an unknown
   * `status` value 400s instead of being silently ignored. Rows include
   * joined contact identity and a computed `refunded_total`.
   */
  list(params: PaymentRequestListParams = {}): Promise<Paginated<PaymentRequest>> {
    return this.http.request("GET", "/v1/payment-requests", {
      query: { ...params },
    });
  }

  /**
   * Iterate every matching payment request, auto-paginating GET
   * /v1/payment-requests (`limit` cap 100 — the deals/payments family).
   * Accepts the same params as `list`.
   */
  iter(
    params: PaymentRequestListParams = {},
  ): AsyncGenerator<PaymentRequest, void, undefined> {
    return paginate(
      (limit, offset) => this.list({ ...params, limit, offset }),
      DEALS_PAYMENTS_PAGE_CAP,
      params.limit,
      params.offset,
    );
  }

  /** Get a payment request (with its `pay_url`, and `document` once paid). */
  get(id: string): Promise<PaymentRequest> {
    return this.http.request("GET", `/v1/payment-requests/${id}`);
  }

  /**
   * Mint a hosted-checkout pay-link and return the row with its shareable
   * `pay_url`.
   *
   * **NOT idempotent — there is no idempotency key on this resource.** A
   * repeat POST mints a second, independently payable link, so the SDK
   * NEVER auto-retries this call on transient network errors (unlike the
   * keyed creates): a network failure surfaces for you to handle. If the
   * outcome is uncertain, check `list()` for the link you may have already
   * minted before minting again, and `cancel()` extras.
   *
   * The payer resolves like payments/deals: `contact_id` wins, else
   * `phone`/`email` upsert a contact (409 `CONTACT_MERGE_REQUIRED` on
   * identity conflict), else a `deal_id` alone (the deal's contact pays).
   */
  create(params: PaymentRequestCreateParams): Promise<PaymentRequestCreateResult> {
    return this.http.request("POST", "/v1/payment-requests", { body: params });
  }

  /**
   * Cancel a PENDING payment request — the hosted page stops accepting
   * payment. The cancel is a compare-and-set on the status, so it is safe
   * to repeat: already paid/expired/cancelled rows throw 409 ("Only pending
   * payment requests can be cancelled"), and system-created saved-card
   * charge rows throw 409 `TOKEN_REQUEST_NOT_CANCELLABLE`. A payer already
   * on the hosted page can still complete after the cancel — such late
   * completions are recorded and fire `payment_request.paid`.
   */
  cancel(id: string): Promise<PaymentRequest> {
    return this.http.request("POST", `/v1/payment-requests/${id}/cancel`);
  }
}

// ─────────────────────────── Orders ───────────────────────────

/**
 * Requires the Orders feature on the workspace's plan — every route throws
 * 403 `FEATURE_NOT_INCLUDED_IN_PLAN` otherwise.
 */
export class OrdersApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * List orders, newest `placed_at` first. Rows omit `items`/`refunds` —
   * use `get` for the full order.
   */
  list(params: OrderListParams = {}): Promise<Paginated<Order>> {
    return this.http.request("GET", "/v1/orders", { query: { ...params } });
  }

  /**
   * Iterate every matching order, auto-paginating GET /v1/orders (`limit`
   * cap 100 — orders paginate like deals and payments). Accepts the same
   * params as `list`.
   */
  iter(params: OrderListParams = {}): AsyncGenerator<Order, void, undefined> {
    return paginate(
      (limit, offset) => this.list({ ...params, limit, offset }),
      DEALS_PAYMENTS_PAGE_CAP,
      params.limit,
      params.offset,
    );
  }

  /** Get a full order with `items[]` + `refunds[]`. */
  get(id: string): Promise<Order> {
    return this.http.request("GET", `/v1/orders/${id}`);
  }

  /**
   * Create an order. Idempotent when `external_reference` is set: a repeat
   * POST with the same reference updates that order's mutable fields
   * instead of creating a duplicate (money fields apply only while the
   * order is still `pending`; `financial_status` and the contact never
   * change on a match).
   *
   * Unlike the other create endpoints the response carries NO top-level
   * `duplicate` flag — both outcomes return 201 with the full order (items
   * + refunds). To distinguish, compare `created_at` or pre-check with
   * `list({ external_reference: … })`.
   */
  create(params: OrderCreateParams): Promise<Order> {
    return this.http.request("POST", "/v1/orders", { body: params });
  }

  /**
   * Record a refund on the order's append-only refund ledger and roll its
   * financial status to `partially_refunded`/`refunded`. Returns
   * `{ duplicate, order }` — `duplicate: true` means the
   * `external_refund_id` was already recorded and nothing was applied.
   *
   * `external_refund_id` is the idempotency key; WITHOUT it every call
   * appends a new refund, so supply it whenever your system can retry.
   * Refunds require the order to have ever been paid (400
   * `ORDER_NEVER_PAID` otherwise).
   */
  createRefund(id: string, params: OrderRefundParams): Promise<OrderRefundResult> {
    return this.http.request("POST", `/v1/orders/${id}/refunds`, {
      body: params,
    });
  }

  /**
   * Mark an order paid, recording a payment for the full order total on the
   * contact — or link onto an existing payment via `payment_reference`.
   * Marking an already-paid order is a no-op success; refund states (and
   * voided orders) throw 409 `ORDER_ILLEGAL_TRANSITION` (refund states are
   * set by recording refunds). Bad references throw typed errors: 404
   * `ORDER_PAYMENT_REFERENCE_NOT_FOUND`, 409
   * `ORDER_PAYMENT_CONTACT_MISMATCH` / `ORDER_PAYMENT_NOT_LINKABLE` /
   * `ORDER_PAYMENT_ALREADY_LINKED`.
   */
  markPaid(id: string, params: OrderMarkPaidParams = {}): Promise<Order> {
    return this.http.request("POST", `/v1/orders/${id}/mark-paid`, {
      body: params,
    });
  }

  /**
   * Cancel an order — stamps `cancelled_at`. Cancellation is a stamp, not a
   * financial status: recorded revenue stands until refunds are recorded.
   * Cancelling an already-cancelled order is a no-op success.
   */
  cancel(id: string): Promise<Order> {
    return this.http.request("POST", `/v1/orders/${id}/cancel`);
  }
}

// ─────────────────────────── Bookings ───────────────────────────

/**
 * Requires the Booking feature on the workspace's plan — every route throws
 * 403 `FEATURE_NOT_INCLUDED_IN_PLAN` otherwise.
 */
export class MeetingTypesApi {
  constructor(private readonly http: HttpClient) {}

  list(params?: ListParams): Promise<Paginated<MeetingType>> {
    return this.http.request("GET", "/v1/meeting-types", {
      query: listQuery(params),
    });
  }

  /**
   * Iterate every matching meeting type, auto-paginating GET
   * /v1/meeting-types (`limit` cap 500). Accepts the same params as `list`.
   */
  iter(params: ListParams = {}): AsyncGenerator<MeetingType, void, undefined> {
    return paginate(
      (limit, offset) => this.list({ ...params, limit, offset }),
      STANDARD_PAGE_CAP,
      params.limit,
      params.offset,
    );
  }

  get(id: string): Promise<MeetingType> {
    return this.http.request("GET", `/v1/meeting-types/${id}`);
  }

  /** Open start instants (UTC) over [from, to) — max 62 days. */
  slots(id: string, params: SlotsParams): Promise<Record<string, unknown>> {
    return this.http.request("GET", `/v1/meeting-types/${id}/slots`, {
      query: { from: params.from, to: params.to },
    });
  }

  /**
   * Website-embed material for the meeting type: the hosted booking
   * `page_url`, the publishable `embed_key` (`bk_…` — NOT the secret API
   * key; rotation, the origin allowlist, and the embed on/off switch live
   * in the app under Settings → Booking), and a ready-to-paste
   * `snippet_html`. Bookings made through the embed carry
   * `source: "embed"`.
   */
  embed(id: string): Promise<MeetingTypeEmbed> {
    return this.http.request("GET", `/v1/meeting-types/${id}/embed`);
  }
}

/**
 * Requires the Booking feature on the workspace's plan — every route throws
 * 403 `FEATURE_NOT_INCLUDED_IN_PLAN` otherwise.
 */
export class BookingsApi {
  constructor(private readonly http: HttpClient) {}

  list(params: BookingListParams = {}): Promise<Paginated<Booking>> {
    return this.http.request("GET", "/v1/bookings", { query: { ...params } });
  }

  /**
   * Iterate every matching booking, auto-paginating GET /v1/bookings
   * (`limit` cap 500). Accepts the same params as `list`.
   */
  iter(params: BookingListParams = {}): AsyncGenerator<Booking, void, undefined> {
    return paginate(
      (limit, offset) => this.list({ ...params, limit, offset }),
      STANDARD_PAGE_CAP,
      params.limit,
      params.offset,
    );
  }

  get(id: string): Promise<Booking> {
    return this.http.request("GET", `/v1/bookings/${id}`);
  }

  /**
   * Book a slot server-to-server. A taken slot throws 409 SLOT_TAKEN; a
   * double-submit of the same slot/invitee returns the original booking
   * with `duplicate: true`.
   */
  create(params: BookingCreateParams): Promise<BookingCreateResult> {
    return this.http.request("POST", "/v1/bookings", { body: params });
  }

  cancel(id: string, reason?: string): Promise<Booking> {
    return this.http.request("POST", `/v1/bookings/${id}/cancel`, {
      body: reason !== undefined ? { reason } : {},
    });
  }

  reschedule(id: string, params: BookingRescheduleParams): Promise<Booking> {
    return this.http.request("POST", `/v1/bookings/${id}/reschedule`, {
      body: params,
    });
  }

  reassign(id: string, params: BookingReassignParams = {}): Promise<Booking> {
    return this.http.request("POST", `/v1/bookings/${id}/reassign`, {
      body: params,
    });
  }
}
