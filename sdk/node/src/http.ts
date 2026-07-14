import { OtokApiError, OtokTimeoutError } from "./errors";

export interface HttpClientOptions {
  /** API key (`otok_live_…`), sent as `Authorization: Bearer <key>`. */
  apiKey: string;
  /**
   * Base URL of the oToK API, **including** the `/api` path segment,
   * e.g. `https://app.otok.io/api` or `https://your-otok-host/api`.
   * Endpoint paths (`/v1/...`) are appended to it.
   */
  baseUrl?: string;
  /** Per-attempt request timeout in milliseconds. Default 30 000. */
  timeoutMs?: number;
  /**
   * Retry attempts after the first request (429 and 5xx responses only).
   * Default 2 (i.e. up to 3 requests total). Set 0 to disable retries.
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
const SDK_VERSION = "0.1.0";

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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Minimal HTTP layer over native fetch: auth header injection, JSON
 * (de)serialization, per-attempt timeout via AbortController, and
 * exponential-backoff retries on 429/5xx respecting `Retry-After`.
 */
export class HttpClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpClientOptions) {
    if (!options.apiKey) throw new Error("otok-node: apiKey is required");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "User-Agent": `otok-node/${SDK_VERSION}`,
    };
    let bodyText: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyText = JSON.stringify(options.body);
    }

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Network failures and timeouts are not retried in v0.1 — not every
      // endpoint is idempotent, and a request may have reached the server.
      const response = await this.fetchWithTimeout(url, {
        method,
        headers,
        body: bodyText,
      });

      if (response.ok) {
        return (await parseBody(response)) as T;
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
    throw new Error("otok-node: retry loop exited unexpectedly");
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

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
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
    } else if (typeof b.message === "string") {
      // Framework shape: { statusCode, message, error }
      message = b.message;
    } else if (Array.isArray(b.message)) {
      message = b.message.join("; ");
    }
  }
  return new OtokApiError(response.status, message, code, body);
}
