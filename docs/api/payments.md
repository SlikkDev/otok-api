# Payments

Record customer payments against contacts: one-time charges, recurring plans, and installment deals. A payment is a header (the arrangement) plus one or more **entries** (the individual charges/refunds in its schedule).

All endpoints require [authentication](getting-started.md#authentication). Payments cannot be deleted via the API.

> **Plan feature required:** every payments route (including `/refund`) requires the **Payments** feature on the workspace's plan, in addition to API access. Without it, all calls return `403` with `error_code: "FEATURE_NOT_INCLUDED_IN_PLAN"` — see [feature-gated resource groups](getting-started.md#feature-gated-resource-groups).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/payments` | List payments |
| GET | `/api/v1/payments/:id` | Get a payment with its entries |
| POST | `/api/v1/payments` | Create a payment (idempotent upsert via `external_reference`) |
| PATCH | `/api/v1/payments/:id` | Update a payment |
| POST | `/api/v1/payments/:id/cancel` | Cancel a recurring plan |
| POST | `/api/v1/payments/:id/entries/:entryId/mark` | Set one entry's status |
| POST | `/api/v1/payments/:id/refund` | Record a refund against a charge |

## The payment model

**Header fields:** `id`, `workspace_id`, `contact_id`, `product_id`, `type` (`one_time` / `recurring` / `installments`), `title`, `note`, `currency`, `total_amount`, `arrangement_status` (`active` / `completed` / `cancelled`), `method`, `purchase_date`, `recurring_interval`, `recurring_next_due_at`, `recurring_auto_generate`, `recurring_cancelled_at`, `recurring_end_at`, `recurring_max_occurrences`, `recurring_payment_method_id`, `recurring_last_attempt_at`, `recurring_failure_count`, `recurring_paused_at`, `recurring_next_retry_at`, `recurring_dunning_started_at`, `vat_mode`, `vat_rate`, `installment_count`, `external_reference`, `source`, `metadata`, `created_by`, `created_at`, `updated_at`.

The `recurring_payment_method_id` … `recurring_dunning_started_at` block reflects **automatic charging** of recurring plans funded by a saved card (attached in-app): the funding card, the charging sweep's last attempt, the consecutive-failure count, and the retry/pause state after failures. They are read-only via the API and `null`/`0` on plans without automatic charging.

**Entry fields:** `id`, `payment_id`, `workspace_id`, `contact_id`, `sequence`, `amount`, `currency`, `status` (`pending` / `completed` / `failed` / `refunded`), `due_date`, `paid_at`, `recognized_amount`, `recognized_at`, `kind` (`charge` / `refund`), `refunds_entry_id`, `note`, `provider_refund_ref`, `refund_idempotency_key`, `credit_document`, `created_at`, `updated_at`.

Refund entries carry **negative** `amount`/`recognized_amount` and point at the charge they reverse via `refunds_entry_id`. On refunds executed through a connected payment provider (in-app), `provider_refund_ref` carries the provider-side transaction reference, `refund_idempotency_key` the key the provider call was made with, and `credit_document` the issued credit document as `{ provider, id, number, type, url }` — all `null` for ledger-only refunds recorded via this API.

### VAT on recurring plans

Recurring plans store a resolved VAT posture — a **`vat_mode` + `vat_rate` pair** — stamped at creation (explicit pair → attached product's pair → workspace default) so every cycle is charged and documented identically even if workspace settings change later:

- `vat_mode`: `inclusive` (VAT is included in the amount) or `exclusive` (the amount is net; VAT is added on top). VAT-exempt = `exclusive` + rate `0`.
- `vat_rate`: percent, 0–100, at most 2 decimal places.
- The pair always travels **together** — a lone leg returns 400, and on non-recurring payments any pair returns 400 `"vatMode/vatRate apply to recurring plans only"`.
- On responses the pair is `null` for non-recurring payments and for plans created before VAT granularity (those resolve the live workspace default each cycle).

### Metadata

`metadata` is a free-form JSON object stored on the payment — **max 2048 bytes serialized** (400 `"metadata exceeds 2048 bytes serialized"` over the cap). It is returned on reads and surfaced to payment automations. Writes **replace** the whole object; on PATCH, `null` clears it and omitting it keeps it. Reads may also carry system-written keys — notably the standardized external tax-document pointer under `metadata.document` (`{ provider, id, number, type, url }`).

Money fields — the header's `total_amount` and each entry's `amount`/`recognized_amount` — serialize as **JSON numbers** rounded to 2 decimals (e.g. `350`), in both requests and responses. (Earlier revisions of this page showed decimal strings like `"350.00"` in response examples — that was a documentation error; the API has always returned numbers.)

Single-payment responses (`GET /:id` and all write routes) return `{ ...header, entries: [...] }` with entries ordered by `sequence`. **List rows do not include entries.**

## GET /api/v1/payments

This route uses dedicated query parameters and its own pagination defaults — see [where deals and payments differ](getting-started.md#where-deals-and-payments-differ).

| Param | Type | Notes |
|---|---|---|
| `type` | enum | `one_time`, `recurring`, `installments` — other values are silently ignored |
| `status` | enum | Arrangement status: `active`, `completed`, `cancelled` — other values silently ignored |
| `search` | string | Case-insensitive match over payment title + contact name/phone/email |
| `limit` | integer | Default **25**, cap 100. Absent or empty defaults; malformed → 400 `"Invalid limit: must be a non-negative integer"` |
| `offset` | integer | Default 0, min 0. Malformed → 400 `"Invalid offset: must be a non-negative integer"` |

Ordered by `purchase_date` descending. Rows include joined `contact_name` / `contact_phone` / `contact_email`.

```bash
curl -G "https://app.otok.io/api/v1/payments" \
  -H "Authorization: Bearer otok_live_abc123..." \
  --data-urlencode 'type=recurring' \
  --data-urlencode 'status=active'
```

Response `200` — `{ data, total, limit, offset }`.

## GET /api/v1/payments/:id

Response `200` — `{ ...header, entries: [...] }`. `404` — `"Payment not found"`. Non-UUID id → 400.

## POST /api/v1/payments

Creates a payment — or, when `external_reference` matches an existing payment, **updates it** (see below).

### Request body

| Field | Type | Required | Constraints |
|---|---|---|---|
| `contact_id` | UUID | one of `contact_id` OR `phone`/`email` | Existing contact (404 if not in this workspace) |
| `phone` | string | ″ | ≤32 chars |
| `email` | string | ″ | Valid email |
| `name` | string | no | ≤200 — used only for a newly created contact |
| `type` | enum | **yes** | `one_time`, `recurring`, `installments` |
| `amount` | number | **yes** | 0 – 9,999,999,999. one_time: the charge amount; recurring: amount **per cycle**; installments: the **total** deal amount |
| `product_id` | UUID | no | Attach a product by id |
| `product_sku` | string | no | ≤120 |
| `product_external_id` | string | no | ≤255 |
| `title` | string | no | ≤200 — **ignored while a product is attached** (title derives from the product name) |
| `note` | string | no | ≤1000 |
| `method` | enum | no | `cash`, `card`, `bank_transfer`, `other` |
| `currency` | string | no | ≤3 chars, uppercased. Omitted → workspace default currency |
| `purchase_date` | string | no | ISO 8601. A date-only value (`"2026-07-14"`) is interpreted as start of that day in the **workspace timezone**. Omitted → now |
| `status` | enum | no | `pending`, `completed`, `failed`, `refunded` — **one-time only**. Omitted → `completed` |
| `interval` | enum | no | `weekly`, `monthly`, `quarterly`, `yearly` — **recurring only**. Omitted → `monthly` |
| `auto_generate` | boolean | no | Recurring only: automatically record each cycle when due |
| `record_first_payment` | boolean | no | Recurring only: record the first cycle immediately (default `true`) |
| `recurring_end_at` | string | no | Recurring only; ISO 8601 — a date-only value means **end** of that day in the workspace timezone; must be after the purchase date |
| `recurring_max_occurrences` | integer | no | Recurring only; ≥1 — total charge cycles ever |
| `vat_mode` | enum | no | `inclusive`, `exclusive` — **recurring only, always together with `vat_rate`** (see [VAT on recurring plans](#vat-on-recurring-plans)). Omitted → the product's pair, else the workspace default |
| `vat_rate` | number | no | 0 – 100, ≤2 decimals — always together with `vat_mode` |
| `installment_count` | integer | conditionally | 2 – 360 — **required when `type` is `installments`** (over the ceiling → 400 `"installmentCount must be at most 360"`) |
| `external_reference` | string | no | ≤255 — **idempotency key**, unique per workspace |
| `metadata` | object | no | Free-form JSON, **≤2048 bytes serialized** (see [Metadata](#metadata)) |

### Contact and product resolution

Identical to [deals](deals.md#contact-resolution): `contact_id` wins; otherwise `phone`/`email` are upserted like `POST /v1/contacts` (with the same **409 `CONTACT_MERGE_REQUIRED`** behavior); neither → 400 `"Provide contact_id, or a phone/email to attach the payment to a contact"`.

Products resolve by `product_id` → `product_sku` → `product_external_id`; while attached, the payment's title derives from the product name and only active products attach to new records (400 `INVALID_PRODUCT` / `PRODUCT_INACTIVE`). Unlike deals, **`amount` is always required** — the product price does not substitute for it.

### Entry creation per type

- **one_time** — one entry with the given `status`. The header's `arrangement_status` mirrors the entry: `completed` → `completed`, `pending` → `active`, `failed`/`refunded` → `cancelled`.
- **recurring** — the first cycle is recorded now when `record_first_payment` is true (default); further cycles are recorded automatically when `auto_generate` is on, until `recurring_end_at` / `recurring_max_occurrences`. A plan that can produce no further cycle is created already `completed`.
- **installments** — `installment_count` monthly entries starting at `purchase_date`, recognized as revenue immediately.

### Idempotent upsert via `external_reference`

When a POST carries an `external_reference` matching an existing payment in the workspace, the existing payment is **updated instead of created**. Only mutable fields are applied:

- **Always (when present in the body):** `product_id`, `title` (subject to the product title lock), `note`, `method`, `metadata` (the provided object **replaces** the stored one — omit it to keep it).
- **Only when the existing payment is `one_time`:** `amount`, `status`.
- **Only when it is `recurring`:** `auto_generate`, `recurring_end_at`, `recurring_max_occurrences`, and the `vat_mode`+`vat_rate` pair — a full pair **re-prices** the plan (future cycles are charged and documented with the new posture).
- **Never restructured on a match:** `type`, `interval`, `installment_count`, `purchase_date` — and, unlike deals, **the contact is NOT re-pointed** on a match.

The response is **201 in both cases**, with a top-level boolean **`duplicate`** field: `false` when this request created the payment, `true` when the `external_reference` matched an existing payment (mutable fields updated).

### Example

```bash
curl -X POST "https://app.otok.io/api/v1/payments" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+972501234567",
    "name": "Dana Levi",
    "type": "one_time",
    "amount": 350,
    "currency": "ILS",
    "method": "card",
    "title": "Onboarding session",
    "external_reference": "shop-order-88123"
  }'
```

Response `201`:

```json
{
  "id": "7b6a5c4d-3e2f-1a0b-9c8d-7e6f5a4b3c2d",
  "contact_id": "9c2f1a4e-3b7d-4e2a-9f0c-1d2e3f4a5b6c",
  "type": "one_time",
  "title": "Onboarding session",
  "currency": "ILS",
  "total_amount": 350,
  "arrangement_status": "completed",
  "method": "card",
  "purchase_date": "2026-07-14T10:00:00.000Z",
  "external_reference": "shop-order-88123",
  "source": "api",
  "duplicate": false,
  "entries": [
    {
      "id": "e1d2c3b4-…",
      "payment_id": "7b6a5c4d-…",
      "sequence": 1,
      "amount": 350,
      "currency": "ILS",
      "status": "completed",
      "paid_at": "2026-07-14T10:00:00.000Z",
      "recognized_amount": 350,
      "recognized_at": "2026-07-14T10:00:00.000Z",
      "kind": "charge",
      "refunds_entry_id": null
    }
  ],
  "created_at": "2026-07-14T10:00:00.000Z",
  "updated_at": "2026-07-14T10:00:00.000Z"
}
```

### Errors

| Status | Code / message | Meaning |
|---|---|---|
| 400 | `"Invalid payment type"` / `"amount must be a non-negative number"` / amount over 9,999,999,999 | Bad type/amount |
| 400 | `"installmentCount must be at least 2 for an installment deal"` / `"installmentCount must be at most 360"` | Missing or out-of-range `installment_count` for installments |
| 400 | `"purchaseDate is not a valid date"` / `"recurringEndAt is not a valid date"` / `"recurringEndAt must be after the purchase date"` / `"recurringMaxOccurrences must be a whole number of at least 1"` | Schedule validation |
| 400 | `INVALID_PRODUCT` / `PRODUCT_INACTIVE` | Product reference problems |
| 400 | `"vatMode/vatRate apply to recurring plans only"` / `"vat_mode and vat_rate must be provided together"` | VAT pair on a non-recurring payment, or a lone leg |
| 400 | `"metadata exceeds 2048 bytes serialized"` | Oversized `metadata` object |
| 400 | `"Provide contact_id, or a phone/email…"` | No contact reference |
| 403 | `FEATURE_NOT_INCLUDED_IN_PLAN` | Plan lacks the Payments feature (body has no `statusCode` field) |
| 404 | `"Contact not found"` | `contact_id` not in this workspace |
| 409 | `CONTACT_MERGE_REQUIRED` | Phone and email resolve to two different contacts |

### Side effects

The payment is recorded on the contact's activity timeline. When money is recognized up front, the workspace's **payment-recorded automations** fire; a recurring first cycle also reports a conversion to connected ad platforms.

## PATCH /api/v1/payments/:id

All fields optional.

| Field | Type | Notes |
|---|---|---|
| `product_id` | UUID or `null` | Attach/replace (must be active unless already attached) or detach (`null`); title derives from the product while attached |
| `title` | string | ≤200 — ignored while a product is attached |
| `note` | string | ≤1000 |
| `method` | enum | `cash`, `card`, `bank_transfer`, `other` |
| `amount` | number | 0 – 9,999,999,999 — **one-time only** (silently ignored otherwise) |
| `status` | enum | `pending`, `completed`, `failed`, `refunded` — **one-time only** |
| `auto_generate` | boolean | Recurring only |
| `recurring_end_at` | string or `null` | Recurring only; `null` clears; must be after the purchase date |
| `recurring_max_occurrences` | integer or `null` | Recurring only; ≥1; `null` clears |
| `vat_mode` | enum | `inclusive`, `exclusive` — **recurring only, always together with `vat_rate`**. Replaces the plan's stored VAT pair; future cycles use it. Unlike the other type-restricted fields this is NOT silently ignored on other types (400), and lone legs / `null`s are rejected — the stored pair is a complete value. Omit both to keep the pair |
| `vat_rate` | number | 0 – 100, ≤2 decimals — always together with `vat_mode` |
| `metadata` | object or `null` | **Replaces** the stored object (≤2048 bytes serialized); `null` clears it; omit to keep it |

Semantics:

- A one-time `amount`/`status` change flows into the payment's single entry and re-maps the header's `arrangement_status`.
- Shortening a recurring plan's end conditions may auto-complete it; extending them never silently reactivates a completed plan.
- A one-time status change fires the matching automation after the update: `failed` → payment-failed, `refunded` → payment-refunded, `pending` → `completed` → payment-recorded.

Response `200` — `{ ...header, entries }`.

| Status | Message |
|---|---|
| 400 | `"This charge already has refunds; reverse those instead of marking it refunded/failed"` — use `/refund` for reversals |
| 400 | Recurring end-condition validation errors |
| 400 | `"vatMode/vatRate apply to recurring plans only"` / `"vatMode and vatRate must be provided together"` — VAT pair on a non-recurring payment, or a lone leg / `null` |
| 400 | `"metadata exceeds 2048 bytes serialized"` |
| 404 | `"Payment not found"` |

## POST /api/v1/payments/:id/cancel

Cancels a **recurring** plan. No request body.

Response `201` — the payment with `arrangement_status: "cancelled"`, `recurring_cancelled_at` set, auto-generation off, and no next due date. Already-recorded entries are untouched.

| Status | Message |
|---|---|
| 400 | `"Only recurring payments can be cancelled"` — one-time/installment payments |
| 404 | `"Payment not found"` |

## POST /api/v1/payments/:id/entries/:entryId/mark

Sets one entry's status. The entry must belong to the payment in the URL.

| Field | Type | Required | Constraints |
|---|---|---|---|
| `status` | enum | yes | `pending`, `completed`, `failed`, `refunded` |

```bash
curl -X POST "https://app.otok.io/api/v1/payments/7b6a5c4d-3e2f-1a0b-9c8d-7e6f5a4b3c2d/entries/e1d2c3b4-5a6b-7c8d-9e0f-1a2b3c4d5e6f/mark" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{ "status": "completed" }'
```

Response `201` — the full parent payment with entries.

Semantics: marking `completed` stamps `paid_at` and recognizes the revenue. A one-time header mirrors its entry's status; recurring/installment headers are **not** changed by marking one cycle. Status-change automations fire as on PATCH (payment-recorded only for a newly recognized completion).

| Status | Message |
|---|---|
| 400 | `"Refund entries cannot be marked directly"` |
| 400 | `"This charge already has refunds; reverse those instead of marking it refunded/failed"` |
| 404 | `"Payment entry not found"` (unknown, foreign, or not an entry of this payment) / `"Payment not found"` |

## POST /api/v1/payments/:id/refund

Records a refund entry against a completed charge. All body fields optional:

| Field | Type | Constraints |
|---|---|---|
| `entry_id` | UUID | The charge entry to refund. **May be omitted only when the payment has exactly one charge** |
| `amount` | number | Partial refund amount (must be > 0, ≤ 9,999,999,999). Omitted → the full remaining refundable balance |
| `note` | string | ≤1000 — stored on the refund entry |

```bash
curl -X POST "https://app.otok.io/api/v1/payments/7b6a5c4d-3e2f-1a0b-9c8d-7e6f5a4b3c2d/refund" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{ "amount": 100, "note": "Partial refund — unused session" }'
```

Response `201` — the payment with a new entry: `kind: "refund"`, negative `amount`/`recognized_amount`, `status: "refunded"`, `refunds_entry_id` pointing at the charge.

Semantics:

- Multiple partial refunds against one charge are supported, up to its recognized value. Refunds are **race-safe** — concurrent refund requests cannot over-refund a charge.
- A fully refunded **one-time** payment's header becomes `arrangement_status: "cancelled"`; partial refunds and multi-entry deals keep their status.
- Fires the **payment-refunded automation** with the refunded amount.

| Status | Message |
|---|---|
| 400 | `"entryId is required to refund a payment with multiple charges"` |
| 400 | `"Only a completed (recognized) charge can be refunded"` |
| 400 | `"This charge is not recognized as revenue yet and cannot be refunded"` |
| 400 | `"Refund amount must be a positive number"` |
| 400 | `"This charge is no longer refundable"` / `"This charge is already fully refunded"` |
| 400 | `"Refund amount exceeds the refundable balance (<max>)"` |
| 404 | `"Payment not found"` / `"Payment entry not found"` |
