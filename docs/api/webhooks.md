# Webhooks

Register HTTPS endpoints to receive delivery and engagement events for emails sent through [`POST /v1/emails`](emails.md). Events are signed, retried, and deduplicable by event id.

Webhook events fire **only for API-originated sends** (sends made with an idempotency key via `POST /v1/emails`); engagement events additionally require the send to have opted into `tracking`.

All management endpoints require [authentication](getting-started.md#authentication). Errors use the structured envelope `{"error": {"code", "message"}}`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/webhook-endpoints` | Register an endpoint (secret returned once) |
| GET | `/api/v1/webhook-endpoints` | List endpoints |
| DELETE | `/api/v1/webhook-endpoints/:id` | Delete an endpoint |

## POST /api/v1/webhook-endpoints

| Field | Type | Required | Constraints |
|---|---|---|---|
| `url` | string | yes | 1–2048 chars; `http://` or `https://` only. URLs pointing at private, loopback, link-local, and other reserved IP ranges are rejected (400 `unsafe_url`) — this is re-checked on every delivery attempt |
| `events` | string[] | no | Event types to receive (see table below). Must be non-empty when present. **Omitted → the four delivery events only** (`email.delivered`, `email.bounced`, `email.complained`, `email.failed`) — the engagement events `email.opened`/`email.clicked` are received only when explicitly listed |

**Maximum 3 endpoints per workspace** (409 `endpoint_limit_reached`). The cap is enforced safely under concurrency.

```bash
curl -X POST "https://app.otok.io/api/v1/webhook-endpoints" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://hooks.example.com/otok-email",
    "events": ["email.delivered", "email.bounced", "email.complained", "email.opened", "email.clicked"]
  }'
```

Response `201`:

```json
{
  "id": "c9b8a7d6-e5f4-0312-2130-4a5b6c7d8e9f",
  "url": "https://hooks.example.com/otok-email",
  "events": ["email.delivered", "email.bounced", "email.complained", "email.opened", "email.clicked"],
  "is_active": true,
  "secret": "whsec_XkQ2mP9rT5vW8yZ1aB4cD7eF0gH3jK6nL9qS2uV5xY8",
  "created_at": "2026-07-14T10:00:00.000Z"
}
```

> **The `secret` is returned only here, once.** Store it securely — it cannot be retrieved again. There is no rotation endpoint: to rotate, register a new endpoint with the same URL, switch verification to the new secret, then delete the old endpoint.

| Status | `error.code` | Meaning |
|---|---|---|
| 400 | `unsafe_url` | Non-http(s) scheme or a reserved/private address |
| 409 | `endpoint_limit_reached` | Already at 3 endpoints — delete one first |

## GET /api/v1/webhook-endpoints

No parameters (max 3 rows, unpaginated).

Response `200`:

```json
{
  "data": [
    { "id": "c9b8a7d6-…", "url": "https://hooks.example.com/otok-email", "events": ["email.delivered", "email.bounced", "email.complained", "email.failed"], "is_active": true, "created_at": "2026-07-14T10:00:00.000Z" }
  ]
}
```

Secrets are never included.

## DELETE /api/v1/webhook-endpoints/:id

Response **204**, no body. Deliveries stop immediately; anything still queued for the deleted endpoint is dropped.

| Status | `error.code` | Meaning |
|---|---|---|
| 404 | `endpoint_not_found` | Unknown id, another workspace's id, **or a malformed (non-UUID) id** — deliberately indistinguishable |

---

## Event types

| Type | Subscription | Fires when |
|---|---|---|
| `email.delivered` | default | The provider confirmed delivery of an API send |
| `email.bounced` | default | The send bounced. `data.bounce_type` is included when known: `hard`, `soft`, or `block` |
| `email.complained` | default | The recipient marked the message as spam (feedback loop) |
| `email.failed` | default | **Reserved for future use — not currently emitted.** Subscriptions are accepted so existing registrations keep working when it ships; today a provider-rejected API send surfaces synchronously as the sender's `502 provider_error` instead |
| `email.opened` | **opt-in** | **First open only** — at most one per send, for sends with `tracking.opens`. `data.machine_open` is always present: `true` means the open was attributed to an automated mail scanner / prefetcher (e.g. Apple Mail privacy) rather than a human. Machine opens are forwarded flagged, never dropped |
| `email.clicked` | **opt-in** | **First click only** — at most one per send, for sends with `tracking.clicks`. `data.url` is always present: the original destination URL (may be an empty string in rare cases). Clicks carry no machine flag |

> A click does **not** emit an implied `email.opened` event. If you need "opened" semantics, treat a send as opened when you've received *either* `email.opened` or `email.clicked`.

## Delivery payload

Every delivery is an HTTP `POST` with this JSON body:

```json
{
  "id": "b2c3d4e5-f607-1829-3a4b-5c6d7e8f9012",
  "type": "email.bounced",
  "created_at": "2026-07-14T10:05:32.000Z",
  "data": {
    "send_id": "f0e1d2c3-b4a5-9687-7869-5a4b3c2d1e0f",
    "idempotency_key": "order-88123-receipt",
    "to": "customer@example.com",
    "reason": "550 5.1.1 user unknown",
    "bounce_type": "hard",
    "metadata": { "order_id": "88123" }
  }
}
```

| Field | Presence | Meaning |
|---|---|---|
| `id` | always | **Event id — stable across retries and shared across your endpoints.** Use it as your dedup key |
| `type` | always | Event type |
| `created_at` | always | When the event occurred (ISO 8601) |
| `data.send_id` | always | The `id` returned by `POST /v1/emails` |
| `data.idempotency_key` | always | Your idempotency key from the send |
| `data.to` | always | Recipient address |
| `data.reason` | when available | Bounce diagnostic or complaint feedback type — **omitted** when absent |
| `data.bounce_type` | `email.bounced` only, when known | `hard` / `soft` / `block` — omitted when unknown |
| `data.metadata` | when the send had metadata | Your `metadata` object, echoed verbatim — omitted when none |
| `data.machine_open` | `email.opened` only | Always present on opens |
| `data.url` | `email.clicked` only | Always present on clicks |

Optional fields are **omitted, never null**.

## Request headers

| Header | Value |
|---|---|
| `Content-Type` | `application/json; charset=utf-8` |
| `X-Otok-Event` | The event type (e.g. `email.bounced`) |
| `X-Otok-Event-Id` | The event id (same as the payload `id`) |
| `X-Otok-Signature` | `t=<unix seconds>,v1=<hex HMAC>` |

## Verifying signatures

Each delivery is signed with your endpoint's `whsec_…` secret:

- The signed payload is the string `"<t>" + "." + <raw request body>` — the **exact bytes** received on the wire, not re-serialized JSON.
- `v1` is the lowercase hex HMAC-SHA256 of that string, keyed with the **entire secret string including the `whsec_` prefix**.
- `t` is the unix-seconds timestamp of **this delivery attempt** — retries carry fresh timestamps, so you can enforce a replay window.
- Exactly one `v1` value is sent per request.

Complete Node.js example (Express):

```js
const crypto = require("node:crypto");
const express = require("express");

const WEBHOOK_SECRET = process.env.OTOK_WEBHOOK_SECRET; // the full "whsec_..." string
const TOLERANCE_SECONDS = 300; // 5 minutes

const app = express();

// IMPORTANT: capture the raw body — verification must use the exact bytes.
app.post("/otok-email", express.raw({ type: "application/json" }), (req, res) => {
  const signature = req.header("X-Otok-Signature") || "";
  const match = signature.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
  if (!match) return res.status(400).send("bad signature header");

  const [, t, receivedSig] = match;

  // 1. Reject stale timestamps (replay window)
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(t));
  if (age > TOLERANCE_SECONDS) return res.status(400).send("stale timestamp");

  // 2. Recompute the HMAC over "<t>.<rawBody>" with the FULL whsec_ secret
  const expectedSig = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(`${t}.${req.body}`) // req.body is a Buffer of the raw bytes
    .digest("hex");

  // 3. Timing-safe comparison
  const a = Buffer.from(expectedSig, "hex");
  const b = Buffer.from(receivedSig, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).send("invalid signature");
  }

  const event = JSON.parse(req.body.toString("utf8"));

  // 4. Dedup by event id — retries (and rare double-enqueues) reuse the same id
  if (alreadyProcessed(event.id)) return res.status(200).send("ok");
  markProcessed(event.id);

  handleEvent(event); // your logic — keep it fast; respond 2xx within 10 seconds

  res.status(200).send("ok");
});
```

**Always deduplicate by event id** (`event.id` / `X-Otok-Event-Id`): the same id is reused for every retry of a delivery, and rare recovery paths can enqueue a delivery twice. Each of your registered endpoints receives its own delivery of the same event id.

## Retry and transport policy

| Property | Value |
|---|---|
| Attempts | **10** per delivery |
| Backoff | Exponential — 30s, 90s, 4.5m, 13.5m, 40m, 2h, then 4h between later attempts (≈16 hours total window) |
| Per-attempt timeout | **10 seconds** — respond 2xx quickly and process asynchronously |
| Redirects | **Not followed** — any 3xx counts as a failure |
| Success | Any **2xx** response settles the delivery |
| Response body limit | Responses larger than 1 MB are treated as failures |
| URL safety | The URL's resolved address is re-checked on every attempt; a URL resolving to a reserved/private address fails permanently (no retry) |
| After final failure | The delivery is marked failed — **there is no automatic redelivery** of exhausted events |

Recommendations:

- **Use an `https://` receiver.** Plain `http://` URLs are accepted, but then the HMAC signature is your only integrity protection and payloads travel unencrypted.
- Return 2xx immediately after signature verification and dedup; do real work asynchronously.
- Persist processed event ids for at least the ~16-hour retry window.
- If you miss events past the retry window, reconcile by polling your own send records — exhausted deliveries are not replayed.
