import { describe, expect, it, vi } from "vitest";
import { OtokApiError, OtokTimeoutError } from "../src/errors";
import { HttpClient, computeBackoffMs, DEFAULT_BASE_URL } from "../src/http";

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeClient(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return new HttpClient({
    apiKey: "otok_live_testkey",
    baseUrl: "https://example.test/api",
    maxRetries: 2,
    ...extra,
    fetch: fetchImpl,
  });
}

describe("HttpClient request basics", () => {
  it("sends auth header, JSON body and serialized query params", async () => {
    const fetchMock = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toBe(
        "https://example.test/api/v1/contacts?filter=%7B%22lifecycle_stage%22%3A%22lead%22%7D&limit=10",
      );
      expect(init.method).toBe("GET");
      expect(init.headers.Authorization).toBe("Bearer otok_live_testkey");
      return jsonResponse(200, { data: [], total: 0, limit: 10, offset: 0 });
    });
    const client = makeClient(fetchMock as any);
    const result = await client.request("GET", "/v1/contacts", {
      query: {
        filter: JSON.stringify({ lifecycle_stage: "lead" }),
        limit: 10,
        search: undefined, // omitted
      },
    });
    expect(result).toEqual({ data: [], total: 0, limit: 10, offset: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("POSTs a JSON body with content-type", async () => {
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      expect(init.headers["Content-Type"]).toBe("application/json");
      expect(JSON.parse(init.body)).toEqual({ email: "a@b.co" });
      return jsonResponse(201, { id: "c1" });
    });
    const client = makeClient(fetchMock as any);
    const result = await client.request<{ id: string }>("POST", "/v1/contacts", {
      body: { email: "a@b.co" },
    });
    expect(result.id).toBe("c1");
  });

  it("returns undefined for 204 responses", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const client = makeClient(fetchMock as any);
    await expect(
      client.request("DELETE", "/v1/webhook-endpoints/x"),
    ).resolves.toBeUndefined();
  });

  it("has a sensible default base URL", () => {
    expect(DEFAULT_BASE_URL).toMatch(/^https:\/\/.+\/api$/);
  });
});

describe("HttpClient retries", () => {
  it("retries on 429 (respecting Retry-After: 0) and then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(429, { message: "Too many requests" }, { "retry-after": "0" }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const client = makeClient(fetchMock as any);
    const result = await client.request("GET", "/v1/tags");
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on 5xx and surfaces the last error after exhausting retries", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(503, { message: "unavailable" }, { "retry-after": "0" }),
    );
    const client = makeClient(fetchMock as any);
    const err = await client.request("GET", "/v1/tags").catch((e) => e);
    expect(err).toBeInstanceOf(OtokApiError);
    expect(err.status).toBe(503);
    // 1 initial + 2 retries
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry non-retryable statuses (400)", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(400, { statusCode: 400, message: ["name must be a string"] }),
    );
    const client = makeClient(fetchMock as any);
    const err = await client.request("POST", "/v1/tags", { body: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(OtokApiError);
    expect(err.status).toBe(400);
    expect(err.message).toBe("name must be a string");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("parses the domain error envelope { error: { code, message } }", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(404, {
        error: { code: "endpoint_not_found", message: "Webhook endpoint not found" },
      }),
    );
    const client = makeClient(fetchMock as any);
    const err = await client
      .request("DELETE", "/v1/webhook-endpoints/nope")
      .catch((e) => e);
    expect(err).toBeInstanceOf(OtokApiError);
    expect(err.status).toBe(404);
    expect(err.code).toBe("endpoint_not_found");
    expect(err.message).toBe("Webhook endpoint not found");
    expect(err.body).toEqual({
      error: { code: "endpoint_not_found", message: "Webhook endpoint not found" },
    });
  });

  it("respects maxRetries: 0", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(500, {}));
    const client = makeClient(fetchMock as any, { maxRetries: 0 });
    await expect(client.request("GET", "/v1/tags")).rejects.toBeInstanceOf(
      OtokApiError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("HttpClient error_code mapping", () => {
  it("surfaces a top-level error_code as code (403 plan-feature gating)", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(403, {
        message:
          "Your current plan does not include access to this feature: deals. Please upgrade your plan.",
        error_code: "FEATURE_NOT_INCLUDED_IN_PLAN",
      }),
    );
    const client = makeClient(fetchMock as any);
    const err = await client.request("GET", "/v1/deals").catch((e) => e);
    expect(err).toBeInstanceOf(OtokApiError);
    expect(err.status).toBe(403);
    expect(err.code).toBe("FEATURE_NOT_INCLUDED_IN_PLAN");
    // 403 is not retryable.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces CONTACT_MERGE_REQUIRED and keeps merge_request_id on the body", async () => {
    const wireBody = {
      statusCode: 409,
      error: "Conflict", // string, NOT the domain envelope
      error_code: "CONTACT_MERGE_REQUIRED",
      merge_request_id: "8b6f2f6e-4a86-4e58-9f9d-6a1f4b7f2c10",
      message:
        "This change would give the contact a phone or email that already belongs to another contact. A merge request was opened — resolve it (merge or dismiss) to apply the change.",
    };
    const fetchMock = vi.fn(async () => jsonResponse(409, wireBody));
    const client = makeClient(fetchMock as any);
    const err = await client
      .request("PATCH", "/v1/contacts/c1", { body: { phone: "+12025551234" } })
      .catch((e) => e);
    expect(err).toBeInstanceOf(OtokApiError);
    expect(err.status).toBe(409);
    expect(err.code).toBe("CONTACT_MERGE_REQUIRED");
    expect(err.message).toBe(wireBody.message);
    expect((err.body as any).merge_request_id).toBe(wireBody.merge_request_id);
  });
});

describe("HttpClient timeout", () => {
  it("aborts a hanging request and throws OtokTimeoutError", async () => {
    const hangingFetch = vi.fn(
      (_url: any, init: any) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    );
    const client = makeClient(hangingFetch as any, { timeoutMs: 30 });
    await expect(client.request("GET", "/v1/tags")).rejects.toBeInstanceOf(
      OtokTimeoutError,
    );
  });
});

describe("computeBackoffMs", () => {
  it("uses Retry-After delta-seconds when present", () => {
    expect(computeBackoffMs(0, "3")).toBe(3000);
    expect(computeBackoffMs(5, "1")).toBe(1000);
  });

  it("uses an HTTP-date Retry-After when present", () => {
    const inTwoSeconds = new Date(Date.now() + 2000).toUTCString();
    const ms = computeBackoffMs(0, inTwoSeconds);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(2000);
  });

  it("falls back to exponential backoff with full jitter", () => {
    // random() = 1 → the full cap for the attempt: 500 * 2^attempt.
    expect(computeBackoffMs(0, null, () => 1)).toBe(500);
    expect(computeBackoffMs(1, null, () => 1)).toBe(1000);
    expect(computeBackoffMs(2, null, () => 1)).toBe(2000);
    // random() = 0 → immediate.
    expect(computeBackoffMs(3, null, () => 0)).toBe(0);
  });

  it("caps the backoff at 30s", () => {
    expect(computeBackoffMs(20, null, () => 1)).toBe(30_000);
    expect(computeBackoffMs(0, "3600")).toBe(30_000);
  });

  it("ignores an unparseable Retry-After", () => {
    expect(computeBackoffMs(0, "soon", () => 1)).toBe(500);
  });
});
