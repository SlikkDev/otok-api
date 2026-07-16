import type { ContactsApi, DealsApi, EmailsApi } from "./resources";
import type {
  ContactUpsertParams,
  ContactUpsertResult,
  DealCreateResult,
  EmailSendResult,
} from "./types";

/**
 * High-level e-commerce layer: plain customer/order objects in, contact
 * upserts + idempotent deal creation (and an optional receipt email) out.
 *
 * Everything here is retry-safe by design:
 * - customers upsert by phone/email (no duplicates),
 * - orders map to deals through `external_reference` (one order = one deal),
 * - receipts carry a deterministic email idempotency key derived from the
 *   order id (one order = at most one receipt).
 *
 * Note: this layer records each order as a sales-pipeline entry (a deal) —
 * for the Orders API itself (`/v1/orders`) use `otok.orders`.
 */

export interface CommerceCustomer {
  /** At least one of email / phone is required. */
  email?: string;
  /** E.164 preferred, e.g. "+12025551234". */
  phone?: string;
  firstName?: string;
  lastName?: string;
  /** Full name; used when firstName/lastName aren't split. */
  name?: string;
  /** Tag NAMES — added to the contact (never removed). */
  tags?: string[];
  /** Contact group NAMES — added to the contact (never removed). */
  groups?: string[];
  address?: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };
  /** Workspace-defined custom fields, keyed by field key. */
  customFields?: Record<string, unknown>;
  /** Extra wire-format contact fields to pass through as-is. */
  extra?: ContactUpsertParams;
}

export interface CommerceOrder {
  /**
   * Your order id. Becomes the deal's `external_reference` (prefixed
   * `order:`), which makes `trackOrder` idempotent — the same order never
   * creates two deals.
   */
  orderId: string;
  customer: CommerceCustomer;
  /** Order total (deal amount). */
  total: number;
  /** 3-letter code; defaults to the workspace currency. */
  currency?: string;
  /** Deal title; defaults to "Order <orderId>". */
  title?: string;
  /** Target pipeline; defaults to the workspace default pipeline. */
  pipelineId?: string;
  /** Target stage; defaults to the pipeline's first stage. */
  stageId?: string;
  /** Note stored on the deal. */
  note?: string;
  /** Attach a catalog product by SKU (deal title derives from the product). */
  productSku?: string;
  /** Optional transactional receipt email, sent at most once per order. */
  receipt?: {
    subject: string;
    html?: string;
    text?: string;
    /** Defaults to the workspace's default verified sender profile. */
    senderProfileId?: string;
    replyTo?: string;
  };
}

export interface TrackOrderResult {
  /** `contact.duplicate` is true when an existing contact was matched. */
  contact: ContactUpsertResult;
  /** `deal.duplicate` is true when the order was already tracked (replay). */
  deal: DealCreateResult;
  /** Present only when `order.receipt` was provided. */
  receipt?: EmailSendResult;
}

export function customerToContactParams(
  customer: CommerceCustomer,
): ContactUpsertParams {
  if (!customer.email && !customer.phone) {
    throw new Error(
      "@otok/node: a commerce customer needs at least an email or a phone",
    );
  }
  const params: ContactUpsertParams = {
    email: customer.email,
    phone: customer.phone,
    first_name: customer.firstName,
    last_name: customer.lastName,
    name: customer.name,
    tags: customer.tags,
    groups: customer.groups,
    custom_fields: customer.customFields,
    address_line1: customer.address?.line1,
    address_line2: customer.address?.line2,
    city: customer.address?.city,
    state: customer.address?.state,
    postal_code: customer.address?.postalCode,
    country: customer.address?.country,
    ...customer.extra,
  };
  // Drop undefined keys so the request body stays minimal.
  for (const key of Object.keys(params) as (keyof ContactUpsertParams)[]) {
    if (params[key] === undefined) delete params[key];
  }
  return params;
}

/** Deterministic deal idempotency reference for an order. */
export function orderExternalReference(orderId: string): string {
  return `order:${orderId}`;
}

/** Deterministic email idempotency key for an order's receipt. */
export function orderReceiptIdempotencyKey(orderId: string): string {
  return `order:${orderId}:receipt`;
}

export class CommerceApi {
  constructor(
    private readonly contacts: ContactsApi,
    private readonly deals: DealsApi,
    private readonly emails: EmailsApi,
  ) {}

  /**
   * Upsert a store customer as an oToK contact (matched by phone, falling
   * back to email). Tags/groups are added, never removed — safe to call on
   * every login/checkout. The result's `duplicate` flag is true when an
   * existing contact was matched and updated.
   */
  identifyCustomer(customer: CommerceCustomer): Promise<ContactUpsertResult> {
    return this.contacts.upsert(customerToContactParams(customer));
  }

  /**
   * Record an order: upserts the customer, then creates (or idempotently
   * updates) a deal keyed by the order id, and optionally sends a receipt
   * email exactly once. Safe to retry and safe to call from at-least-once
   * webhook handlers — replays converge on the same contact/deal/receipt.
   *
   * Note: this records a sales-pipeline entry (a deal), not an order
   * object — use `otok.orders` for the Orders API (`/v1/orders`).
   */
  async trackOrder(order: CommerceOrder): Promise<TrackOrderResult> {
    if (!order.orderId) throw new Error("@otok/node: order.orderId is required");

    const contact = await this.identifyCustomer(order.customer);

    const deal = await this.deals.create({
      contact_id: contact.id,
      title: order.productSku ? undefined : order.title ?? `Order ${order.orderId}`,
      product_sku: order.productSku,
      amount: order.total,
      currency: order.currency,
      pipeline_id: order.pipelineId,
      stage_id: order.stageId,
      note: order.note,
      external_reference: orderExternalReference(order.orderId),
    });

    let receipt: EmailSendResult | undefined;
    if (order.receipt) {
      const to = order.customer.email;
      if (!to) {
        throw new Error(
          "@otok/node: order.receipt requires customer.email to send to",
        );
      }
      receipt = await this.emails.send({
        to,
        subject: order.receipt.subject,
        html: order.receipt.html,
        text: order.receipt.text,
        sender_profile_id: order.receipt.senderProfileId,
        reply_to: order.receipt.replyTo,
        metadata: { order_id: order.orderId },
        idempotency_key: orderReceiptIdempotencyKey(order.orderId),
      });
    }

    return { contact, deal, receipt };
  }
}
