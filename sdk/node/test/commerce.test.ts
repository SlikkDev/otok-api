import { describe, expect, it, vi } from "vitest";
import { OtokClient } from "../src/client";
import {
  customerToContactParams,
  orderExternalReference,
  orderReceiptIdempotencyKey,
} from "../src/commerce";

interface CapturedRequest {
  method: string;
  path: string;
  body: any;
}

/** Mock fetch that records requests and answers by path. */
function makeMockApi() {
  const requests: CapturedRequest[] = [];
  const fetchMock = vi.fn(async (url: any, init: any) => {
    const path = new URL(String(url)).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ method: init.method, path, body });

    if (init.method === "POST" && path === "/api/v1/contacts") {
      return json(200, { id: "contact-1", ...body });
    }
    if (init.method === "POST" && path === "/api/v1/deals") {
      return json(201, { id: "deal-1", status: "open", ...body });
    }
    if (init.method === "POST" && path === "/api/v1/emails") {
      return json(201, {
        id: "send-1",
        status: "sent",
        duplicate: false,
        to: body.to,
        idempotency_key: body.idempotency_key,
        provider_message_id: "prov-1",
        reason: null,
        created_at: "2026-07-14T00:00:00.000Z",
      });
    }
    return json(404, { error: { code: "not_found", message: "Not found" } });
  });
  return { fetchMock, requests };
}

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

describe("customerToContactParams", () => {
  it("maps camelCase customer fields to wire-format contact fields", () => {
    const params = customerToContactParams({
      email: "jane@example.com",
      phone: "+12025551234",
      firstName: "Jane",
      lastName: "Doe",
      tags: ["VIP"],
      groups: ["Customers"],
      address: { line1: "1 Main St", city: "Tel Aviv", postalCode: "12345" },
      customFields: { plan: "gold" },
      extra: { utm_source: "shop" },
    });
    expect(params).toEqual({
      email: "jane@example.com",
      phone: "+12025551234",
      first_name: "Jane",
      last_name: "Doe",
      tags: ["VIP"],
      groups: ["Customers"],
      address_line1: "1 Main St",
      city: "Tel Aviv",
      postal_code: "12345",
      custom_fields: { plan: "gold" },
      utm_source: "shop",
    });
  });

  it("requires at least an email or a phone", () => {
    expect(() => customerToContactParams({ name: "Nobody" })).toThrow(
      /email or a phone/,
    );
  });
});

describe("idempotency key derivation", () => {
  it("is deterministic per order", () => {
    expect(orderExternalReference("A-1001")).toBe("order:A-1001");
    expect(orderReceiptIdempotencyKey("A-1001")).toBe("order:A-1001:receipt");
  });
});

describe("commerce.identifyCustomer", () => {
  it("upserts via POST /v1/contacts", async () => {
    const { fetchMock, requests } = makeMockApi();
    const otok = makeClient(fetchMock as any);
    const contact = await otok.commerce.identifyCustomer({
      email: "jane@example.com",
      firstName: "Jane",
    });
    expect(contact.id).toBe("contact-1");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/contacts",
      body: { email: "jane@example.com", first_name: "Jane" },
    });
  });
});

describe("commerce.trackOrder", () => {
  it("upserts the contact, creates an idempotent deal, and sends one receipt", async () => {
    const { fetchMock, requests } = makeMockApi();
    const otok = makeClient(fetchMock as any);

    const result = await otok.commerce.trackOrder({
      orderId: "A-1001",
      customer: { email: "jane@example.com", name: "Jane Doe" },
      total: 249.9,
      currency: "USD",
      note: "2 items",
      receipt: { subject: "Your order A-1001", html: "<p>Thanks!</p>" },
    });

    expect(result.contact.id).toBe("contact-1");
    expect(result.deal.id).toBe("deal-1");
    expect(result.receipt?.id).toBe("send-1");

    expect(requests.map((r) => r.path)).toEqual([
      "/api/v1/contacts",
      "/api/v1/deals",
      "/api/v1/emails",
    ]);

    const dealBody = requests[1]!.body;
    expect(dealBody).toMatchObject({
      contact_id: "contact-1",
      title: "Order A-1001",
      amount: 249.9,
      currency: "USD",
      note: "2 items",
      external_reference: "order:A-1001",
    });

    const emailBody = requests[2]!.body;
    expect(emailBody).toMatchObject({
      to: "jane@example.com",
      subject: "Your order A-1001",
      idempotency_key: "order:A-1001:receipt",
      metadata: { order_id: "A-1001" },
    });
  });

  it("omits the title so it derives from the product when a SKU is attached", async () => {
    const { fetchMock, requests } = makeMockApi();
    const otok = makeClient(fetchMock as any);
    await otok.commerce.trackOrder({
      orderId: "A-2002",
      customer: { phone: "+12025551234" },
      total: 50,
      productSku: "SKU-1",
    });
    const dealBody = requests[1]!.body;
    expect(dealBody.product_sku).toBe("SKU-1");
    expect(dealBody.title).toBeUndefined();
  });

  it("skips the receipt when not requested", async () => {
    const { fetchMock, requests } = makeMockApi();
    const otok = makeClient(fetchMock as any);
    const result = await otok.commerce.trackOrder({
      orderId: "A-3003",
      customer: { email: "j@example.com" },
      total: 10,
    });
    expect(result.receipt).toBeUndefined();
    expect(requests.map((r) => r.path)).toEqual([
      "/api/v1/contacts",
      "/api/v1/deals",
    ]);
  });

  it("rejects a receipt without a customer email", async () => {
    const { fetchMock } = makeMockApi();
    const otok = makeClient(fetchMock as any);
    await expect(
      otok.commerce.trackOrder({
        orderId: "A-4004",
        customer: { phone: "+12025551234" },
        total: 10,
        receipt: { subject: "hi", text: "hello" },
      }),
    ).rejects.toThrow(/customer\.email/);
  });

  it("requires orderId", async () => {
    const { fetchMock } = makeMockApi();
    const otok = makeClient(fetchMock as any);
    await expect(
      otok.commerce.trackOrder({
        orderId: "",
        customer: { email: "j@example.com" },
        total: 10,
      }),
    ).rejects.toThrow(/orderId/);
  });
});
