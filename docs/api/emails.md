# Transactional Emails

`POST /v1/emails` sends a single transactional email through your workspace's verified sending domain. It is a **raw-content** endpoint: your HTML/text is delivered verbatim — no marketing footer, no unsubscribe link, and no tracking is injected unless you opt in.

Delivery outcomes (delivered/bounced/complained) arrive asynchronously via [webhooks](webhooks.md).

| Method | Path | Rate limit |
|---|---|---|
| POST | `/api/v1/emails` | **300 requests / minute** per key (higher than the API default) |

Requires [authentication](getting-started.md#authentication) and at least one **verified sending domain with a sender profile** configured in the app (Settings → Email).

Errors on this endpoint use the structured envelope `{"error": {"code", "message"}}` — key on `error.code`.

## Request body

| Field | Type | Required | Constraints |
|---|---|---|---|
| `to` | string | yes | 1–320 chars; must be a syntactically valid email (else 422 `invalid_recipient`) |
| `subject` | string | yes | 1–998 chars; no line breaks or control characters |
| `html` | string | one of `html`/`text` | ≤500 KB. Delivered verbatim |
| `text` | string | ″ | ≤100 KB. At least one of `html`/`text` is required; the missing part is derived from the other (text → HTML-escaped with line breaks preserved; html → a plain-text rendering) |
| `idempotency_key` | string | yes | 1–255 chars; unique per workspace — see idempotency below |
| `sender_profile_id` | UUID | no | Sender identity to use. Omitted → the workspace's default verified sender profile. An id from another workspace behaves like a nonexistent id (404) |
| `reply_to` | string | no | Valid email |
| `headers` | object | no | **Allowlist: only `List-Unsubscribe` and `List-Unsubscribe-Post`** (case-insensitive). Values: strings, ≤1000 chars, no control characters. Any other header key → 400 `validation_failed` |
| `metadata` | object | no | ≤2048 bytes JSON-serialized. Stored with the send and **echoed verbatim in webhook events** (`data.metadata`) |
| `tracking` | object | no | `{ "opens": boolean, "clicks": boolean }` — both default `false`. See tracking below |

## Response

- **201** — this request performed the send (fresh idempotency key).
- **200** — idempotent replay of an already-processed key (`duplicate: true`).

This is the only idempotent create route whose **status code** also distinguishes the two outcomes — the other idempotent creates (contacts, deals, payments, bookings) return 201 in both cases and carry the same top-level `duplicate` boolean.

```json
{
  "id": "f0e1d2c3-b4a5-9687-7869-5a4b3c2d1e0f",
  "status": "sent",
  "duplicate": false,
  "to": "customer@example.com",
  "idempotency_key": "order-88123-receipt",
  "provider_message_id": "0107019...-abcdef",
  "reason": null,
  "created_at": "2026-07-14T10:00:00.000Z"
}
```

| Field | Meaning |
|---|---|
| `id` | The send's id — matches `data.send_id` in webhook events |
| `status` | `"sent"` or `"suppressed"` |
| `duplicate` | `true` when this response replays a previously processed key |
| `provider_message_id` | Provider's message id; always `null` when suppressed |
| `reason` | `null`, or `"suppressed"` when the recipient was suppressed |

### Suppressed recipients are a 2xx, not an error

If the recipient is on the workspace's suppression list (prior hard bounce, complaint, or unsubscribe), the API responds **2xx** (201 first time, 200 on replay) with `status: "suppressed"` and `reason: "suppressed"`. The reason is deliberately coarse — the API does not disclose *why* an address is suppressed. **Check `status` in the body; do not treat 2xx alone as "delivered to the provider".**

## Idempotency

`idempotency_key` makes retries safe:

- The key is claimed **before** any quota/deliverability gate, so two concurrent requests with the same key can't both send.
- Replaying a resolved key returns **200** with `duplicate: true` and the original send's data. Replays of a suppressed send keep answering `"suppressed"`; replays of a sent message answer `"sent"` regardless of later delivery events (delivery state travels via webhooks).
- **409 `send_in_progress`** — another request with the same key is currently being processed. Retry shortly (same key). A claim stuck by a crash is automatically recoverable after ~3 minutes; a retry after that window completes the send and returns 200 `duplicate: true`.
- Validation failures and most pre-send errors release the key, so an immediate retry with the same key is allowed after fixing the request.
- **At-least-once corner case:** in a rare crash-and-retry overlap right after a successful provider handoff, the message can be delivered twice while your retry receives 200 `duplicate: true`. Design receivers/templates so a duplicate email is acceptable.

## Tracking (opt-in)

By default nothing is injected into your content. With `tracking`:

- `opens: true` — a 1×1 tracking pixel is appended to the HTML part.
- `clicks: true` — absolute `http(s)` links in the HTML part are wrapped in a first-party redirect that records the click and forwards to your URL **verbatim** (no UTM or other parameters are added). `mailto:`, in-page anchors (`#…`), relative URLs, and extremely long URLs are never wrapped.
- **The plain-text part is never modified.**
- Tracking preferences are not persisted — a replay of a tracked send returns the normal duplicate response.
- If the deployment lacks a usable signing secret for tracking links, the message is sent **untracked** rather than failing.

Open/click events are delivered via the opt-in `email.opened` / `email.clicked` [webhook events](webhooks.md#event-types) (first open / first click per send only).

## Example

```bash
curl -X POST "https://app.otok.io/api/v1/emails" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{
    "to": "customer@example.com",
    "subject": "Your receipt for order #88123",
    "html": "<h1>Thanks for your purchase!</h1><p>Order #88123 — 350.00 ILS.</p><p><a href=\"https://shop.example.com/orders/88123\">View your order</a></p>",
    "idempotency_key": "order-88123-receipt",
    "metadata": { "order_id": "88123" },
    "tracking": { "opens": true, "clicks": true }
  }'
```

## Errors

| Status | `error.code` | Meaning / action |
|---|---|---|
| 400 | — (standard validation body) | Request-shape violations: unknown fields, bad types, over-length values |
| 400 | `validation_failed` | Both `html` and `text` missing; disallowed or invalid custom header; `metadata` over 2048 bytes |
| 422 | `invalid_recipient` | `to` is not a valid email address — permanent, do not retry unchanged |
| 404 | `sender_profile_not_found` | `sender_profile_id` not found in this workspace |
| 409 | `send_in_progress` | Same idempotency key currently processing — retry shortly |
| 409 | `no_verified_sender` | No sender profile with a verified domain — configure one in the app |
| 402 | `quota_exceeded` | Monthly email quota exhausted — resets at the next billing period or after an upgrade |
| 429 | `warming_cap_exceeded` | Domain-warming daily cap reached — transient, retry after the daily reset |
| 429 | — (standard body) | Rate limit (300/min per key) — honor `Retry-After` |
| 503 | `workspace_paused` | Workspace email sending is paused by deliverability protection — resolve in the app |
| 502 | `provider_error` | The email provider rejected the send. The message includes only a coarse signal (e.g. an SMTP code or `timed out`). The idempotency key is released — safe to retry with the same key |

## Notes

- **Consent is your responsibility.** This endpoint is for transactional mail; it neither checks marketing consent nor creates oToK contact records for recipients. The suppression list is still enforced (fail-closed).
- Include your own `List-Unsubscribe` headers (via the allowlisted `headers`) where appropriate for your mail type.
