import { createHmac, timingSafeEqual } from "node:crypto";
import { OtokWebhookVerificationError } from "./errors";
import type { OtokWebhookEvent } from "./types";

export interface VerifyOptions {
  /**
   * Maximum allowed age (and future skew) of the signature timestamp, in
   * seconds. Default 300 (5 minutes). Retried deliveries carry fresh
   * timestamps, so a tight window is safe.
   */
  toleranceSeconds?: number;
  /** Override "now" (unix seconds) — for testing. */
  now?: number;
}

const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Signature scheme (`X-Otok-Signature: t=<unix seconds>,v1=<hex>`):
 *
 *   signed_payload = "<t>" + "." + <raw request body>
 *   v1 = lowercase hex( HMAC-SHA256( key = full whsec_… secret, msg = signed_payload ) )
 *
 * Verification MUST run against the raw request body bytes — parse-then-
 * re-stringify changes the bytes and breaks the signature.
 */
export function computeWebhookSignature(
  secret: string,
  timestampSeconds: number,
  payload: string | Buffer,
): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(`${timestampSeconds}.`);
  hmac.update(payload);
  return hmac.digest("hex");
}

interface ParsedSignatureHeader {
  timestamp: number;
  signatures: string[];
}

/** Parse `t=<unix>,v1=<hex>[,v1=<hex>…]`; returns null when malformed. */
export function parseSignatureHeader(
  header: string,
): ParsedSignatureHeader | null {
  if (typeof header !== "string" || !header) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) return null;
      timestamp = parsed;
    } else if (key === "v1" && /^[0-9a-f]{64}$/.test(value)) {
      signatures.push(value);
    }
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/**
 * Verify an oToK webhook signature. Returns `true` only when the header
 * parses, the timestamp is within tolerance, and an expected signature
 * matches (constant-time comparison).
 *
 * @param payload  The RAW request body (string or Buffer) — exactly as received.
 * @param signatureHeader  The `X-Otok-Signature` header value.
 * @param secret   The endpoint's `whsec_…` secret (full string, prefix included).
 */
export function verifyWebhookSignature(
  payload: string | Buffer,
  signatureHeader: string,
  secret: string,
  options: VerifyOptions = {},
): boolean {
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return false;

  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.timestamp) > tolerance) return false;

  const expected = computeWebhookSignature(secret, parsed.timestamp, payload);
  return parsed.signatures.some((sig) => constantTimeEqualHex(sig, expected));
}

/**
 * Verify the signature AND parse the body into a typed event — the
 * recommended entry point for webhook handlers:
 *
 * ```ts
 * const event = constructEvent(rawBody, req.headers["x-otok-signature"], secret);
 * switch (event.type) {
 *   case "email.bounced": … event.data.bounce_type …
 * }
 * ```
 *
 * Throws {@link OtokWebhookVerificationError} when verification or parsing
 * fails — respond 400 and let oToK retry (retries span ≈16 hours).
 */
export function constructEvent(
  payload: string | Buffer,
  signatureHeader: string | undefined,
  secret: string,
  options: VerifyOptions = {},
): OtokWebhookEvent {
  if (!secret) {
    throw new OtokWebhookVerificationError("Missing webhook signing secret");
  }
  if (!signatureHeader) {
    throw new OtokWebhookVerificationError("Missing X-Otok-Signature header");
  }
  if (!verifyWebhookSignature(payload, signatureHeader, secret, options)) {
    throw new OtokWebhookVerificationError(
      "Webhook signature verification failed",
    );
  }
  let event: unknown;
  try {
    event = JSON.parse(
      typeof payload === "string" ? payload : payload.toString("utf8"),
    );
  } catch {
    throw new OtokWebhookVerificationError("Webhook payload is not valid JSON");
  }
  if (
    !event ||
    typeof event !== "object" ||
    typeof (event as any).type !== "string" ||
    typeof (event as any).id !== "string"
  ) {
    throw new OtokWebhookVerificationError(
      "Webhook payload is not a recognized event envelope",
    );
  }
  return event as OtokWebhookEvent;
}
