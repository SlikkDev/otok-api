# Webhooks

Register HTTPS endpoints to receive **email events** (delivery and engagement events for emails sent through [`POST /v1/emails`](emails.md)), **order events** (lifecycle events for [orders](orders.md)), **payment-request events** (lifecycle events for [pay-links](payment-requests.md)), **contact events** (lifecycle + [consent](consent-and-suppressions.md) changes), **message events** (inbound WhatsApp messages), **deal events** (lifecycle events for [deals](deals.md)), **booking events** (lifecycle events for [bookings](bookings.md)), **event-attendance events**, and **form-submission events**. Events are signed, retried, and deduplicable by event id.

**Email events** fire **only for API-originated sends** (sends made with an idempotency key via `POST /v1/emails`); engagement events additionally require the send to have opted into `tracking`. **Order events** fire for **every** order write source — API, in-app, and automations — not just API-created orders (never for historical import ingestion). **Payment-request events** fire for hosted pay-links from every mint source (API and in-app) — never for direct saved-card charges or internal dunning-recovery links. **Contact, message, deal, booking, attendance, and form events** fire for every intentional write source too — their quiet paths are documented per family below.

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
| `events` | string[] | no | Event types to receive (see tables below). Must be non-empty when present. **Omitted → the three email delivery events** (`email.delivered`, `email.bounced`, `email.complained`) — every other family is opt-in and received only when explicitly listed: the engagement events `email.opened`/`email.clicked` and **all `order.*`, `payment_request.*`, `contact.*`, `message.received`, `deal.*`, `booking.*`, `event.attendance.changed`, and `form.submitted` events**. A pre-existing registration never starts receiving a new family unasked. `email.failed` is **deprecated**: still accepted when listed explicitly (the registration succeeds and echoes it in `events`), but it is never delivered |

**Maximum 3 endpoints per workspace** (409 `endpoint_limit_reached`). The cap is enforced safely under concurrency.

```bash
curl -X POST "https://app.otok.io/api/v1/webhook-endpoints" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://hooks.example.com/otok-events",
    "events": ["email.delivered", "email.bounced", "email.complained", "order.created", "order.paid"]
  }'
```

Response `201`:

```json
{
  "id": "c9b8a7d6-e5f4-0312-2130-4a5b6c7d8e9f",
  "url": "https://hooks.example.com/otok-events",
  "events": ["email.delivered", "email.bounced", "email.complained", "order.created", "order.paid"],
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
    { "id": "c9b8a7d6-…", "url": "https://hooks.example.com/otok-email", "events": ["email.delivered", "email.bounced", "email.complained"], "is_active": true, "created_at": "2026-07-14T10:00:00.000Z" }
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

### Email events

| Type | Subscription | Fires when |
|---|---|---|
| `email.delivered` | default | The provider confirmed delivery of an API send |
| `email.bounced` | default | The send bounced. `data.bounce_type` is included when known: `hard`, `soft`, or `block` |
| `email.complained` | default | The recipient marked the message as spam (feedback loop) |
| `email.failed` | **deprecated** — accepted, never fires | **Deprecated — never delivered; nothing produces this event.** It is no longer part of the default set. Listing it explicitly at registration still succeeds (no error, no warning; it is echoed in `events`) so existing integrations keep working, but no delivery will ever arrive. A failing `POST /v1/emails` send fails synchronously on the request itself (e.g. `502 provider_error`, `409 send_in_progress`) — handle send failures from the send response, not from webhooks |
| `email.opened` | **opt-in** | **First open only** — at most one per send, for sends with `tracking.opens`. `data.machine_open` is always present: `true` means the open was attributed to an automated mail scanner / prefetcher (e.g. Apple Mail privacy) rather than a human. Machine opens are forwarded flagged, never dropped |
| `email.clicked` | **opt-in** | **First click only** — at most one per send, for sends with `tracking.clicks`. `data.url` is always present: the original destination URL (may be an empty string in rare cases). Clicks carry no machine flag |

> A click does **not** emit an implied `email.opened` event. If you need "opened" semantics, treat a send as opened when you've received *either* `email.opened` or `email.clicked`.

### Order events

Five [order](orders.md) lifecycle events. All are **opt-in**: they are delivered only to endpoints that list them explicitly in `events` — an endpoint registered without an `events` list receives none of them.

| Type | Subscription | Fires when |
|---|---|---|
| `order.created` | opt-in | An order was created — by the API, in the app, or by an automation |
| `order.paid` | opt-in | The order entered a paid state — `paid` or `partially_paid` (a paid create, `mark-paid`, or an in-app payment record); check `data.financial_status` to distinguish a deposit from full payment |
| `order.refunded` | opt-in | A refund was recorded — `data.refund` carries the refund (see below) |
| `order.cancelled` | opt-in | The order was cancelled (the `cancelled_at` stamp — the financial status is untouched) |
| `order.fulfilled` | opt-in | The order was fulfilled. Fulfillment is recorded in-app — there is no `/v1` fulfillment route |

Order events fire for **every** order write source, not just API-created orders. They are never fired for historical import ingestion.

### Payment-request events

Four [payment-request](payment-requests.md) (pay-link) lifecycle events, mirroring the request's status vocabulary. All are **opt-in**: they are delivered only to endpoints that list them explicitly in `events` — an endpoint registered without an `events` list receives none of them.

| Type | Subscription | Fires when |
|---|---|---|
| `payment_request.created` | opt-in | A hosted pay-link was minted — by the API or in the app |
| `payment_request.paid` | opt-in | The payment was verified with the provider — including a **late completion** of an already-cancelled link (a payer who was on the hosted page can still finish). `data.contact_payment_id` links the settled [payment](payments.md) ledger row. **Test-mode completions fire too** — check `data.test_mode` before recording revenue |
| `payment_request.expired` | opt-in | A pending link passed `expires_at` unpaid (from the expiry sweep, or lazily when the expired link is opened) |
| `payment_request.cancelled` | opt-in | The link was withdrawn — `POST /v1/payment-requests/:id/cancel` or an in-app cancel. A later `payment_request.paid` for the same request supersedes this event (late completion) |

**Hosted pay-links only:** direct saved-card charges (`charge_kind: "token"`) and internal dunning-recovery links never emit `payment_request.*` events — the event stream is exactly the payer-facing links.

### Contact events

Four [contact](contacts.md) lifecycle + [consent](consent-and-suppressions.md) events. All are **opt-in** (delivered only to endpoints that list them explicitly in `events`).

| Type | Subscription | Fires when |
|---|---|---|
| `contact.created` | opt-in | A contact was created at an intentional write seam — API upserts that create, in-app creates, form/lead capture, integration syncs. `data.duplicate` is always `false` (an upsert that matched an existing contact is an update, not a create) |
| `contact.updated` | opt-in | A contact's fields changed in an intentional single-contact write. `data.changed_fields` names what changed — the same list the in-app Activity timeline records, including the `tags`/`groups` junction keys and `custom_fields.<key>` entries |
| `contact.deleted` | opt-in | A contact was deleted — carries **last-known identifiers only** (the row is gone; key your mirror off `data.contact_id`). Bulk deletes emit one event per contact |
| `contact.consent_changed` | opt-in | A channel's consent state changed — real transitions (opt-in / unsubscribe / resubscribe) plus deliverability-driven suppress escalations, from **every** consent surface (API, forms, unsubscribe pages, in-app edits) |

**Quiet by design:** CSV imports and bulk contact edits emit nothing; **contact merges are fully silent** (a merge is not a deletion — the absorbed contact emits no `contact.deleted`); the creation-time consent seed does not emit `contact.consent_changed` (`contact.created` carries the initial state); same-state consent re-assertions, double-opt-in ceremony markers, and preference-center metadata updates do not emit.

### Message events

One inbound-message event. **Opt-in** (delivered only to endpoints that list it explicitly in `events`).

| Type | Subscription | Fires when |
|---|---|---|
| `message.received` | opt-in | A real inbound WhatsApp message arrived — exactly once per WhatsApp message (post-dedup). Reactions, messages from blocked contacts, and WhatsApp **coexistence** echoes/history imports are all silent |

Media rides as **metadata only** (`mime_type`, `filename`, `bytes`) — never presigned URLs, media URLs, or storage keys.

### Deal events

Four [deal](deals.md) lifecycle events. All are **opt-in** (delivered only to endpoints that list them explicitly in `events`). They fire for **every** write source — manual, API, automations, and Salesforce sync — `data.source` says which.

| Type | Subscription | Fires when |
|---|---|---|
| `deal.created` | opt-in | A deal was created |
| `deal.stage_changed` | opt-in | The deal moved to another stage — `data.from_stage_id`/`from_stage_name` carry the origin (they are `null` on every other deal event) |
| `deal.won` | opt-in | The deal was marked won (`data.closed_at` stamped; the deal keeps its last stage) |
| `deal.lost` | opt-in | The deal was marked lost — `data.lost_reason` carries the stored reason (or `null`) |

### Booking events

Four [booking](bookings.md) lifecycle events. All are **opt-in** (delivered only to endpoints that list them explicitly in `events`).

| Type | Subscription | Fires when |
|---|---|---|
| `booking.created` | opt-in | A booking was made — from the public booking page, in-app, the API, or an embed. `data.source` says which |
| `booking.rescheduled` | opt-in | The booking moved to a new time — `data.start_at`/`end_at` are the NEW times |
| `booking.cancelled` | opt-in | The booking was cancelled — `data.cancelled_by`/`cancel_reason` say who and why (when recorded) |
| `booking.reassigned` | opt-in | The booking's host changed — `data.previous_host_name` carries the outgoing host (it is `null` on every other booking event) |

`booking.completed` / `booking.no_show` deliberately do **not** exist as webhooks: those statuses are sweep-derived (a cron inferring the past, not a user action).

### Event-attendance events

**One** event type for the whole family — filter on `data.status` instead of subscribing per status. **Opt-in.**

| Type | Subscription | Fires when |
|---|---|---|
| `event.attendance.changed` | opt-in | An attendee's status changed (`registered`, `attending`, `attended`, `no_show`, `cancelled`) — per attendance row, from single edits, bulk operations, and automation actions. `data.previous_status` carries the transition (`null` for fresh registrations and for set-based bulk status updates, which have no per-row prior state) |

### Form events

**One** event type for every submission surface — `data.origin` is the discriminator. **Opt-in.**

| Type | Subscription | Fires when |
|---|---|---|
| `form.submitted` | opt-in | A form was submitted — a standalone embed (`origin: "form"`), a published landing page's form block (`"landing_page"`), or an on-site popup (`"popup"`). Fires post-persist even when no contact was resolved (`data.contact_id` is then `null`) |

Registering an endpoint for a mix of the new families:

```bash
curl -X POST "https://app.otok.io/api/v1/webhook-endpoints" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://hooks.example.com/otok-crm",
    "events": ["contact.created", "contact.updated", "contact.consent_changed", "deal.won", "form.submitted"]
  }'
```

## Delivery payload

Every delivery is an HTTP `POST` with the same JSON envelope; the shape of `data` depends on the event family:

| Field | Presence | Meaning |
|---|---|---|
| `id` | always | **Event id — stable across retries and shared across your endpoints.** Use it as your dedup key |
| `type` | always | Event type |
| `created_at` | always | When the event occurred (ISO 8601) |
| `data` | always | Event data — see the per-family shapes below |

### Email event `data`

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
| `data.send_id` | always | The `id` returned by `POST /v1/emails` |
| `data.idempotency_key` | always | Your idempotency key from the send |
| `data.to` | always | Recipient address |
| `data.reason` | when available | Bounce diagnostic or complaint feedback type — **omitted** when absent |
| `data.bounce_type` | `email.bounced` only, when known | `hard` / `soft` / `block` — omitted when unknown |
| `data.metadata` | when the send had metadata | Your `metadata` object, echoed verbatim — omitted when none |
| `data.machine_open` | `email.opened` only | Always present on opens |
| `data.url` | `email.clicked` only | Always present on clicks |

Optional email-event fields are **omitted, never null**.

### Order event `data`

```json
{
  "id": "a1b2c3d4-e5f6-0718-2930-4a5b6c7d8e9f",
  "type": "order.refunded",
  "created_at": "2026-07-15T09:30:00.000Z",
  "data": {
    "order_id": "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9",
    "external_id": null,
    "number": "1042",
    "platform": "api",
    "store_connection_id": null,
    "financial_status": "partially_refunded",
    "fulfillment_status": "unfulfilled",
    "currency": "ILS",
    "total": 360,
    "subtotal": 340,
    "discount_total": 0,
    "shipping_total": 20,
    "tax_total": 0,
    "refunded_total": 50,
    "coupon_codes": ["SUMMER10"],
    "item_count": 3,
    "first_item_name": "Widget",
    "placed_at": "2026-07-14T10:00:00.000Z",
    "paid_at": "2026-07-14T10:00:00.000Z",
    "cancelled_at": null,
    "refunded_at": "2026-07-15T09:30:00.000Z",
    "created_at": "2026-07-14T10:00:00.000Z",
    "refund": {
      "amount": 50,
      "external_refund_id": "r-1",
      "reason": "damaged",
      "refunded_at": "2026-07-15T09:30:00.000Z"
    }
  }
}
```

All five order events carry the same `data` fields (a snapshot of the order at event time):

| Field | Meaning |
|---|---|
| `data.order_id` | The order's `id` |
| `data.external_id` | Store-side order id — `null` for API- and app-created orders |
| `data.number` | Display number **as a string**: the store display number when present, else the per-workspace sequential `order_number` |
| `data.platform` | Order origin — `api`, `manual`, `automation` (store platform names reserved) |
| `data.store_connection_id` | Store provenance — `null` for API- and app-created orders |
| `data.financial_status` / `data.fulfillment_status` | Statuses at event time |
| `data.currency` + money fields | `total`, `subtotal`, `discount_total`, `shipping_total`, `tax_total`, `refunded_total` — **JSON numbers** in the order's charge currency |
| `data.coupon_codes` / `data.item_count` / `data.first_item_name` | Header rollups |
| `data.placed_at` / `data.paid_at` / `data.cancelled_at` / `data.refunded_at` / `data.created_at` | ISO 8601 UTC, or `null` |
| `data.refund` | **`order.refunded` only** — `{ amount, external_refund_id, reason, refunded_at }` for the refund that fired this event |

Unlike email events, order event `data` always carries the full field set — absent values are explicit `null`s, not omitted keys.

### Payment-request event `data`

```json
{
  "id": "c3d4e5f6-0718-2930-4a5b-6c7d8e9f0a1b",
  "type": "payment_request.paid",
  "created_at": "2026-07-15T11:20:00.000Z",
  "data": {
    "payment_request_id": "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0",
    "status": "paid",
    "contact_id": "9c2f1a4e-3b7d-4e2a-9f0c-1d2e3f4a5b6c",
    "deal_id": null,
    "provider": "sumit",
    "amount": 250,
    "currency": "ILS",
    "title": "Onboarding session",
    "vat_mode": "inclusive",
    "vat_rate": 18,
    "test_mode": false,
    "pay_url": "https://app.otok.io/pay/pr_k3J9…",
    "contact_payment_id": "7b6a5c4d-3e2f-1a0b-9c8d-7e6f5a4b3c2d",
    "expires_at": "2026-07-18T09:00:00.000Z",
    "paid_at": "2026-07-15T11:20:00.000Z",
    "cancelled_at": null,
    "created_at": "2026-07-15T09:00:00.000Z"
  }
}
```

All four payment-request events carry the same `data` fields (a snapshot of the request at event time), following the order-event conventions — the full field set with explicit `null`s:

| Field | Meaning |
|---|---|
| `data.payment_request_id` | The payment request's `id` |
| `data.status` | Status at event time — `pending` on `payment_request.created`; `paid` / `expired` / `cancelled` on the terminal events |
| `data.contact_id` / `data.deal_id` | The payer contact; the bound deal (or `null`) |
| `data.provider` | `cardcom` / `sumit` |
| `data.amount` / `data.currency` | **JSON number** in the request's currency |
| `data.title` | Payer-facing charge title, or `null` |
| `data.vat_mode` / `data.vat_rate` | The request's stamped VAT posture, or `null`s on pre-VAT rows |
| `data.test_mode` | **Always present.** `true` = authorise-only test request — never real money |
| `data.pay_url` | The same hosted pay-link URL the API/app expose |
| `data.contact_payment_id` | The settled [payment](payments.md) ledger row — set once paid, else `null` |
| `data.expires_at` / `data.paid_at` / `data.cancelled_at` / `data.created_at` | ISO 8601 UTC, or `null` |

Provider correlation references and internal row metadata are deliberately excluded from the payload — read `GET /v1/payment-requests/:id` when you need them.

### Contact event `data`

`contact.created` / `contact.updated` share a compact core; `contact.deleted` and `contact.consent_changed` have their own shapes. Absent values are explicit `null`s.

```json
{
  "id": "f6071829-3a4b-5c6d-7e8f-901234567890",
  "type": "contact.updated",
  "created_at": "2026-07-16T10:15:00.000Z",
  "data": {
    "contact_id": "9c2f1a4e-3b7d-4e2a-9f0c-1d2e3f4a5b6c",
    "changed_fields": ["lifecycle_stage", "tags", "custom_fields.plan"],
    "contact": {
      "id": "9c2f1a4e-3b7d-4e2a-9f0c-1d2e3f4a5b6c",
      "phone": "+972505555555",
      "email": "jane@example.com",
      "name": "Jane Cohen",
      "first_name": "Jane",
      "last_name": "Cohen",
      "lifecycle_stage": "customer",
      "source": "form",
      "block_state": "none",
      "lead_score": 72
    },
    "source": "manual"
  }
}
```

| Field | Events | Meaning |
|---|---|---|
| `data.contact_id` | all four | The contact's `id` |
| `data.contact` | created, updated | A **fixed compact projection** — `id`, `phone`, `email`, `name`, `first_name`, `last_name`, `lifecycle_stage`, `source`, `block_state`, `lead_score`. Never junction arrays (tags/groups), custom fields, or engine-maintained columns — fetch the full row with `GET /v1/contacts/:id` |
| `data.source` | created, updated, consent_changed | Which surface performed the write (e.g. `manual`, `api`, `form`, `automation`, an integration name). Tolerate unknown values |
| `data.duplicate` | created only | Always `false` — the event fires only for fresh inserts |
| `data.changed_fields` | updated only | The changed field names — including `tags`/`groups` junction keys and `custom_fields.<key>` entries |
| `data.phone` / `data.email` / `data.name` | deleted only | Last-known identifiers (the row is gone) |
| `data.channel` | consent_changed only | `whatsapp` \| `email` |
| `data.action` | consent_changed only | The consent-ledger action — e.g. `opt_in`, `double_opt_in_confirmed`, `unsubscribe`, `resubscribe`, `suppress`. Tolerate unknown values |
| `data.consent_state` / `data.previous_state` | consent_changed only | The new and prior decision (`subscribed`/`unsubscribed`/`unknown`; `previous_state` is `null` when no prior decision was stored) |
| `data.basis` | consent_changed only | Legal basis, or `null` |
| `data.consent_event_id` | consent_changed only | The consent-evidence ledger row this change wrote |

### Message event `data`

```json
{
  "id": "d4e5f607-1829-3a4b-5c6d-7e8f90123456",
  "type": "message.received",
  "created_at": "2026-07-16T08:12:05.000Z",
  "data": {
    "message_id": "1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809",
    "conversation_id": "2b3c4d5e-6f70-8192-a3b4-c5d6e7f8091a",
    "contact_id": "9c2f1a4e-3b7d-4e2a-9f0c-1d2e3f4a5b6c",
    "channel": "whatsapp_api",
    "type": "image",
    "text": "Here is the signed form",
    "media": {
      "mime_type": "image/jpeg",
      "filename": "signed-form.jpg",
      "bytes": 482113
    },
    "wa_message_id": "wamid.HBgMOTcyNTA1NTU1NTU1FQIAEhg=",
    "timestamp": "2026-07-16T08:12:03.000Z"
  }
}
```

| Field | Presence | Meaning |
|---|---|---|
| `data.message_id` / `data.conversation_id` / `data.contact_id` | always | oToK ids (`conversation_id`/`contact_id` may be `null`) |
| `data.channel` | always | `whatsapp_api` (v1 fires for the WhatsApp channel only) |
| `data.type` | always | Message type — `text`, `image`, `video`, `audio`, `document`, `location`, `contacts`, `button`, … Tolerate unknown values |
| `data.text` | always | The message's human text: body text for text/button messages, the **caption** for captioned media, else `null` |
| `data.media` | media messages only | **Omitted** on non-media messages. Metadata only — `{ mime_type, filename, bytes }`; never presigned URLs or storage keys |
| `data.wa_message_id` | always | WhatsApp's own message id (`wamid.…`) |
| `data.timestamp` | always | The Meta-provided message timestamp (ISO 8601 UTC), or `null` |

### Deal event `data`

All four deal events carry the same `data` fields (a snapshot of the deal at event time, full field set with explicit `null`s):

```json
{
  "id": "e5f60718-293a-4b5c-6d7e-8f9012345678",
  "type": "deal.stage_changed",
  "created_at": "2026-07-16T09:00:00.000Z",
  "data": {
    "deal_id": "3c4d5e6f-7081-92a3-b4c5-d6e7f8091a2b",
    "contact_id": "9c2f1a4e-3b7d-4e2a-9f0c-1d2e3f4a5b6c",
    "pipeline_id": "4d5e6f70-8192-a3b4-c5d6-e7f8091a2b3c",
    "pipeline_name": "Sales",
    "stage_id": "5e6f7081-92a3-b4c5-d6e7-f8091a2b3c4d",
    "stage_name": "Negotiation",
    "from_stage_id": "6f708192-a3b4-c5d6-e7f8-091a2b3c4d5e",
    "from_stage_name": "Qualified",
    "status": "open",
    "title": "Onboarding package",
    "amount": 3600,
    "currency": "ILS",
    "owner_user_id": "708192a3-b4c5-d6e7-f809-1a2b3c4d5e6f",
    "external_reference": "crm-9912",
    "source": "api",
    "expected_close_at": "2026-08-01T00:00:00.000Z",
    "closed_at": null,
    "lost_reason": null
  }
}
```

| Field | Meaning |
|---|---|
| `data.deal_id` / `data.contact_id` | The deal and its contact |
| `data.pipeline_id` / `data.pipeline_name` | The deal's pipeline |
| `data.stage_id` / `data.stage_name` | The deal's **current** stage (the destination, on a move) |
| `data.from_stage_id` / `data.from_stage_name` | **`deal.stage_changed` only** — the origin stage; `null` on every other deal event |
| `data.status` | `open` / `won` / `lost` at event time |
| `data.title` / `data.amount` / `data.currency` | `amount` is a **JSON number** in the deal's currency, or `null` |
| `data.owner_user_id` | The owning agent, or `null` |
| `data.external_reference` | The [`/v1/deals`](deals.md) idempotency reference, when set |
| `data.source` | Which surface performed the write — `manual`, `api`, `automation`, `salesforce`. Tolerate unknown values |
| `data.expected_close_at` / `data.closed_at` / `data.lost_reason` | ISO 8601 UTC or `null` |

### Booking event `data`

All four booking events carry the same `data` fields (full field set, explicit `null`s). The booking module is deliberately **multi-timezone**, so both the host and invitee timezones ride the payload. There is deliberately **no `manage_url`** — that is a capability token and never leaves through a webhook body (mint links from your own systems instead).

| Field | Meaning |
|---|---|
| `data.booking_id` / `data.contact_id` | The booking and its invitee contact |
| `data.meeting_type_id` / `data.meeting_type_name` | The meeting type |
| `data.host_user_id` / `data.host_name` | The (current) host |
| `data.previous_host_name` | **`booking.reassigned` only** — the outgoing host; `null` on every other booking event |
| `data.start_at` / `data.end_at` | ISO 8601 UTC (the NEW times on `booking.rescheduled`) |
| `data.host_timezone` / `data.invitee_timezone` | IANA timezones — the host's schedule tz and the tz the invitee booked in |
| `data.status` | Booking status at event time (e.g. `confirmed`, `cancelled`). Tolerate unknown values |
| `data.location_type` | The meeting type's location kind. Tolerate unknown values |
| `data.cancelled_by` / `data.cancel_reason` | `booking.cancelled` — who cancelled (e.g. `host`, `invitee`) and why; `null` elsewhere |
| `data.source` | How the booking was created — `public_page`, `manual`, `api`, or `embed`. Passed through verbatim: **tolerate unknown values**, new sources may appear without notice |

### Event-attendance event `data`

| Field | Meaning |
|---|---|
| `data.attendance_id` / `data.event_id` / `data.contact_id` | The attendance row, its event, and the attendee |
| `data.status` | `registered`, `attending`, `attended`, `no_show`, `cancelled`. Tolerate unknown values |
| `data.previous_status` | The prior status — `null` for fresh registrations and for set-based **bulk** status updates (whose single UPDATE has no per-row prior state) |
| `data.registered_at` / `data.attended_at` / `data.unregistered_at` | ISO 8601 UTC or `null` |
| `data.event` | Compact event snapshot `{ id, name, start_at }`, or `null` when unavailable |

### Form event `data`

| Field | Meaning |
|---|---|
| `data.form_id` / `data.form_name` | The submitted form |
| `data.submission_id` | Unique per submission — a secondary dedup key for your CRM |
| `data.contact_id` | The resolved/created contact — `null` when contact auto-creation is off and no contact matched |
| `data.origin` | `form` (standalone embed) \| `landing_page` \| `popup` |
| `data.landing_page_id` / `data.popup_id` | Set when `origin` is `landing_page` / `popup` respectively, else `null` |
| `data.fields` | The submitted answers, keyed by form field ids |

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
