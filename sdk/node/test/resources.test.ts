import { describe, expect, it, vi } from "vitest";
import { OtokClient } from "../src/client";
import { OtokApiError } from "../src/errors";
import {
  DEFAULT_EMAIL_WEBHOOK_EVENT_TYPES,
  EMAIL_WEBHOOK_EVENT_TYPES,
  ORDER_WEBHOOK_EVENT_TYPES,
  PAYMENT_REQUEST_WEBHOOK_EVENT_TYPES,
} from "../src/types";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeClient(fetchImpl: typeof fetch) {
  return new OtokClient({
    apiKey: "otok_live_testkey",
    baseUrl: "https://example.test/api",
    fetch: fetchImpl,
  });
}

describe("webhook event type constants", () => {
  it("defaults to the three delivery events", () => {
    expect(DEFAULT_EMAIL_WEBHOOK_EVENT_TYPES).toEqual([
      "email.delivered",
      "email.bounced",
      "email.complained",
    ]);
  });

  it("keeps deprecated email.failed in the accepted set for back-compat", () => {
    expect(EMAIL_WEBHOOK_EVENT_TYPES).toContain("email.failed");
    // …but it is not part of the default subscription.
    expect(DEFAULT_EMAIL_WEBHOOK_EVENT_TYPES).not.toContain("email.failed");
  });

  it("order event types are registrable but never defaulted", () => {
    expect(ORDER_WEBHOOK_EVENT_TYPES).toEqual([
      "order.created",
      "order.paid",
      "order.refunded",
      "order.cancelled",
      "order.fulfilled",
    ]);
    // Order events are opt-in by listing: an endpoint registered without
    // an explicit `events` list gets only the email delivery defaults.
    for (const eventType of ORDER_WEBHOOK_EVENT_TYPES) {
      expect(DEFAULT_EMAIL_WEBHOOK_EVENT_TYPES).not.toContain(eventType);
    }
  });

  it("payment_request event types are registrable but never defaulted", () => {
    expect(PAYMENT_REQUEST_WEBHOOK_EVENT_TYPES).toEqual([
      "payment_request.created",
      "payment_request.paid",
      "payment_request.expired",
      "payment_request.cancelled",
    ]);
    // Payment-request events are opt-in by listing, like the order events:
    // an endpoint registered without an explicit `events` list gets only
    // the email delivery defaults.
    for (const eventType of PAYMENT_REQUEST_WEBHOOK_EVENT_TYPES) {
      expect(DEFAULT_EMAIL_WEBHOOK_EVENT_TYPES).not.toContain(eventType);
    }
  });

  it("order events are listed verbatim at registration", async () => {
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      expect(JSON.parse(init.body)).toEqual({
        url: "https://hooks.example.com/otok",
        events: ["order.created", "order.paid", "order.refunded"],
      });
      return json(201, { id: "we-1", secret: "whsec_x" });
    });
    const otok = makeClient(fetchMock as any);
    await otok.webhookEndpoints.create({
      url: "https://hooks.example.com/otok",
      events: ["order.created", "order.paid", "order.refunded"],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("campaigns.execute", () => {
  it("treats HTTP 200 as success and returns the queued-job body", async () => {
    const fetchMock = vi.fn(async () =>
      json(200, {
        success: true,
        message: "Campaign queued for execution",
        jobId: "execute-c1",
      }),
    );
    const otok = makeClient(fetchMock as any);
    const result = await otok.campaigns.execute("c1");
    expect(result.success).toBe(true);
    expect(result.jobId).toBe("execute-c1");
    const [url, init] = fetchMock.mock.calls[0] as [any, any];
    expect(String(url)).toBe("https://example.test/api/v1/campaigns/c1/execute");
    expect(init.method).toBe("POST");
  });

  it("throws OtokApiError 409 campaign_not_scheduled instead of success: false", async () => {
    const fetchMock = vi.fn(async () =>
      json(409, {
        error: {
          code: "campaign_not_scheduled",
          message:
            "Campaign status is 'draft' — only 'scheduled' campaigns can be executed",
        },
      }),
    );
    const otok = makeClient(fetchMock as any);
    const err = await otok.campaigns.execute("c1").catch((e) => e);
    expect(err).toBeInstanceOf(OtokApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe("campaign_not_scheduled");
  });

  it("throws OtokApiError 404 campaign_not_found for an unknown id", async () => {
    const fetchMock = vi.fn(async () =>
      json(404, {
        error: { code: "campaign_not_found", message: "Campaign not found" },
      }),
    );
    const otok = makeClient(fetchMock as any);
    const err = await otok.campaigns.execute("nope").catch((e) => e);
    expect(err).toBeInstanceOf(OtokApiError);
    expect(err.status).toBe(404);
    expect(err.code).toBe("campaign_not_found");
  });
});

describe("contact notes", () => {
  it("issues the documented verb + path + body for each notes method", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (url: any, init: any) => {
      calls.push({
        method: init.method,
        path: new URL(String(url)).pathname,
        body: init.body === undefined ? undefined : JSON.parse(init.body),
      });
      return json(200, { id: "n-1" });
    });
    const otok = makeClient(fetchMock as any);

    await otok.contacts.listNotes("c-1");
    await otok.contacts.createNote("c-1", "Asked for a demo", { pinned: true });
    await otok.contacts.updateNote("n-1", { body: "Edited" });
    await otok.contacts.deleteNote("n-1");

    expect(calls).toEqual([
      { method: "GET", path: "/api/v1/contacts/c-1/notes", body: undefined },
      {
        method: "POST",
        path: "/api/v1/contacts/c-1/notes",
        body: { body: "Asked for a demo", pinned: true },
      },
      { method: "PATCH", path: "/api/v1/notes/n-1", body: { body: "Edited" } },
      { method: "DELETE", path: "/api/v1/notes/n-1", body: undefined },
    ]);
  });

  it("createNote omits pinned when not provided", async () => {
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      expect(JSON.parse(init.body)).toEqual({ body: "Plain note" });
      return json(201, { id: "n-2", body: "Plain note", pinned_at: null });
    });
    const otok = makeClient(fetchMock as any);
    const note = await otok.contacts.createNote("c-1", "Plain note");
    expect(note.id).toBe("n-2");
  });

  it("listNotes returns the bare array (unpaginated endpoint)", async () => {
    const rows = [
      { id: "n-1", body: "pinned", pinned_at: "2026-07-14T10:00:00.000Z" },
      { id: "n-2", body: "newest", pinned_at: null },
    ];
    const fetchMock = vi.fn(async () => json(200, rows));
    const otok = makeClient(fetchMock as any);
    const notes = await otok.contacts.listNotes("c-1");
    expect(notes).toEqual(rows);
  });

  it("deleteNote resolves the success body", async () => {
    const fetchMock = vi.fn(async () => json(200, { success: true }));
    const otok = makeClient(fetchMock as any);
    await expect(otok.contacts.deleteNote("n-1")).resolves.toEqual({
      success: true,
    });
  });
});

describe("duplicate marker on idempotent creates", () => {
  it("passes duplicate through on contacts.upsert", async () => {
    const fetchMock = vi.fn(async (_url: any, init: any) =>
      json(201, {
        id: "contact-1",
        duplicate: true,
        ...JSON.parse(init.body),
      }),
    );
    const otok = makeClient(fetchMock as any);
    const contact = await otok.contacts.upsert({ email: "jane@example.com" });
    expect(contact.duplicate).toBe(true);
  });

  it("passes duplicate through on payments.create", async () => {
    const fetchMock = vi.fn(async () =>
      json(201, {
        id: "payment-1",
        type: "one_time",
        duplicate: true,
        external_reference: "order:A-1001",
      }),
    );
    const otok = makeClient(fetchMock as any);
    const payment = await otok.payments.create({
      contact_id: "contact-1",
      type: "one_time",
      amount: 100,
      external_reference: "order:A-1001",
    });
    expect(payment.duplicate).toBe(true);
  });

  it("passes duplicate through on bookings.create", async () => {
    const fetchMock = vi.fn(async () =>
      json(201, { id: "booking-1", status: "confirmed", duplicate: true }),
    );
    const otok = makeClient(fetchMock as any);
    const booking = await otok.bookings.create({
      meeting_type_id: "mt-1",
      start_at: "2026-08-01T09:00:00Z",
      timezone: "America/New_York",
      contact_id: "contact-1",
    });
    expect(booking.duplicate).toBe(true);
  });
});

describe("orders", () => {
  it("list serializes every documented filter", async () => {
    const fetchMock = vi.fn(async (url: any) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe("/api/v1/orders");
      expect(Object.fromEntries(parsed.searchParams)).toEqual({
        status: "paid",
        contact_id: "5f9f1b9b-0000-4000-8000-000000000001",
        source: "api",
        store_connection_id: "5f9f1b9b-0000-4000-8000-000000000002",
        external_reference: "shop:1001",
        placed_from: "2026-07-01T00:00:00Z",
        placed_to: "2026-07-31T23:59:59Z",
        limit: "10",
        offset: "20",
      });
      return json(200, { data: [], total: 0, limit: 10, offset: 20 });
    });
    const otok = makeClient(fetchMock as any);
    await otok.orders.list({
      status: "paid",
      contact_id: "5f9f1b9b-0000-4000-8000-000000000001",
      source: "api",
      store_connection_id: "5f9f1b9b-0000-4000-8000-000000000002",
      external_reference: "shop:1001",
      placed_from: "2026-07-01T00:00:00Z",
      placed_to: "2026-07-31T23:59:59Z",
      limit: 10,
      offset: 20,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("issues the documented verb + path + body for each write method", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (url: any, init: any) => {
      calls.push({
        method: init.method,
        path: new URL(String(url)).pathname,
        body: init.body === undefined ? undefined : JSON.parse(init.body),
      });
      return json(201, { id: "o-1" });
    });
    const otok = makeClient(fetchMock as any);

    await otok.orders.create({
      email: "jane@example.com",
      items: [
        { title: "Widget", unit_price: 170, quantity: 2 },
        { product_sku: "SKU-1" },
      ],
      shipping_total: 20,
      financial_status: "paid",
      external_reference: "shop:1001",
    });
    await otok.orders.get("o-1");
    await otok.orders.createRefund("o-1", {
      amount: 50,
      external_refund_id: "refund-77",
      reason: "Damaged",
    });
    await otok.orders.markPaid("o-1");
    await otok.orders.markPaid("o-1", { payment_reference: "inv-1001" });
    await otok.orders.cancel("o-1");

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/v1/orders",
        body: {
          email: "jane@example.com",
          items: [
            { title: "Widget", unit_price: 170, quantity: 2 },
            { product_sku: "SKU-1" },
          ],
          shipping_total: 20,
          financial_status: "paid",
          external_reference: "shop:1001",
        },
      },
      { method: "GET", path: "/api/v1/orders/o-1", body: undefined },
      {
        method: "POST",
        path: "/api/v1/orders/o-1/refunds",
        body: { amount: 50, external_refund_id: "refund-77", reason: "Damaged" },
      },
      { method: "POST", path: "/api/v1/orders/o-1/mark-paid", body: {} },
      {
        method: "POST",
        path: "/api/v1/orders/o-1/mark-paid",
        body: { payment_reference: "inv-1001" },
      },
      // No request body on cancel.
      { method: "POST", path: "/api/v1/orders/o-1/cancel", body: undefined },
    ]);
  });

  it("create carries no top-level duplicate marker", async () => {
    // Unlike contacts/deals/payments/bookings, both create and
    // upsert-match answer 201 with the same full-order body — the only
    // signals are created_at or a pre-check by external_reference.
    const fetchMock = vi.fn(async () =>
      json(201, {
        id: "o-1",
        external_reference: "shop:1001",
        financial_status: "paid",
        total: 360,
        items: [],
        refunds: [],
        created_at: "2026-07-15T00:00:00.000Z",
      }),
    );
    const otok = makeClient(fetchMock as any);
    const order = await otok.orders.create({
      contact_id: "c-1",
      external_reference: "shop:1001",
    });
    expect("duplicate" in order).toBe(false);
    expect(order.created_at).toBe("2026-07-15T00:00:00.000Z");
  });

  it("refund replay surfaces the duplicate marker", async () => {
    // A repeat POST with the same external_refund_id applies nothing and
    // returns the current order state with duplicate: true.
    const fetchMock = vi.fn(async () =>
      json(201, {
        duplicate: true,
        order: {
          id: "o-1",
          financial_status: "partially_refunded",
          refunded_total: 50,
        },
      }),
    );
    const otok = makeClient(fetchMock as any);
    const result = await otok.orders.createRefund("o-1", {
      amount: 50,
      external_refund_id: "refund-77",
    });
    expect(result.duplicate).toBe(true);
    expect(result.order.id).toBe("o-1");
    expect(result.order.financial_status).toBe("partially_refunded");
  });

  it("refunding a never-paid order throws a typed 400", async () => {
    const fetchMock = vi.fn(async () =>
      json(400, {
        statusCode: 400,
        error: "Bad Request",
        error_code: "ORDER_NEVER_PAID",
        message: "Cannot refund an order that was never paid.",
      }),
    );
    const otok = makeClient(fetchMock as any);
    const err = await otok.orders
      .createRefund("o-1", { amount: 50 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(OtokApiError);
    expect(err.status).toBe(400);
    expect(err.code).toBe("ORDER_NEVER_PAID");
  });

  it("feature-gate 403 maps to a typed error", async () => {
    const fetchMock = vi.fn(async () =>
      json(403, {
        message:
          "Your current plan does not include access to this feature: orders. Please upgrade your plan.",
        error_code: "FEATURE_NOT_INCLUDED_IN_PLAN",
      }),
    );
    const otok = makeClient(fetchMock as any);
    const err = await otok.orders.list().catch((e) => e);
    expect(err).toBeInstanceOf(OtokApiError);
    expect(err.status).toBe(403);
    expect(err.code).toBe("FEATURE_NOT_INCLUDED_IN_PLAN");
  });

  it("markPaid surfaces the typed transition and reference codes", async () => {
    // Refund states are set by recording refunds, never by mark-paid.
    const responses = [
      json(409, {
        statusCode: 409,
        error: "Conflict",
        error_code: "ORDER_ILLEGAL_TRANSITION",
        message:
          "Illegal status transition refunded → paid. Refund states are set by recording refunds.",
      }),
      json(404, {
        statusCode: 404,
        error: "Not Found",
        error_code: "ORDER_PAYMENT_REFERENCE_NOT_FOUND",
        message: "No payment matches the provided payment_reference.",
      }),
      json(409, {
        statusCode: 409,
        error: "Conflict",
        error_code: "ORDER_PAYMENT_ALREADY_LINKED",
        message: "The order is already linked to a different payment reference.",
      }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    const otok = makeClient(fetchMock as any);

    let err = await otok.orders.markPaid("o-1").catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.code).toBe("ORDER_ILLEGAL_TRANSITION");

    err = await otok.orders
      .markPaid("o-1", { payment_reference: "inv-x" })
      .catch((e) => e);
    expect(err.status).toBe(404);
    expect(err.code).toBe("ORDER_PAYMENT_REFERENCE_NOT_FOUND");

    err = await otok.orders
      .markPaid("o-1", { payment_reference: "inv-y" })
      .catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.code).toBe("ORDER_PAYMENT_ALREADY_LINKED");
  });
});

describe("payment requests", () => {
  it("list serializes every documented filter", async () => {
    const fetchMock = vi.fn(async (url: any) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe("/api/v1/payment-requests");
      expect(Object.fromEntries(parsed.searchParams)).toEqual({
        status: "pending",
        contact_id: "5f9f1b9b-0000-4000-8000-000000000001",
        deal_id: "5f9f1b9b-0000-4000-8000-000000000002",
        limit: "10",
        offset: "20",
      });
      return json(200, { data: [], total: 0, limit: 10, offset: 20 });
    });
    const otok = makeClient(fetchMock as any);
    await otok.paymentRequests.list({
      status: "pending",
      contact_id: "5f9f1b9b-0000-4000-8000-000000000001",
      deal_id: "5f9f1b9b-0000-4000-8000-000000000002",
      limit: 10,
      offset: 20,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("issues the documented verb + path + body for each method", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (url: any, init: any) => {
      calls.push({
        method: init.method,
        path: new URL(String(url)).pathname,
        body: init.body === undefined ? undefined : JSON.parse(init.body),
      });
      return json(201, { id: "pr-1" });
    });
    const otok = makeClient(fetchMock as any);

    await otok.paymentRequests.create({
      phone: "+972501234567",
      name: "Dana Levi",
      amount: 250,
      currency: "ILS",
      title: "Onboarding session",
      vat_mode: "inclusive",
      vat_rate: 18,
    });
    await otok.paymentRequests.get("pr-1");
    await otok.paymentRequests.cancel("pr-1");

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/v1/payment-requests",
        body: {
          phone: "+972501234567",
          name: "Dana Levi",
          amount: 250,
          currency: "ILS",
          title: "Onboarding session",
          vat_mode: "inclusive",
          vat_rate: 18,
        },
      },
      { method: "GET", path: "/api/v1/payment-requests/pr-1", body: undefined },
      // No request body on cancel.
      {
        method: "POST",
        path: "/api/v1/payment-requests/pr-1/cancel",
        body: undefined,
      },
    ]);
  });

  it("create returns pay_url plus checkout diagnostics (no duplicate marker — not idempotent)", async () => {
    // There is no idempotency key on this resource: a repeat POST mints a
    // second payable link, so no `duplicate` field can exist.
    const fetchMock = vi.fn(async () =>
      json(201, {
        id: "pr-1",
        status: "pending",
        charge_kind: "checkout",
        amount: 250,
        currency: "ILS",
        pay_url: "https://app.otok.io/pay/pr_tok",
        checkout_url: "https://provider.example/checkout/1",
        checkout_error: null,
      }),
    );
    const otok = makeClient(fetchMock as any);
    const request = await otok.paymentRequests.create({
      contact_id: "c-1",
      amount: 250,
    });
    expect("duplicate" in request).toBe(false);
    expect(request.pay_url).toBe("https://app.otok.io/pay/pr_tok");
    expect(request.checkout_url).toBe("https://provider.example/checkout/1");
    expect(request.checkout_error).toBeNull();
  });

  it("create surfaces the NO_PAYMENT_PROVIDER code", async () => {
    const fetchMock = vi.fn(async () =>
      json(400, {
        statusCode: 400,
        error: "Bad Request",
        error_code: "NO_PAYMENT_PROVIDER",
        message:
          "No payment provider is connected — connect Cardcom or Sumit in Settings → Integrations first.",
      }),
    );
    const otok = makeClient(fetchMock as any);
    const err = await otok.paymentRequests
      .create({ contact_id: "c-1", amount: 100 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(OtokApiError);
    expect(err.status).toBe(400);
    expect(err.code).toBe("NO_PAYMENT_PROVIDER");
  });

  it("cancel surfaces the typed 409s (final rows; saved-card rows)", async () => {
    const responses = [
      json(409, {
        statusCode: 409,
        error: "Conflict",
        message: "Only pending payment requests can be cancelled",
      }),
      json(409, {
        statusCode: 409,
        error: "Conflict",
        error_code: "TOKEN_REQUEST_NOT_CANCELLABLE",
        message:
          "Direct saved-card charges cannot be cancelled — the charge orchestration resolves them",
      }),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    const otok = makeClient(fetchMock as any);

    let err = await otok.paymentRequests.cancel("pr-1").catch((e) => e);
    expect(err).toBeInstanceOf(OtokApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBeUndefined();

    err = await otok.paymentRequests.cancel("pr-2").catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.code).toBe("TOKEN_REQUEST_NOT_CANCELLABLE");
  });

  it("feature-gate 403 embeds the workspace_payments feature id", async () => {
    // Pay-links are gated by `workspace_payments`, NOT the `payments`
    // ledger feature — the message embeds whichever id is missing.
    const fetchMock = vi.fn(async () =>
      json(403, {
        message:
          "Your current plan does not include access to this feature: workspace_payments. Please upgrade your plan.",
        error_code: "FEATURE_NOT_INCLUDED_IN_PLAN",
      }),
    );
    const otok = makeClient(fetchMock as any);
    const err = await otok.paymentRequests.list().catch((e) => e);
    expect(err).toBeInstanceOf(OtokApiError);
    expect(err.status).toBe(403);
    expect(err.code).toBe("FEATURE_NOT_INCLUDED_IN_PLAN");
  });
});

describe("contact documents", () => {
  it("defaults to a stored-only read (no live param on the wire)", async () => {
    const fetchMock = vi.fn(async (url: any) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe("/api/v1/contacts/c-1/documents");
      expect(Object.fromEntries(parsed.searchParams)).toEqual({});
      return json(200, {
        documents: [],
        live: { attempted: false, ok: true, complete: true, error: null },
      });
    });
    const otok = makeClient(fetchMock as any);
    const result = await otok.contacts.listDocuments("c-1");
    expect(result.live.attempted).toBe(false);
    expect(result.documents).toEqual([]);
  });

  it("serializes the live opt-in and returns the merged listing", async () => {
    const fetchMock = vi.fn(async (url: any) => {
      const parsed = new URL(String(url));
      expect(Object.fromEntries(parsed.searchParams)).toEqual({ live: "true" });
      return json(200, {
        documents: [
          {
            key: "sumit:123456",
            kind: "tax_invoice_receipt",
            rawType: null,
            isCredit: false,
            provider: "sumit",
            documentId: "123456",
            number: "2043",
            url: null, // legacy number-only rows have no URL — callers must check
            date: "2026-07-14T10:00:00.000Z",
            amount: 350,
            currency: "ILS",
            origin: "merged",
            sources: [
              { type: "contact_payment", id: "p-1" },
              { type: "provider", provider: "sumit" },
            ],
          },
        ],
        live: { attempted: true, ok: true, complete: true, error: null },
      });
    });
    const otok = makeClient(fetchMock as any);
    const result = await otok.contacts.listDocuments("c-1", { live: true });
    expect(result.live.attempted).toBe(true);
    expect(result.documents[0]!.kind).toBe("tax_invoice_receipt");
    expect(result.documents[0]!.url).toBeNull();
  });

  it("404s exactly like contacts.get for an unknown contact", async () => {
    const fetchMock = vi.fn(async () =>
      json(404, {
        statusCode: 404,
        error: "Not Found",
        message: "contacts with ID c-missing not found",
      }),
    );
    const otok = makeClient(fetchMock as any);
    const err = await otok.contacts.listDocuments("c-missing").catch((e) => e);
    expect(err).toBeInstanceOf(OtokApiError);
    expect(err.status).toBe(404);
  });
});
