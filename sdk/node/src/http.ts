import { OtokApiError, OtokTimeoutError } from "./errors";

export interface HttpClientOptions {
  /** API key (`otok_live_…`), sent as `Authorization: Bearer <key>`. */
  apiKey: string;
  /**
   * Base URL of the oToK API, **including** the `/api` path segment.
   * Defaults to `https://app.otok.io/api` — you normally don't need to set
   * this. Endpoint paths (`/v1/...`) are appended to it.
   */
  baseUrl?: string;
  /**
   * Per-attempt request timeout in milliseconds; covers connecting and,
   * for success responses, downloading the body. Default 30 000.
   */
  timeoutMs?: number;
  /**
   * Retry attempts after the first request. Default 2 (i.e. up to 3 requests
   * total). Set 0 to disable retries. Applies to 429/5xx responses (all
   * requests) and to transient network errors (safe or idempotency-keyed
   * requests only — see `isNetworkRetrySafe`).
   */
  maxRetries?: number;
  /** Injectable fetch implementation (used by tests). Defaults to global fetch. */
  fetch?: typeof fetch;
}

export const DEFAULT_BASE_URL = "https://app.otok.io/api";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
/** Base backoff delay; grows exponentially per retry with full jitter. */
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;
const SDK_VERSION = "0.5.0";

export type QueryValue = string | number | boolean | undefined;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
}

/**
 * Compute the delay before the next retry attempt.
 *
 * A `Retry-After` header (delta-seconds or HTTP-date), when present and
 * parseable, wins over the computed backoff. Otherwise exponential backoff
 * with full jitter: random(0, min(cap, base * 2^attempt)).
 *
 * @param attempt 0-based index of the retry being scheduled.
 */
export function computeBackoffMs(
  attempt: number,
  retryAfterHeader?: string | null,
  random: () => number = Math.random,
): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, BACKOFF_CAP_MS);
    }
    const dateMs = Date.parse(retryAfterHeader);
    if (!Number.isNaN(dateMs)) {
      return Math.min(Math.max(0, dateMs - Date.now()), BACKOFF_CAP_MS);
    }
  }
  const cap = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.floor(random() * cap);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Transport-level error codes treated as transient: connection
 * reset/refused/aborted, DNS failure, unreachable network, socket timeout.
 * Node's fetch (undici) usually wraps the socket error, so the code is
 * looked up on the thrown error, its `cause` chain, and any
 * `AggregateError` members.
 */
const TRANSIENT_NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * True when `err` is a transient transport-level failure (the request never
 * produced an HTTP response): a socket/DNS error carrying one of the
 * `TRANSIENT_NETWORK_ERROR_CODES`, anywhere in the `cause`/`errors` chain,
 * or an `OtokTimeoutError`.
 */
export function isTransientNetworkError(err: unknown, depth = 0): boolean {
  if (depth > 5 || !err || typeof err !== "object") return false;
  if (err instanceof OtokTimeoutError) return true;
  const e = err as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof e.code === "string" && TRANSIENT_NETWORK_ERROR_CODES.has(e.code)) {
    return true;
  }
  if (
    Array.isArray(e.errors) &&
    e.errors.some((inner) => isTransientNetworkError(inner, depth + 1))
  ) {
    return true;
  }
  return isTransientNetworkError(e.cause, depth + 1);
}

/**
 * Whether a request may be auto-retried after a transient NETWORK error.
 *
 * A network error is ambiguous — the request may or may not have reached
 * the server — so replaying it is only safe when a replay cannot
 * double-apply an effect: safe methods (GET/HEAD), or a write body that
 * carries its own idempotency key — `idempotency_key` (POST /v1/emails),
 * `external_reference` (POST /v1/deals, POST /v1/payments, POST
 * /v1/orders), or `external_refund_id` (POST /v1/orders/:id/refunds).
 * Everything else surfaces the network error to the caller — notably POST
 * /v1/payment-requests, which has NO idempotency key at all (a replay would
 * mint a second payable link), and POST /v1/bookings (its idempotency is
 * server-derived, not a body key). (429/5xx HTTP
 * responses are a different case — the server answered — and keep their
 * existing retry behavior for all requests.)
 */
export function isNetworkRetrySafe(method: string, body: unknown): boolean {
  if (method === "GET" || method === "HEAD") return true;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const b = body as Record<string, unknown>;
    for (const key of [
      "idempotency_key",
      "external_reference",
      "external_refund_id",
    ] as const) {
      const value = b[key];
      if (typeof value === "string" && value !== "") return true;
    }
  }
  return false;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Minimal HTTP layer over native fetch: auth header injection, JSON
 * (de)serialization, per-attempt timeout via AbortController, and
 * exponential-backoff retries — on 429/5xx respecting `Retry-After`, and on
 * transient network errors for safe/idempotency-keyed requests only.
 */
export class HttpClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpClientOptions) {
    if (!options.apiKey) throw new Error("@otok/node: apiKey is required");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "User-Agent": `@otok/node/${SDK_VERSION}`,
    };
    let bodyText: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyText = JSON.stringify(options.body);
    }

    const networkRetrySafe = isNetworkRetrySafe(method, options.body);

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let response: Response;
      let okBody: unknown;
      try {
        ({ response, okBody } = await this.performAttempt(url, {
          method,
          headers,
          body: bodyText,
        }));
      } catch (err) {
        // Transient transport-level failures (connection reset/refused, DNS
        // failure, socket timeout) — whether they hit while connecting or
        // while downloading a success response's body — share the 429/5xx
        // backoff, but only when replaying is safe (GET/HEAD or an
        // idempotency-keyed write). The request may have reached the
        // server, so non-idempotent writes are never network-retried; the
        // error surfaces to the caller instead.
        if (
          networkRetrySafe &&
          isTransientNetworkError(err) &&
          attempt < this.maxRetries
        ) {
          await sleep(computeBackoffMs(attempt));
          continue;
        }
        throw err;
      }

      if (response.ok) {
        return okBody as T;
      }

      if (isRetryableStatus(response.status) && attempt < this.maxRetries) {
        const delay = computeBackoffMs(
          attempt,
          response.headers.get("retry-after"),
        );
        await sleep(delay);
        continue;
      }

      throw await toApiError(response);
    }
    // Unreachable: the final loop iteration always returns or throws.
    throw new Error("@otok/node: retry loop exited unexpectedly");
  }

  private buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  /**
   * One request attempt under a single per-attempt timeout. fetch resolves
   * once response HEADERS arrive, so for success responses the body is
   * downloaded here too: a transient network failure or timeout while
   * streaming the body is indistinguishable from a connect-phase failure
   * and shares its retry/timeout semantics (the Python SDK likewise reads
   * the body inside its retried, timeout-bounded transport call).
   * Error-response bodies are NOT read here — the 429/5xx retry path needs
   * only headers, and `toApiError` reads the body on the terminal path.
   */
  private async performAttempt(
    url: string,
    init: RequestInit,
  ): Promise<{ response: Response; okBody?: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
      });
      if (!response.ok) return { response };
      return { response, okBody: await parseBody(response) };
    } catch (err) {
      if (controller.signal.aborted) throw new OtokTimeoutError(this.timeoutMs);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function toApiError(response: Response): Promise<OtokApiError> {
  const body = await parseBody(response);
  let code: string | undefined;
  let message = `HTTP ${response.status}`;
  if (body && typeof body === "object") {
    const b = body as Record<string, any>;
    // Domain envelope: { error: { code, message } }
    if (b.error && typeof b.error === "object") {
      code = typeof b.error.code === "string" ? b.error.code : undefined;
      if (typeof b.error.message === "string") message = b.error.message;
    } else {
      // Standard shape: { statusCode?, message, error? } — some carry a
      // machine-readable top-level error_code (FEATURE_NOT_INCLUDED_IN_PLAN,
      // CONTACT_MERGE_REQUIRED) plus extra fields (e.g. merge_request_id),
      // all kept on `body`.
      if (typeof b.message === "string") {
        message = b.message;
      } else if (Array.isArray(b.message)) {
        message = b.message.join("; ");
      }
      if (typeof b.error_code === "string") code = b.error_code;
    }
  }
  return new OtokApiError(response.status, message, code, body);
}
