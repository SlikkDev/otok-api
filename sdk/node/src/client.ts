import { CommerceApi } from "./commerce";
import { HttpClient, type HttpClientOptions } from "./http";
import {
  BookingsApi,
  CampaignsApi,
  ContactGroupsApi,
  ContactsApi,
  DealsApi,
  EmailsApi,
  MeetingTypesApi,
  OrdersApi,
  PaymentRequestsApi,
  PaymentsApi,
  PipelinesApi,
  TagsApi,
  TemplatesApi,
  WebhookEndpointsApi,
} from "./resources";

export type OtokClientOptions = HttpClientOptions;

/**
 * Client for the oToK public API (/v1).
 *
 * ```ts
 * const otok = new OtokClient({
 *   apiKey: process.env.OTOK_API_KEY!,          // "otok_live_…"
 * });
 * const contact = await otok.contacts.upsert({ email: "jane@example.com" });
 * ```
 *
 * Rate limits: requests are throttled per API key (default 100/min; POST
 * /v1/emails allows 300/min). The client retries 429 and 5xx responses with
 * exponential backoff + jitter, honoring `Retry-After`. Transient network
 * errors (connection reset/refused, DNS failure, socket timeout) share the
 * same bounded backoff, but only for requests that are safe to replay:
 * GET/HEAD, or writes carrying an idempotency key (`idempotency_key`,
 * `external_reference`, `external_refund_id`) — other writes surface the
 * network error.
 */
export class OtokClient {
  readonly contacts: ContactsApi;
  readonly tags: TagsApi;
  readonly contactGroups: ContactGroupsApi;
  readonly pipelines: PipelinesApi;
  readonly deals: DealsApi;
  readonly emails: EmailsApi;
  readonly campaigns: CampaignsApi;
  readonly templates: TemplatesApi;
  readonly payments: PaymentsApi;
  readonly paymentRequests: PaymentRequestsApi;
  readonly orders: OrdersApi;
  readonly meetingTypes: MeetingTypesApi;
  readonly bookings: BookingsApi;
  readonly webhookEndpoints: WebhookEndpointsApi;
  /** High-level e-commerce helpers (identifyCustomer, trackOrder). */
  readonly commerce: CommerceApi;

  private readonly http: HttpClient;

  constructor(options: OtokClientOptions) {
    this.http = new HttpClient(options);
    this.contacts = new ContactsApi(this.http);
    this.tags = new TagsApi(this.http);
    this.contactGroups = new ContactGroupsApi(this.http);
    this.pipelines = new PipelinesApi(this.http);
    this.deals = new DealsApi(this.http);
    this.emails = new EmailsApi(this.http);
    this.campaigns = new CampaignsApi(this.http);
    this.templates = new TemplatesApi(this.http);
    this.payments = new PaymentsApi(this.http);
    this.paymentRequests = new PaymentRequestsApi(this.http);
    this.orders = new OrdersApi(this.http);
    this.meetingTypes = new MeetingTypesApi(this.http);
    this.bookings = new BookingsApi(this.http);
    this.webhookEndpoints = new WebhookEndpointsApi(this.http);
    this.commerce = new CommerceApi(this.contacts, this.deals, this.emails);
  }
}
