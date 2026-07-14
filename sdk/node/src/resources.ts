import type { HttpClient, QueryValue } from "./http";
import type {
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

// ─────────────────────────────── Contacts ───────────────────────────────

export class ContactsApi {
  constructor(private readonly http: HttpClient) {}

  list(params?: ListParams): Promise<Paginated<Contact>> {
    return this.http.request("GET", "/v1/contacts", { query: listQuery(params) });
  }

  get(id: string): Promise<Contact> {
    return this.http.request("GET", `/v1/contacts/${id}`);
  }

  /**
   * Create OR update (upsert) a contact. Matches by phone (canonicalized to
   * E.164), falling back to email. `tags`/`groups` are ADDED on upsert.
   */
  upsert(params: ContactUpsertParams): Promise<Contact> {
    return this.http.request("POST", "/v1/contacts", { body: params });
  }

  /** Update by id (404 when unknown). `tags`/`groups` REPLACE the full set. */
  update(id: string, params: ContactUpsertParams): Promise<Contact> {
    return this.http.request("PATCH", `/v1/contacts/${id}`, { body: params });
  }
}

// ─────────────────────────────── Tags ───────────────────────────────

export class TagsApi {
  constructor(private readonly http: HttpClient) {}

  list(params?: ListParams): Promise<Paginated<Tag>> {
    return this.http.request("GET", "/v1/tags", { query: listQuery(params) });
  }

  get(id: string): Promise<Tag> {
    return this.http.request("GET", `/v1/tags/${id}`);
  }

  create(params: TagCreateParams): Promise<Tag> {
    return this.http.request("POST", "/v1/tags", { body: params });
  }

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

  get(id: string): Promise<ContactGroup> {
    return this.http.request("GET", `/v1/contact-groups/${id}`);
  }

  create(params: ContactGroupCreateParams): Promise<ContactGroup> {
    return this.http.request("POST", "/v1/contact-groups", { body: params });
  }

  update(id: string, params: ContactGroupUpdateParams): Promise<ContactGroup> {
    return this.http.request("PATCH", `/v1/contact-groups/${id}`, {
      body: params,
    });
  }
}

// ─────────────────────────── Pipelines / deals ───────────────────────────

export class PipelinesApi {
  constructor(private readonly http: HttpClient) {}

  /** List pipelines, each with its ordered stages. */
  list(): Promise<Pipeline[]> {
    return this.http.request("GET", "/v1/pipelines");
  }
}

export class DealsApi {
  constructor(private readonly http: HttpClient) {}

  list(params: DealListParams = {}): Promise<Paginated<Deal>> {
    return this.http.request("GET", "/v1/deals", {
      query: { ...params },
    });
  }

  get(id: string): Promise<Deal> {
    return this.http.request("GET", `/v1/deals/${id}`);
  }

  /**
   * Create a deal. Idempotent when `external_reference` is set: a repeat POST
   * with the same reference updates that deal instead of creating a duplicate.
   */
  create(params: DealCreateParams): Promise<Deal> {
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

export class CampaignsApi {
  constructor(private readonly http: HttpClient) {}

  list(params?: ListParams): Promise<Paginated<Campaign>> {
    return this.http.request("GET", "/v1/campaigns", {
      query: listQuery(params),
    });
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
   * Enqueue a campaign for background execution. The campaign must be in
   * "scheduled" status; otherwise `{ success: false }` is returned.
   */
  execute(id: string): Promise<{ success: boolean } & Record<string, unknown>> {
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

export class PaymentsApi {
  constructor(private readonly http: HttpClient) {}

  list(params: PaymentListParams = {}): Promise<Paginated<Payment>> {
    return this.http.request("GET", "/v1/payments", { query: { ...params } });
  }

  /** Get a payment with its entry schedule. */
  get(id: string): Promise<Payment> {
    return this.http.request("GET", `/v1/payments/${id}`);
  }

  /** Create a payment (idempotent upsert via `external_reference`). */
  create(params: PaymentCreateParams): Promise<Payment> {
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

export class MeetingTypesApi {
  constructor(private readonly http: HttpClient) {}

  list(params?: ListParams): Promise<Paginated<MeetingType>> {
    return this.http.request("GET", "/v1/meeting-types", {
      query: listQuery(params),
    });
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

export class BookingsApi {
  constructor(private readonly http: HttpClient) {}

  list(params: BookingListParams = {}): Promise<Paginated<Booking>> {
    return this.http.request("GET", "/v1/bookings", { query: { ...params } });
  }

  get(id: string): Promise<Booking> {
    return this.http.request("GET", `/v1/bookings/${id}`);
  }

  /** Book a slot server-to-server. A taken slot throws 409 SLOT_TAKEN. */
  create(params: BookingCreateParams): Promise<Booking> {
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
