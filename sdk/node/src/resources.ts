import type { HttpClient, QueryValue } from "./http";
import type {
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
  Contact,
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
  EmailSendParams,
  EmailSendResult,
  ListParams,
  MeetingType,
  MessageTemplate,
  Note,
  NoteUpdateParams,
  Paginated,
  Payment,
  PaymentCreateParams,
  PaymentCreateResult,
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
/** Documented `limit` cap for GET /v1/deals and /v1/payments (default 25). */
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
