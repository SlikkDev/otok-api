# oToK REST API Reference

The oToK REST API (`/v1`) gives programmatic access to your workspace: contacts, tags and groups, WhatsApp campaigns and templates, deals and pipelines, payments, transactional email, outbound webhooks, and bookings.

- **Base URL:** `https://app.otok.io/api/v1/`
- **Auth:** `Authorization: Bearer otok_live_…` API keys (created in Settings → Developers)
- **Plan:** requires a plan with API access (Growth or higher)
- **Interactive docs:** Swagger UI at `https://app.otok.io/api/v1/docs`

Start with **[Getting Started](getting-started.md)** — authentication, error envelopes, rate limits, and list/filter conventions shared by all endpoints.

## Guides

| Page | Covers |
|---|---|
| [Getting Started](getting-started.md) | API keys, auth, base URL, errors, rate limits, pagination & filtering |
| [Contacts](contacts.md) | Contact upsert & update, merge-conflict contract, notes |
| [Tags & Contact Groups](tags-and-groups.md) | Tag / group CRUD and membership management |
| [Campaigns](campaigns.md) | WhatsApp campaigns: create, schedule, execute |
| [Templates](templates.md) | WhatsApp templates: read + send template messages |
| [Deals & Pipelines](deals.md) | Pipelines, deal CRUD, stage moves, win/lose, idempotent upsert |
| [Payments](payments.md) | One-time / recurring / installment payments, entries, refunds |
| [Transactional Emails](emails.md) | `POST /v1/emails`: idempotent raw sends, tracking opt-in |
| [Webhooks](webhooks.md) | Email event webhooks: registration, signatures, retries |
| [Bookings & Meeting Types](bookings.md) | Availability slots, booking lifecycle, host reassignment |

## Endpoint summary

| Resource | Endpoints |
|---|---|
| **Contacts** | `GET /v1/contacts` · `GET /v1/contacts/:id` · `POST /v1/contacts` (upsert) · `PATCH /v1/contacts/:id` |
| **Contact notes** | `GET /v1/contacts/:id/notes` · `POST /v1/contacts/:id/notes` · `PATCH /v1/notes/:id` · `DELETE /v1/notes/:id` |
| **Tags** | `GET /v1/tags` · `GET /v1/tags/:id` · `POST /v1/tags` · `PATCH /v1/tags/:id` |
| **Contact groups** | `GET /v1/contact-groups` · `GET /v1/contact-groups/:id` · `POST /v1/contact-groups` · `PATCH /v1/contact-groups/:id` |
| **Campaigns (WhatsApp)** | `GET /v1/campaigns` · `GET /v1/campaigns/:id` · `POST /v1/campaigns` · `PATCH /v1/campaigns/:id` · `POST /v1/campaigns/:id/execute` |
| **Templates (WhatsApp)** | `GET /v1/templates` · `GET /v1/templates/:id` · `POST /v1/templates/:id/send` |
| **Pipelines** | `GET /v1/pipelines` |
| **Deals** | `GET /v1/deals` · `GET /v1/deals/:id` · `POST /v1/deals` (upsert) · `PATCH /v1/deals/:id` · `POST /v1/deals/:id/stage` · `POST /v1/deals/:id/status` |
| **Payments** | `GET /v1/payments` · `GET /v1/payments/:id` · `POST /v1/payments` (upsert) · `PATCH /v1/payments/:id` · `POST /v1/payments/:id/cancel` · `POST /v1/payments/:id/entries/:entryId/mark` · `POST /v1/payments/:id/refund` |
| **Emails** | `POST /v1/emails` |
| **Webhook endpoints** | `GET /v1/webhook-endpoints` · `POST /v1/webhook-endpoints` · `DELETE /v1/webhook-endpoints/:id` |
| **Meeting types** | `GET /v1/meeting-types` · `GET /v1/meeting-types/:id` · `GET /v1/meeting-types/:id/slots` |
| **Bookings** | `GET /v1/bookings` · `GET /v1/bookings/:id` · `POST /v1/bookings` · `POST /v1/bookings/:id/cancel` · `POST /v1/bookings/:id/reschedule` · `POST /v1/bookings/:id/reassign` |

## Conventions at a glance

- **Success codes:** `GET`/`PATCH` → 200; `POST` → 201 (including action routes); `DELETE /v1/webhook-endpoints/:id` → 204. `POST /v1/emails` returns 200 on an idempotent replay.
- **Errors:** two body shapes — a structured `{"error": {"code", "message"}}` envelope on the email/webhook APIs, and the standard `{"statusCode", "message", "error"}` shape elsewhere, sometimes extended with an `error_code` field. See [error responses](getting-started.md#error-responses).
- **Pagination:** `{ "data", "total", "limit", "offset" }` — default limit 50 (cap 500) on most lists; deals and payments use default 25 (cap 100) with silent clamping.
- **Rate limits:** 100 requests/min per key (300/min for `POST /v1/emails`); HTTP 429 with `Retry-After` on excess.
- **Idempotency:** contacts upsert by phone/email; deals and payments upsert by `external_reference`; emails require an explicit `idempotency_key`; booking creation is idempotent per slot+contact.
