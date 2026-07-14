# @otok/node

Official Node.js SDK for the [oToK](https://github.com/SlikkDev/otok-api) marketing platform public API (`/v1`).

Gives bespoke websites and e-commerce stores out-of-the-box integration with oToK: contact upserts, sales deals, transactional email, WhatsApp templates, campaigns, payments, bookings — plus signed-webhook verification and a high-level e-commerce layer that is safe to retry by design.

- **Node 18+**, zero runtime dependencies (native `fetch`)
- Full TypeScript types derived from the real API contract
- Automatic retries with exponential backoff + jitter on `429`/`5xx` (honors `Retry-After`)
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
```

### Create a deal from an order (idempotent)

`external_reference` maps one order to one deal — a repeat `POST` with the same reference updates that deal instead of creating a duplicate, so retries are always safe.

```ts
const pipelines = await otok.pipelines.list(); // map stage ids once

const deal = await otok.deals.create({
  email: "jane@example.com",          // contact matched or created
  title: "Order A-1001",
  amount: 249.9,
  currency: "USD",
  external_reference: "order:A-1001", // ← idempotency key
});

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
  // Defaults to the four delivery events; engagement events are opt-in:
  events: ["email.delivered", "email.bounced", "email.complained", "email.failed", "email.opened", "email.clicked"],
});
console.log(endpoint.secret); // whsec_… — shown only now
```

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
| `otok.contacts` | `GET/POST /v1/contacts`, `GET/PATCH /v1/contacts/:id` (POST = upsert by phone/email) |
| `otok.tags` | `GET/POST /v1/tags`, `GET/PATCH /v1/tags/:id` |
| `otok.contactGroups` | `GET/POST /v1/contact-groups`, `GET/PATCH /v1/contact-groups/:id` |
| `otok.pipelines` | `GET /v1/pipelines` (with ordered stages) |
| `otok.deals` | `GET/POST /v1/deals`, `GET/PATCH /v1/deals/:id`, `POST /v1/deals/:id/stage`, `POST /v1/deals/:id/status` |
| `otok.emails` | `POST /v1/emails` (transactional, idempotent) |
| `otok.campaigns` | `GET/POST /v1/campaigns`, `GET/PATCH /v1/campaigns/:id`, `POST /v1/campaigns/:id/execute` |
| `otok.templates` | `GET /v1/templates`, `GET /v1/templates/:id`, `POST /v1/templates/:id/send` (WhatsApp) |
| `otok.payments` | `GET/POST /v1/payments`, `GET/PATCH /v1/payments/:id`, `POST …/cancel`, `POST …/entries/:entryId/mark`, `POST …/refund` |
| `otok.meetingTypes` | `GET /v1/meeting-types`, `GET /v1/meeting-types/:id`, `GET /v1/meeting-types/:id/slots` |
| `otok.bookings` | `GET/POST /v1/bookings`, `GET /v1/bookings/:id`, `POST …/cancel`, `POST …/reschedule`, `POST …/reassign` |
| `otok.webhookEndpoints` | `GET/POST /v1/webhook-endpoints`, `DELETE /v1/webhook-endpoints/:id` |
| `otok.commerce` | High-level: `identifyCustomer(customer)`, `trackOrder(order)` |

Request/response field names match the wire contract (snake_case) exactly, so the interactive API reference at `https://app.otok.io/api/v1/docs` applies 1:1. The `commerce` layer accepts friendlier camelCase objects and maps them for you.

## Errors, timeouts, retries

- Non-2xx responses throw **`OtokApiError`** with `status`, `code` (machine-readable, when the endpoint uses the `{ error: { code, message } }` envelope, e.g. `endpoint_not_found`, `SLOT_TAKEN`), and the parsed `body`.
- Requests time out after `timeoutMs` (default 30 s) and throw **`OtokTimeoutError`**.
- `429` and `5xx` responses are retried up to `maxRetries` times (default 2) with exponential backoff + full jitter, honoring the `Retry-After` header. Network errors are **not** retried automatically in v0.1 — use idempotency keys (`external_reference`, `idempotency_key`) and retry at the call site.
- Rate limits are enforced per API key (default 100 requests/min; `POST /v1/emails` allows 300/min).

```ts
import { OtokApiError } from "@otok/node";

try {
  await otok.bookings.create({ /* … */ });
} catch (err) {
  if (err instanceof OtokApiError && err.code === "SLOT_TAKEN") {
    // offer another slot
  } else throw err;
}
```

## Examples

Runnable scripts live in [`examples/`](./examples):

- [`track-order.mjs`](./examples/track-order.mjs) — contact upsert + idempotent deal + receipt for a store order
- [`express-webhook-receiver.mjs`](./examples/express-webhook-receiver.mjs) — verified webhook receiver (Express)

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Versioning & scope (v0.1)

Covered: the e-commerce path end to end (contacts, tags/groups, pipelines/deals, transactional email + webhooks, payments), plus campaigns, WhatsApp templates, and bookings. Not covered yet: contact notes endpoints, list-endpoint `$where` advanced filter helpers, and automatic pagination iterators — planned for a later release.
