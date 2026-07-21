# @otok/node

Official Node.js SDK for the [oToK](https://github.com/SlikkDev/otok-api) marketing platform public API (`/v1`).

Gives bespoke websites and e-commerce stores out-of-the-box integration with oToK: contact upserts, sales deals, e-commerce orders, transactional email, broadcast email campaigns, newsletters, WhatsApp templates, campaigns, payments, hosted pay-links, bookings — plus signed-webhook verification and a high-level e-commerce layer that is safe to retry by design.

- **Node 18+**, zero runtime dependencies (native `fetch`)
- Full TypeScript types derived from the real API contract
- Automatic retries with exponential backoff + jitter on `429`/`5xx` (honors `Retry-After`), plus transient network errors for requests that are safe to replay
- Auto-paginating async iterators (`for await (const c of otok.contacts.iter())`)
- Constant-time webhook signature verification

## Install

```bash
npm install @otok/node
```

## Quickstart

Create an API key in **Settings → API keys** in your oToK workspace (keys look like `otok_live_…` and are shown once).

```ts
import { OtokClient } from "@otok/node";

const otok = new OtokClient({
  apiKey: process.env.OTOK_API_KEY!,
  // baseUrl defaults to https://app.otok.io/api — override only if oToK
  // support gives you a different URL (include the /api segment).
});
```

### Upsert a contact

`POST /v1/contacts` upserts by phone (canonicalized to E.164), falling back to email. `tags` and `groups` are **names** — missing ones are created automatically, and on upsert they are *added* (never removed).

```ts
const contact = await otok.contacts.upsert({
  email: "jane@example.com",
  phone: "+12025551234",
  first_name: "Jane",
  last_name: "Doe",
  tags: ["VIP", "Newsletter"],
  custom_fields: { plan: "gold" },
});
// contact.duplicate: false = a new contact was created,
//                    true  = an existing contact was matched and updated
```

Both outcomes return `201` — check the top-level `duplicate` flag to tell them apart. (`otok.contacts.update` by id behaves differently: setting a `phone`/`email` that belongs to another contact throws `409 CONTACT_MERGE_REQUIRED` — see [Errors](#errors-timeouts-retries).)

### Iterate a whole collection (auto-pagination)

Every paginated list endpoint has a matching `iter()` that returns an async iterator: it accepts the same filter/sort/search params as `list()` and fetches pages lazily until the collection is exhausted.

```ts
for await (const contact of otok.contacts.iter({ filter: { lifecycle_stage: "customer" } })) {
  console.log(contact.email);
}
```

Pages are requested at each endpoint's **documented `limit` cap** — 500 for the standard lists (contacts, tags, contact groups, campaigns, templates, meeting types, bookings), 100 for deals, payments, payment requests, orders, email campaigns, and newsletters (including newsletter issues), which paginate differently. Pass a smaller `limit` to override the page size (a larger one is clamped to the cap); `offset` sets the starting position:

```ts
for await (const deal of otok.deals.iter({ status: "open", limit: 50 })) {
  // pages of 50 through GET /v1/deals
}
```

### Contact notes

Plain-text annotations on a contact (API note payloads are text only — rich text and mentions are in-app features). `listNotes` returns a bare array (the endpoint is unpaginated), pinned notes first, then newest-first.

```ts
const note = await otok.contacts.createNote(contact.id, "Asked for a demo next week", { pinned: true });
await otok.contacts.updateNote(note.id, { body: "Demo booked for Tuesday", pinned: false });
const notes = await otok.contacts.listNotes(contact.id);
await otok.contacts.deleteNote(note.id); // → { success: true }
```

### Create a deal from an order (idempotent)

`external_reference` maps one order to one deal — a repeat `POST` with the same reference updates that deal instead of creating a duplicate, so retries are always safe. Both outcomes return `201`; on a match the response carries `duplicate: true` (fields updated, stage moved when different — the deal's status is never changed).

```ts
const pipelines = await otok.pipelines.list(); // map stage ids once

const deal = await otok.deals.create({
  email: "jane@example.com",          // contact matched or created
  title: "Order A-1001",
  amount: 249.9,
  currency: "USD",
  external_reference: "order:A-1001", // ← idempotency key
});
// deal.duplicate: true when this reference already had a deal (replay)

// Later: mark it won when the order is fulfilled
await otok.deals.setStatus(deal.id, { status: "won" });
```

Or use the high-level e-commerce layer, which does the contact upsert + idempotent deal (+ optional receipt email) in one call:

```ts
const { contact, deal, receipt } = await otok.commerce.trackOrder({
  orderId: "A-1001",
  customer: { email: "jane@example.com", name: "Jane Doe", tags: ["Customer"] },
  total: 249.9,
  currency: "USD",
  receipt: { subject: "Your order A-1001", html: "<p>Thanks for your order!</p>" },
});
```

`trackOrder` is safe to call from at-least-once webhook handlers (e.g. a store's `order.created` event): replays converge on the same contact, deal (`order:<id>`), and receipt (`order:<id>:receipt` email idempotency key).

> `trackOrder` records a **sales-pipeline entry** (a deal), not an order object — for real orders with line items, refunds, and financial statuses, use the [Orders API](#orders-line-items-refunds-statuses) (`otok.orders`).

### Orders (line items, refunds, statuses)

`POST /v1/orders` creates a full e-commerce order on a contact: line items, header money rollups (JSON numbers in the order's currency), a financial status (`pending`, `paid`, `partially_paid`, `refunded`, `partially_refunded`, `voided`) plus a read-only fulfillment status, an append-only refund ledger, and a separate cancellation stamp. Requires the **Orders** plan feature (see [errors](#errors-timeouts-retries)).

```ts
const order = await otok.orders.create({
  email: "jane@example.com",        // contact matched or created
  items: [
    { title: "Widget", unit_price: 170, quantity: 2 },
    { product_sku: "SKU-1" },       // price + title derive from the catalog product
  ],
  shipping_total: 20,
  financial_status: "paid",         // records the payment + fires order-paid automations
  external_reference: "shop:1001",  // ← idempotency key
});
```

`external_reference` makes create an **idempotent upsert**: a repeat `POST` with the same reference updates that order instead of creating a duplicate — `note`, `coupon_codes`, `placed_at`, and `deal_id` always apply; money fields (`items`, `currency`, `discount_total`, `shipping_total`, `tax_total`) apply only while the order is still `pending`; `financial_status` and the contact never change on a match. **Unlike the other create endpoints there is no top-level `duplicate` flag** — both outcomes return 201 with the full order; to distinguish, compare `created_at` or pre-check with `otok.orders.list({ external_reference: "shop:1001" })`.

Status moves ride dedicated endpoints (there is no `PATCH` on orders):

```ts
await otok.orders.markPaid(order.id);  // records a payment on the contact
await otok.orders.markPaid(order.id, { payment_reference: "inv-1001" });  // …or link an existing one
await otok.orders.cancel(order.id);    // stamps cancelled_at; recorded revenue stands until refunded
```

Marking an already-paid order paid is a no-op success; orders in refund states (and voided orders) throw a `409` with `err.code === "ORDER_ILLEGAL_TRANSITION"` (refund states are reachable only by recording refunds). A bad `payment_reference` throws typed errors too: `ORDER_PAYMENT_REFERENCE_NOT_FOUND`, `ORDER_PAYMENT_CONTACT_MISMATCH`, `ORDER_PAYMENT_NOT_LINKABLE`, `ORDER_PAYMENT_ALREADY_LINKED`.

Refunds append to the order's ledger and roll the financial status to `partially_refunded`/`refunded`:

```ts
const result = await otok.orders.createRefund(order.id, {
  amount: 50,
  reason: "Damaged in transit",
  external_refund_id: "refund-77",
});
result.duplicate;  // true = this external_refund_id was already recorded; nothing was applied
result.order.refunded_total, result.order.financial_status;
```

`external_refund_id` is the refund's idempotency key. **Without it refunds are not idempotent — every call appends a new refund** — so supply it whenever your system can retry. Refunding requires the order to have ever been paid (`400` with `err.code === "ORDER_NEVER_PAID"` otherwise), and cancellation doesn't block refunds (the money axis is separate).

List and iterate with dedicated filters, newest `placed_at` first:

```ts
for await (const order of otok.orders.iter({ status: "paid", placed_from: "2026-07-01T00:00:00Z" })) {
  // pages of 100 through GET /v1/orders
}
```

### Send a transactional email

Content passes through verbatim — no footer, tracking, or `List-Unsubscribe` injection unless you opt in. The `idempotency_key` is required; a repeat call returns the original send (`duplicate: true`) and never sends twice.

```ts
const result = await otok.emails.send({
  to: "jane@example.com",
  subject: "Your password reset link",
  html: "<p>Click <a href=\"https://shop.example.com/reset\">here</a>.</p>",
  idempotency_key: "pwreset:user-42:2026-07-14",
  tracking: { opens: true, clicks: true },  // optional, default off
  metadata: { user_id: "42" },              // echoed in webhook events
});
// result.status: "sent" | "suppressed"; result.duplicate: boolean
```

### Receive delivery webhooks

Register an endpoint (max 3 per workspace). The `whsec_…` signing secret is returned **once** — store it.

```ts
const endpoint = await otok.webhookEndpoints.create({
  url: "https://shop.example.com/api/otok-events",
  // Defaults to the three delivery events (email.delivered, email.bounced,
  // email.complained); engagement events are opt-in:
  events: ["email.delivered", "email.bounced", "email.complained", "email.opened", "email.clicked"],
});
console.log(endpoint.secret); // whsec_… — shown only now
```

> `email.failed` is deprecated: registrations listing it are still accepted, but the event is never delivered — a failing `POST /v1/emails` fails synchronously on the request itself, so handle send failures from that response.

Order lifecycle events — `order.created`, `order.paid`, `order.refunded`, `order.cancelled`, `order.fulfilled` — ride the same signed deliveries. They are **opt-in by listing** (an endpoint registered without `events` still defaults to the three email delivery events) and fire for **every** order write source (API, in-app, automations), not just API-created orders. `order.refunded` events additionally carry a `refund` block (`amount`, `external_refund_id`, `reason`, `refunded_at`).

Payment-request lifecycle events — `payment_request.created`, `payment_request.paid`, `payment_request.expired`, `payment_request.cancelled` — are opt-in by listing too (`PAYMENT_REQUEST_WEBHOOK_EVENT_TYPES`). They fire for hosted pay-links from every mint source (API and in-app), never for direct saved-card charges or internal dunning-recovery links. Payloads follow the order-event conventions (full field set, explicit `null`s); `data.test_mode` is always present — check it before recording revenue, and treat a late `payment_request.paid` after a cancel as authoritative.

Events are POSTed with an `X-Otok-Signature: t=<unix>,v1=<hex>` header (HMAC-SHA256 of `"{t}.{body}"` with your secret). Failed deliveries retry for ≈16 hours. **Always verify against the raw request body** — parsing and re-stringifying changes the bytes.

#### Express

```ts
import express from "express";
import { constructEvent, OtokWebhookVerificationError } from "@otok/node";

const app = express();

app.post(
  "/api/otok-events",
  express.raw({ type: "application/json" }), // keep the raw body!
  (req, res) => {
    let event;
    try {
      event = constructEvent(req.body, req.header("x-otok-signature"), process.env.OTOK_WEBHOOK_SECRET!);
    } catch (err) {
      if (err instanceof OtokWebhookVerificationError) return res.status(400).send("bad signature");
      throw err;
    }
    switch (event.type) {
      case "email.bounced":
        console.log("bounced:", event.data.to, event.data.bounce_type);
        break;
      case "email.clicked":
        console.log("clicked:", event.data.url);
        break;
    }
    res.status(200).send("ok"); // 2xx stops retries; dedupe on event.id
  },
);
```

#### Fastify

```ts
import Fastify from "fastify";
import { constructEvent } from "@otok/node";

const app = Fastify();

// Keep the raw body for this route
app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

app.post("/api/otok-events", async (req, reply) => {
  try {
    const event = constructEvent(
      req.body as Buffer,
      req.headers["x-otok-signature"] as string,
      process.env.OTOK_WEBHOOK_SECRET!,
    );
    // …handle event…
    return reply.code(200).send("ok");
  } catch {
    return reply.code(400).send("bad signature");
  }
});
```

#### Next.js (App Router route handler)

```ts
// app/api/otok-events/route.ts
import { constructEvent } from "@otok/node";

export async function POST(request: Request) {
  const raw = await request.text(); // raw body — do not use request.json()
  try {
    const event = constructEvent(raw, request.headers.get("x-otok-signature") ?? undefined, process.env.OTOK_WEBHOOK_SECRET!);
    // …handle event…
    return new Response("ok", { status: 200 });
  } catch {
    return new Response("bad signature", { status: 400 });
  }
}
```

You can also call `verifyWebhookSignature(payload, header, secret, { toleranceSeconds })` directly when you only need a boolean (default timestamp tolerance: 5 minutes).

## API coverage

| Namespace | Endpoints |
|---|---|
| `otok.contacts` | `GET/POST /v1/contacts`, `GET/PATCH /v1/contacts/:id` (POST = upsert by phone/email); consent: `GET /v1/contacts/:id/consent`, `PUT /v1/contacts/:id/consent/:channel`; documents: `GET /v1/contacts/:id/documents` (Payments feature); notes: `GET/POST /v1/contacts/:id/notes`, `PATCH/DELETE /v1/notes/:id` |
| `otok.tags` | `GET/POST /v1/tags`, `GET/PATCH /v1/tags/:id` |
| `otok.contactGroups` | `GET/POST /v1/contact-groups`, `GET/PATCH /v1/contact-groups/:id` |
| `otok.pipelines` | `GET /v1/pipelines` (with ordered stages) |
| `otok.deals` | `GET/POST /v1/deals`, `GET/PATCH /v1/deals/:id`, `POST /v1/deals/:id/stage`, `POST /v1/deals/:id/status` |
| `otok.products` | `GET/POST /v1/products`, `GET/PATCH /v1/products/:id` — the product catalog shared by deals and payments (POST = idempotent upsert by `external_id`; no delete — deactivate with `is_active: false`) |
| `otok.emails` | `POST /v1/emails` (transactional, idempotent) |
| `otok.suppressions` | `GET/POST /v1/suppressions`, `DELETE /v1/suppressions/:id` — the email suppression list (`email_marketing` feature; add is idempotent, and deliberately independent of consent) |
| `otok.emailCampaigns` | `GET/POST /v1/email-campaigns`, `GET/PATCH /v1/email-campaigns/:id`, `GET …/estimate`, `POST …/send`, `POST …/schedule`, `POST …/unschedule` — broadcast email campaigns authored through the shared content contract (`email_marketing` feature; POST = idempotent upsert by `external_reference`) |
| `otok.newsletters` | `GET/POST /v1/newsletters`, `GET /v1/newsletters/:id`; issues: `GET/POST /v1/newsletters/:id/issues`, `GET/PATCH/DELETE /v1/newsletter-issues/:id`, `POST …/publish`, `POST …/schedule`, `POST …/unschedule` (`newsletters` feature; issue POST = idempotent upsert by `external_reference`) |
| `otok.campaigns` | `GET/POST /v1/campaigns`, `GET/PATCH /v1/campaigns/:id`, `POST /v1/campaigns/:id/execute` |
| `otok.templates` | `GET /v1/templates`, `GET /v1/templates/:id`, `POST /v1/templates/:id/send` (WhatsApp) |
| `otok.payments` | `GET/POST /v1/payments`, `GET/PATCH /v1/payments/:id`, `POST …/cancel`, `POST …/entries/:entryId/mark`, `POST …/refund` |
| `otok.paymentRequests` | `GET/POST /v1/payment-requests`, `GET /v1/payment-requests/:id`, `POST …/cancel` — hosted pay-links (`workspace_payments` feature; create is **not** idempotent) |
| `otok.orders` | `GET/POST /v1/orders`, `GET /v1/orders/:id`, `POST …/refunds`, `POST …/mark-paid`, `POST …/cancel` |
| `otok.meetingTypes` | `GET /v1/meeting-types`, `GET /v1/meeting-types/:id`, `GET /v1/meeting-types/:id/slots`, `GET /v1/meeting-types/:id/embed` |
| `otok.bookings` | `GET/POST /v1/bookings`, `GET /v1/bookings/:id`, `POST …/cancel`, `POST …/reschedule`, `POST …/reassign` |
| `otok.webhookEndpoints` | `GET/POST /v1/webhook-endpoints`, `DELETE /v1/webhook-endpoints/:id` |
| `otok.commerce` | High-level: `identifyCustomer(customer)`, `trackOrder(order)` |

Request/response field names match the wire contract (snake_case) exactly, so the interactive API reference at `https://app.otok.io/api/v1/docs` applies 1:1. The `commerce` layer accepts friendlier camelCase objects and maps them for you.

Every namespace with a paginated `list()` (contacts, tags, contact groups, deals, products, suppressions, email campaigns, newsletters, campaigns, templates, payments, payment requests, orders, meeting types, bookings) also has an auto-paginating `iter()` — plus `otok.newsletters.iterIssues(newsletterId)` for one newsletter's issues. See [Iterate a whole collection](#iterate-a-whole-collection-auto-pagination).

## Errors, timeouts, retries

- Non-2xx responses throw **`OtokApiError`** with `status`, `code` (machine-readable, when present), and the parsed `body`. `code` comes from the `{ error: { code, message } }` envelope (e.g. `endpoint_not_found`, `SLOT_TAKEN`, `campaign_not_found`, `campaign_not_scheduled`) or from a top-level `error_code` field (e.g. `FEATURE_NOT_INCLUDED_IN_PLAN`, `CONTACT_MERGE_REQUIRED`). Key your handling on `status` + `code`, never on the message text.
- **403 `FEATURE_NOT_INCLUDED_IN_PLAN`** — deals/pipelines, payments (`otok.payments` + `otok.contacts.listDocuments`), payment requests (`otok.paymentRequests`, gated by the separate `workspace_payments` feature), orders, campaigns, bookings/meeting-types, email campaigns + suppressions (`otok.emailCampaigns` + `otok.suppressions`, both gated by `email_marketing`), and newsletters (`otok.newsletters`, gated by `newsletters`) each require the matching feature on the workspace's plan. When the plan lacks it, **every** route in that group (reads and writes alike) throws this.
- **409 `CONTACT_MERGE_REQUIRED`** — `otok.contacts.update` that would set a `phone`/`email` belonging to another contact (now or historically) is **not applied**; a merge request is parked for review in oToK instead. Its id is on the body — `(err.body as { merge_request_id?: string }).merge_request_id` — and non-identity fields from the same call are applied when the request is resolved.
- **409 on duplicate names** — creating or renaming a tag / contact group to a name that already exists in the workspace (case-insensitive) throws `409 Conflict`.
- **400 on invalid `filter` values** — list-endpoint `filter` values are type-checked against the target field (dates, UUIDs, enums, numbers, booleans); a mistyped value throws a 400 naming the field and expected kind.
- **`otok.campaigns.execute` uses real HTTP semantics** — it resolves (HTTP 200, `{ success: true, jobId }`) only when the campaign was queued, and throws otherwise: 404 `campaign_not_found`, 409 `campaign_not_scheduled`. Campaigns are created as `"draft"` unless you set `status: "scheduled"`, so set it (on create or via `update`) before executing.
- Each attempt — from connecting through downloading the response body — times out after `timeoutMs` (default 30 s) and throws **`OtokTimeoutError`**; timeouts count as transient network errors, so safe/idempotency-keyed requests are retried before the error surfaces (worst case ≈ (`maxRetries` + 1) × `timeoutMs` plus backoff).
- `429` and `5xx` responses are retried up to `maxRetries` times (default 2) with exponential backoff + full jitter, honoring the `Retry-After` header. This applies to **all** requests: the server answered, so the retry semantics are unchanged from v0.1.
- **Transient network errors are retried too — but only when replaying is safe.** Connection reset/refusal (`ECONNRESET`/`ECONNREFUSED`), DNS failures (`ENOTFOUND`/`EAI_AGAIN`), socket timeouts (`ETIMEDOUT`, and the SDK's own `OtokTimeoutError`), and similar transport-level failures share the same bounded backoff schedule (`maxRetries`, exponential + full jitter) **if and only if** the request is:
  - a **safe method** (`GET`/`HEAD`), or
  - a **write carrying its own idempotency key**: a body with a non-empty `idempotency_key` (`otok.emails.send`), `external_reference` (`otok.deals.create`, `otok.payments.create`, `otok.orders.create`, `otok.emailCampaigns.create`, `otok.newsletters.createIssue`), or `external_refund_id` (`otok.orders.createRefund`).

  Any other write (contact upserts, tag/group/campaign writes, bookings, stage moves, …) is **never** network-retried — a network error is ambiguous (the request may have reached the server), so the error is thrown for you to handle. In particular, **`otok.paymentRequests.create` is never auto-retried**: the endpoint has no idempotency key at all, and a replay would mint a second, independently payable link — check `otok.paymentRequests.list()` before minting again after a failure. To make such flows retry-safe, use the idempotent surfaces (`external_reference`, `idempotency_key`, `otok.commerce.trackOrder`) or retry at the call site.
- Rate limits are enforced per API key (default 100 requests/min; `POST /v1/emails` allows 300/min).

```ts
import { OtokApiError } from "@otok/node";

try {
  await otok.bookings.create({ /* … */ });
} catch (err) {
  if (err instanceof OtokApiError && err.code === "SLOT_TAKEN") {
    // offer another slot
  } else if (err instanceof OtokApiError && err.code === "FEATURE_NOT_INCLUDED_IN_PLAN") {
    // the workspace's plan doesn't include the Booking feature
  } else throw err;
}
```

## Examples

Runnable scripts live in [`examples/`](./examples):

- [`track-order.mjs`](./examples/track-order.mjs) — contact upsert + idempotent deal + receipt for a store order
- [`export-contacts.mjs`](./examples/export-contacts.mjs) — stream every contact to CSV with the auto-paginating iterator
- [`express-webhook-receiver.mjs`](./examples/express-webhook-receiver.mjs) — verified webhook receiver (Express)

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Versioning & scope (v0.7)

Covered: the e-commerce path end to end (contacts + consent + notes + financial documents, tags/groups, pipelines/deals, the product catalog, orders with refunds, transactional email + suppressions + webhooks, payments, payment requests), the email-marketing surface (broadcast email campaigns + newsletters, authored through the shared content contract), plus campaigns, WhatsApp templates, bookings, auto-paginating iterators on every paginated list endpoint, and bounded retries for transient network errors on safe/idempotency-keyed requests. Not covered yet: list-endpoint `$where` advanced filter helpers — planned for a later release.

New in v0.7.0:

- `otok.emailCampaigns` — the Email Campaigns API (`/v1/email-campaigns`, requires the `email_marketing` plan feature): `list`/`iter` (pages of 100, like deals/payments), `get`, `create` (idempotent upsert via `external_reference` — `duplicate: true` on a replay; write responses carry a `compile: {ok, errors, warnings}` envelope), `update`, `estimate` (`{estimated_recipients}`), `send` (a launch-gate failure throws 422 `launch_failed` with `campaign_status` on the error body), `schedule`, and `unschedule`
- `otok.newsletters` — the Newsletters API (`/v1/newsletters` + `/v1/newsletter-issues`, requires the `newsletters` plan feature): `list`/`iter`, `create`, `get`, plus issues — `listIssues`/`iterIssues`, `createIssue` (idempotent upsert via `external_reference`), `getIssue`, `updateIssue`, `deleteIssue` (never-published issues only), `publishIssue`, `scheduleIssue`, and `unscheduleIssue`
- The shared content contract types: an optional `direction` plus exactly one of `markdown` (with `::button[Label](url)` / `::snippet[name-or-uuid]` directives and `[[…]]` variable tokens), `blocks` (typed block array), or `design_json` (raw editor document)
- Transient-network-error retries automatically cover the new `external_reference` writes (`otok.emailCampaigns.create`, `otok.newsletters.createIssue`)

New in v0.6.0:

- `otok.meetingTypes.embed(id)` — website-embed material for a meeting type (`GET /v1/meeting-types/:id/embed`, requires the `booking` plan feature): the hosted booking page URL, the workspace's publishable embed key (`bk_…`, safe in page HTML — not the secret API key), and a ready-to-paste snippet

New in v0.5.0:

- `otok.contacts.getConsent(contactId)` / `otok.contacts.setConsent(contactId, channel, params)` — per-channel marketing consent (`whatsapp`/`email`): read the stored decision + provider-owned deliverability (email adds the composed send-time `suppressed` verdict), and record subscribed/unsubscribed decisions with provenance. Subscribing a channel with a spam complaint on record throws 409 `consent_sticky_complained`
- `otok.products` — the Products API (`/v1/products`): `list`/`iter` (standard pages of 500), `get`, `create` (idempotent upsert via `external_id` — the result carries `duplicate: true` on a match; 409 `product_conflict` on a `sku`/`external_id` clash), and `update` (no delete — deactivate with `is_active: false`)
- `otok.suppressions` — the Suppressions API (`/v1/suppressions`, requires the `email_marketing` plan feature): `list`/`iter`, `create` (idempotent add — `duplicate: true` when the address was already suppressed), and `delete`. Suppression is deliberately independent of consent: adding never unsubscribes a contact, removing never resubscribes one
- Fifteen new webhook event types across six opt-in families — contact lifecycle + consent (`contact.created`, `contact.updated`, `contact.deleted`, `contact.consent_changed`), inbound messages (`message.received` — real WhatsApp inbound only; media as metadata, never URLs), deals (`deal.created`, `deal.stage_changed`, `deal.won`, `deal.lost`), bookings (`booking.created`, `booking.rescheduled`, `booking.cancelled`, `booking.reassigned`), event attendance (`event.attendance.changed`), and form submissions (`form.submitted`) — registrable on webhook endpoints (opt-in by listing; `CONTACT_WEBHOOK_EVENT_TYPES`, `MESSAGE_WEBHOOK_EVENT_TYPES`, `DEAL_WEBHOOK_EVENT_TYPES`, `BOOKING_WEBHOOK_EVENT_TYPES`, `EVENT_ATTENDANCE_WEBHOOK_EVENT_TYPES`, `FORM_WEBHOOK_EVENT_TYPES`) and typed as inbound events for `constructEvent`. The default subscription is unchanged

New in v0.4.0:

- `otok.paymentRequests` — the Payment Requests API (`/v1/payment-requests`): `list`/`iter` (pages of 100, like deals/payments; unknown `status` filters 400), `get`, `create` (mints a hosted pay-link through the workspace's own connected provider — **no idempotency key exists on this resource**, so create is never auto-retried on network errors; a repeat POST mints a second payable link), and `cancel` (CAS on pending; 409 on final rows and `TOKEN_REQUEST_NOT_CANCELLABLE` on saved-card charge rows). Requires the `workspace_payments` plan feature — distinct from the `payments` ledger gate
- The four `payment_request.*` webhook event types (`payment_request.created`, `payment_request.paid`, `payment_request.expired`, `payment_request.cancelled`) — registrable on webhook endpoints (opt-in by listing; `PAYMENT_REQUEST_WEBHOOK_EVENT_TYPES`) and typed as inbound events for `constructEvent`
- `otok.contacts.listDocuments(contactId, { live? })` — `GET /v1/contacts/:id/documents`: a contact's invoices/receipts/credit documents aggregated from stored pointers, with an opt-in live provider lookup (requires the Payments feature)
- Payments: `create`/`update` accept the recurring-plan `vat_mode` + `vat_rate` pair and a `metadata` object (≤2048 bytes serialized; replace-on-write, `null` clears on update); response typings document the full payment/entry field set (dunning state, stored VAT pair, refund/credit-document fields)

New in v0.3.0:

- `otok.orders` — the Orders API (`/v1/orders`): `list`/`iter` (pages of 100, like deals/payments), `get`, `create` (idempotent upsert via `external_reference` — note: this endpoint returns **no** top-level `duplicate` flag), `createRefund` (`{ duplicate, order }` response; idempotent per `external_refund_id` — keyless refunds append on every call), `markPaid` (optionally linking an existing payment via `payment_reference`), and `cancel`
- The five `order.*` webhook event types (`order.created`, `order.paid`, `order.refunded`, `order.cancelled`, `order.fulfilled`) — registrable on webhook endpoints (opt-in by listing; `ORDER_WEBHOOK_EVENT_TYPES`) and typed as inbound events for `constructEvent`
- Transient-network-error retries now also cover writes keyed by `external_refund_id` (`otok.orders.createRefund`)

New in v0.2.0:

- `otok.contacts.listNotes` / `createNote` / `updateNote` / `deleteNote` — contact-notes endpoints (parity with the Python SDK)
- `iter()` async iterators on all paginated list endpoints, honoring each resource's documented page-size cap (500 standard; 100 for deals/payments)
- Transient network errors (connection reset/refused, DNS failure, socket timeout) now retry with the existing bounded backoff — GET/HEAD and idempotency-keyed writes only; other writes still surface the error immediately
