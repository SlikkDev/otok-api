import { describe, expect, it, vi } from "vitest";
import { OtokClient } from "../src/client";
import { OtokApiError } from "../src/errors";
import {
  DEFAULT_EMAIL_WEBHOOK_EVENT_TYPES,
  EMAIL_WEBHOOK_EVENT_TYPES,
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
