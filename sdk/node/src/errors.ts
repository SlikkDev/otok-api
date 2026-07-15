/**
 * Error thrown for any non-2xx API response (after retries are exhausted).
 *
 * `code` is surfaced from either machine-readable spot the API uses:
 *
 * - the domain envelope `{ error: { code, message } }` — e.g.
 *   `endpoint_not_found`, `SLOT_TAKEN`, `campaign_not_found`,
 *   `campaign_not_scheduled`;
 * - a top-level `error_code` field on the standard shape — e.g.
 *   `FEATURE_NOT_INCLUDED_IN_PLAN` (403: the workspace's plan lacks the
 *   feature behind the endpoint group — Deals, Payments, Campaigns, or
 *   Booking) and `CONTACT_MERGE_REQUIRED` (409 on contact updates whose
 *   phone/email belongs to another contact; the parked request's
 *   `merge_request_id` is on `body`).
 *
 * Plain validation 400s (including mistyped list `filter` values),
 * duplicate-name 409s (tags/contact groups), throttling 429s, and auth 401s
 * carry no code. Key your handling on `status` (+ `code` when present),
 * never on the human-readable message.
 */
export class OtokApiError extends Error {
  /** HTTP status code of the failed response. */
  readonly status: number;
  /**
   * Machine-readable error code, when present — from the
   * `{ error: { code } }` envelope or a top-level `error_code` field.
   */
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
