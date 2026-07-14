import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OtokWebhookVerificationError } from "../src/errors";
import {
  computeWebhookSignature,
  constructEvent,
  parseSignatureHeader,
  verifyWebhookSignature,
} from "../src/webhooks";

const SECRET = "whsec_testsecret_testsecret_testsecret_1234";
const NOW = 1_752_000_000;

function sign(body: string, timestamp = NOW, secret = SECRET): string {
  const v1 = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

const EVENT_BODY = JSON.stringify({
  id: "5f1e9c4a-0000-4000-8000-000000000001",
  type: "email.bounced",
  created_at: "2026-07-14T12:00:00.000Z",
  data: {
    send_id: "send-1",
    idempotency_key: "order:42:receipt",
    to: "jane@example.com",
    reason: "550 5.1.1 user unknown",
    bounce_type: "hard",
    metadata: { order_id: "42" },
  },
});

describe("verifyWebhookSignature", () => {
  it("accepts a valid signature", () => {
    expect(
      verifyWebhookSignature(EVENT_BODY, sign(EVENT_BODY), SECRET, { now: NOW }),
    ).toBe(true);
  });

  it("accepts a Buffer payload", () => {
    expect(
      verifyWebhookSignature(Buffer.from(EVENT_BODY), sign(EVENT_BODY), SECRET, {
        now: NOW,
      }),
    ).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const tampered = EVENT_BODY.replace("jane@", "eve@");
    expect(
      verifyWebhookSignature(tampered, sign(EVENT_BODY), SECRET, { now: NOW }),
    ).toBe(false);
  });

  it("rejects the wrong secret", () => {
    expect(
      verifyWebhookSignature(EVENT_BODY, sign(EVENT_BODY), "whsec_other", {
        now: NOW,
      }),
    ).toBe(false);
  });

  it("rejects an expired timestamp (default 5 min tolerance)", () => {
    const old = sign(EVENT_BODY, NOW - 301);
    expect(verifyWebhookSignature(EVENT_BODY, old, SECRET, { now: NOW })).toBe(
      false,
    );
    // Inside tolerance passes.
    const recent = sign(EVENT_BODY, NOW - 299);
    expect(
      verifyWebhookSignature(EVENT_BODY, recent, SECRET, { now: NOW }),
    ).toBe(true);
  });

  it("rejects timestamps too far in the future", () => {
    const future = sign(EVENT_BODY, NOW + 301);
    expect(
      verifyWebhookSignature(EVENT_BODY, future, SECRET, { now: NOW }),
    ).toBe(false);
  });

  it("honors a custom tolerance", () => {
    const old = sign(EVENT_BODY, NOW - 100);
    expect(
      verifyWebhookSignature(EVENT_BODY, old, SECRET, {
        now: NOW,
        toleranceSeconds: 60,
      }),
    ).toBe(false);
  });

  it("rejects malformed headers", () => {
    for (const header of ["", "t=abc,v1=00", "v1=00", `t=${NOW}`, "garbage"]) {
      expect(verifyWebhookSignature(EVENT_BODY, header, SECRET)).toBe(false);
    }
  });

  it("accepts when any of multiple v1 signatures matches", () => {
    const good = sign(EVENT_BODY);
    const withDecoy = `${good},v1=${"0".repeat(64)}`;
    expect(
      verifyWebhookSignature(EVENT_BODY, withDecoy, SECRET, { now: NOW }),
    ).toBe(true);
  });
});

describe("parseSignatureHeader", () => {
  it("parses timestamp and signatures", () => {
    const parsed = parseSignatureHeader(sign(EVENT_BODY));
    expect(parsed?.timestamp).toBe(NOW);
    expect(parsed?.signatures).toHaveLength(1);
  });

  it("returns null for non-hex signatures", () => {
    expect(parseSignatureHeader(`t=${NOW},v1=nothex`)).toBeNull();
  });
});

describe("computeWebhookSignature", () => {
  it("matches the documented scheme (hmac-sha256 of '{t}.{body}')", () => {
    const expected = createHmac("sha256", SECRET)
      .update(`${NOW}.${EVENT_BODY}`)
      .digest("hex");
    expect(computeWebhookSignature(SECRET, NOW, EVENT_BODY)).toBe(expected);
  });
});

describe("constructEvent", () => {
  it("returns the typed event for a valid signature", () => {
    const event = constructEvent(EVENT_BODY, sign(EVENT_BODY), SECRET, {
      now: NOW,
    });
    expect(event.type).toBe("email.bounced");
    if (event.type === "email.bounced") {
      expect(event.data.bounce_type).toBe("hard");
      expect(event.data.to).toBe("jane@example.com");
    }
  });

  it("throws on a missing header", () => {
    expect(() => constructEvent(EVENT_BODY, undefined, SECRET)).toThrow(
      OtokWebhookVerificationError,
    );
  });

  it("throws on an invalid signature", () => {
    expect(() =>
      constructEvent(EVENT_BODY, sign(EVENT_BODY, NOW, "whsec_bad"), SECRET, {
        now: NOW,
      }),
    ).toThrow(OtokWebhookVerificationError);
  });

  it("throws on a verified but non-JSON payload", () => {
    const body = "not json";
    expect(() =>
      constructEvent(body, sign(body), SECRET, { now: NOW }),
    ).toThrow(OtokWebhookVerificationError);
  });

  it("throws on a verified JSON payload that is not an event envelope", () => {
    const body = JSON.stringify({ hello: "world" });
    expect(() =>
      constructEvent(body, sign(body), SECRET, { now: NOW }),
    ).toThrow(OtokWebhookVerificationError);
  });
});
