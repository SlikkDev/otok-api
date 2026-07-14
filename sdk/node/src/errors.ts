/**
 * Error thrown for any non-2xx API response (after retries are exhausted).
 *
 * Domain endpoints use the machine-readable envelope
 * `{ error: { code, message } }` — `code` is surfaced here when present.
 * Framework-level errors (validation 400s, throttling 429s, auth 401s)
 * keep the platform's default shape; key your handling on `status`
 * (+ `code` when present), never on the human-readable message.
 */
export class OtokApiError extends Error {
  /** HTTP status code of the failed response. */
  readonly status: number;
  /** Machine-readable error code from the API error envelope, when present. */
  readonly code?: string;
  /** The parsed response body (JSON when possible, raw text otherwise). */
  readonly body?: unknown;

  constructor(status: number, message: string, code?: string, body?: unknown) {
    super(message);
    this.name = "OtokApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** Thrown when a request exceeds the configured timeout. */
export class OtokTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = "OtokTimeoutError";
  }
}

/** Thrown by `constructEvent` when a webhook signature cannot be verified. */
export class OtokWebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OtokWebhookVerificationError";
  }
}
