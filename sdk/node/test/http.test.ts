import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    // POST without an idempotency key: timeouts are NOT retried, so the
    // error surfaces after the first attempt.
    const client = makeClient(hangingFetch as any, { timeoutMs: 30 });
    await expect(
      client.request("POST", "/v1/tags", { body: { name: "VIP" } }),
    ).rejects.toBeInstanceOf(OtokTimeoutError);
    expect(hangingFetch).toHaveBeenCalledTimes(1);
  });
});

describe("HttpClient network-error retries", () => {
  // Full-jitter backoff sleeps random(0, cap) — pin random to 0 so retried
  // requests re-fire immediately.
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function connectionError(code: string): Error {
    // Node's fetch (undici) throws TypeError("fetch failed") with the
    // socket error on `cause`.
    return new TypeError("fetch failed", {
      cause: Object.assign(new Error(code), { code }),
    });
  }

  it("retries a GET after a connection reset and succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(connectionError("ECONNRESET"))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const client = makeClient(fetchMock as any);
    await expect(client.request("GET", "/v1/tags")).resolves.toEqual({
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a GET on DNS failure (EAI_AGAIN) and connection refusal", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(connectionError("EAI_AGAIN"))
      .mockRejectedValueOnce(connectionError("ECONNREFUSED"))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const client = makeClient(fetchMock as any);
    await expect(client.request("GET", "/v1/tags")).resolves.toEqual({
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("finds the code inside an AggregateError cause (multi-address connect)", async () => {
    const aggregate = new AggregateError(
      [Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" })],
      "connect failed",
    );
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed", { cause: aggregate }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const client = makeClient(fetchMock as any);
    await expect(client.request("GET", "/v1/tags")).resolves.toEqual({
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a timed-out GET (safe method)", async () => {
    const hangingOnce = vi
      .fn()
      .mockImplementationOnce(
        (_url: any, init: any) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const client = makeClient(hangingOnce as any, { timeoutMs: 30 });
    await expect(client.request("GET", "/v1/tags")).resolves.toEqual({
      ok: true,
    });
    expect(hangingOnce).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a POST without an idempotency key", async () => {
    const fetchMock = vi.fn().mockRejectedValue(connectionError("ECONNRESET"));
    const client = makeClient(fetchMock as any);
    await expect(
      client.request("POST", "/v1/contacts", { body: { email: "a@b.co" } }),
    ).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a payment-request create (no idempotency key exists)", async () => {
    // POST /v1/payment-requests has NO idempotency key of any kind — a
    // replay would mint a second, independently payable link — so the
    // network error must surface after exactly one attempt (the same
    // posture as bookings.create, whose idempotency is server-derived).
    const fetchMock = vi.fn().mockRejectedValue(connectionError("ECONNRESET"));
    const client = makeClient(fetchMock as any);
    await expect(
      client.request("POST", "/v1/payment-requests", {
        body: { contact_id: "c-1", amount: 250, title: "Session" },
      }),
    ).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry PATCH/DELETE requests", async () => {
    const fetchMock = vi.fn().mockRejectedValue(connectionError("ECONNRESET"));
    const client = makeClient(fetchMock as any);
    await expect(
      client.request("PATCH", "/v1/contacts/c1", { body: { name: "Jane" } }),
    ).rejects.toThrow("fetch failed");
    await expect(
      client.request("DELETE", "/v1/webhook-endpoints/w1"),
    ).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a POST that carries idempotency_key (POST /v1/emails)", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(connectionError("ECONNRESET"))
      .mockResolvedValueOnce(jsonResponse(201, { id: "send-1" }));
    const client = makeClient(fetchMock as any);
    const result = await client.request<{ id: string }>("POST", "/v1/emails", {
      body: { to: "a@b.co", subject: "hi", text: "hi", idempotency_key: "k-1" },
    });
    expect(result.id).toBe("send-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a POST that carries external_reference (deals/payments upserts)", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(connectionError("ENOTFOUND"))
      .mockResolvedValueOnce(jsonResponse(201, { id: "deal-1" }));
    const client = makeClient(fetchMock as any);
    const result = await client.request<{ id: string }>("POST", "/v1/deals", {
      body: { title: "Order", external_reference: "order:A-1001" },
    });
    expect(result.id).toBe("deal-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a POST that carries external_refund_id (order refunds)", async () => {
    // A keyed order refund replays to duplicate: true server-side, so a
    // network retry can never double-apply it.
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(connectionError("ECONNRESET"))
      .mockResolvedValueOnce(
        jsonResponse(201, { duplicate: false, order: { id: "o-1" } }),
      );
    const client = makeClient(fetchMock as any);
    const result = await client.request<{ order: { id: string } }>(
      "POST",
      "/v1/orders/o-1/refunds",
      { body: { amount: 50, external_refund_id: "refund-77" } },
    );
    expect(result.order.id).toBe("o-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("an empty idempotency key does not make a POST retryable", async () => {
    const fetchMock = vi.fn().mockRejectedValue(connectionError("ECONNRESET"));
    const client = makeClient(fetchMock as any);
    await expect(
      client.request("POST", "/v1/emails", {
        body: { to: "a@b.co", subject: "hi", idempotency_key: "" },
      }),
    ).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry non-transient errors even on GET", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new TypeError("Invalid header value"));
    const client = makeClient(fetchMock as any);
    await expect(client.request("GET", "/v1/tags")).rejects.toThrow(
      "Invalid header value",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces the last network error after exhausting retries", async () => {
    const fetchMock = vi.fn().mockRejectedValue(connectionError("ETIMEDOUT"));
    const client = makeClient(fetchMock as any); // maxRetries: 2
    await expect(client.request("GET", "/v1/tags")).rejects.toThrow(
      "fetch failed",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("respects maxRetries: 0 for network errors", async () => {
    const fetchMock = vi.fn().mockRejectedValue(connectionError("ECONNRESET"));
    const client = makeClient(fetchMock as any, { maxRetries: 0 });
    await expect(client.request("GET", "/v1/tags")).rejects.toThrow(
      "fetch failed",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("HttpClient body-phase network failures", () => {
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Node's fetch (undici) resolves once response HEADERS arrive; if the
  // socket dies while the body is still streaming, reading the body rejects
  // with TypeError("terminated") carrying the socket error on `cause`.
  function bodyFailureResponse(code = "ECONNRESET"): Response {
    const err = Object.assign(new TypeError("terminated"), {
      cause: Object.assign(new Error(`read ${code}`), { code }),
    });
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"partial":'));
          controller.error(err);
        },
      }),
      { status: 200 },
    );
  }

  it("retries a GET whose response-body download fails transiently and succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(bodyFailureResponse())
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const client = makeClient(fetchMock as any);
    await expect(client.request("GET", "/v1/contacts")).resolves.toEqual({
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a non-keyed POST on a body-phase failure; the transport error surfaces", async () => {
    const fetchMock = vi.fn().mockResolvedValue(bodyFailureResponse("UND_ERR_SOCKET"));
    const client = makeClient(fetchMock as any);
    const err = await client
      .request("POST", "/v1/contacts", { body: { email: "a@b.co" } })
      .catch((e) => e);
    // Same posture as a connect-phase failure on a non-idempotent write
    // (and as the Python SDK): the transport error surfaces unretried.
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toBe("terminated");
    expect((err.cause as any).code).toBe("UND_ERR_SOCKET");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries an idempotency-keyed POST on a body-phase failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(bodyFailureResponse())
      .mockResolvedValueOnce(jsonResponse(201, { id: "send-1" }));
    const client = makeClient(fetchMock as any);
    const result = await client.request<{ id: string }>("POST", "/v1/emails", {
      body: { to: "a@b.co", subject: "hi", text: "hi", idempotency_key: "k-1" },
    });
    expect(result.id).toBe("send-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces the body-phase error after exhausting retries on a GET", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => bodyFailureResponse());
    const client = makeClient(fetchMock as any); // maxRetries: 2
    await expect(client.request("GET", "/v1/contacts")).rejects.toThrow(
      "terminated",
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("a body download that exceeds timeoutMs throws OtokTimeoutError", async () => {
    const hangingBodyFetch = vi.fn(
      async (_url: any, init: any) =>
        new Response(
          new ReadableStream({
            start(controller) {
              // Body head arrives but never completes; the stream errors
              // only when the per-attempt timer aborts the request.
              controller.enqueue(new TextEncoder().encode('{"partial":'));
              init.signal.addEventListener("abort", () =>
                controller.error(new DOMException("aborted", "AbortError")),
              );
            },
          }),
          { status: 200 },
        ),
    );
    // POST without an idempotency key: not retried, so the timeout surfaces
    // as the SDK's own error class after the first attempt.
    const client = makeClient(hangingBodyFetch as any, { timeoutMs: 30 });
    await expect(
      client.request("POST", "/v1/tags", { body: { name: "VIP" } }),
    ).rejects.toBeInstanceOf(OtokTimeoutError);
    expect(hangingBodyFetch).toHaveBeenCalledTimes(1);
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
