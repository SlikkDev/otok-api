# Orders

E-commerce-grade orders attached to your workspace's contacts. An order carries line items, header money rollups, an append-only refund ledger, and a **two-axis status model**: `financial_status` (the money) and `fulfillment_status` (the goods), plus a separate cancellation stamp that touches neither axis. Order writes fire the workspace's order automations and registered [`order.*` webhooks](webhooks.md#order-events) exactly as in-app writes do.

All endpoints require [authentication](getting-started.md#authentication). Orders cannot be deleted via the API, and there are no PATCH routes — after creation, status changes ride the action routes below, and field updates ride the idempotent re-POST (see [upsert semantics](#idempotent-upsert-via-external_reference)).

> **Plan feature required:** every route on this page requires the **Orders** feature on the workspace's plan, in addition to API access. Without it, all calls return `403` with `error_code: "FEATURE_NOT_INCLUDED_IN_PLAN"` — see [feature-gated resource groups](getting-started.md#feature-gated-resource-groups). The Orders feature is included on all current plans, so in practice this error appears only when the feature has been switched off for a specific workspace.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/orders` | List orders (filterable, paginated) |
| GET | `/api/v1/orders/:id` | Get one order with line items + refunds |
| POST | `/api/v1/orders` | Create an order (idempotent upsert via `external_reference`) |
| POST | `/api/v1/orders/:id/refunds` | Record a refund (idempotent via `external_refund_id`) |
| POST | `/api/v1/orders/:id/mark-paid` | Mark an order paid |
| POST | `/api/v1/orders/:id/cancel` | Cancel an order |

All POSTs return **201**, including the action routes. Every write response returns the **full order object** — header, `items`, `refunds`, and joined contact identity (list rows omit `items`/`refunds`); the refunds route wraps it as `{ duplicate, order }`.

## The order object

> **Money is numeric.** Order money fields (`total`, `subtotal`, `unit_price`, refund `amount`, …) serialize as **JSON numbers**, rounded to 2 decimals, in the order's charge currency — the same JSON-number serialization used by deals and payments.

Header fields:

| Field | Type | Notes |
|---|---|---|
| `id` | UUID | |
| `workspace_id` | UUID | |
| `contact_id` | UUID | The order's contact (required, always set) |
| `contact_name` / `contact_phone` / `contact_email` | string or `null` | Joined contact identity — included on list rows **and** detail/write responses |
| `order_number` | integer | Per-workspace sequential number, assigned at create |
| `number` | string or `null` | Store-side display number (e.g. `"#2043"`) — `null` for API- and app-created orders (see [store provenance](#store-provenance-fields)) |
| `platform` | string | Origin: `api` for API-created orders, `manual` for in-app, `automation` for automation-created; store platform names are reserved for store-synced orders |
| `source` | string | Same vocabulary as `platform` for non-store orders |
| `store_connection_id` | UUID or `null` | Store provenance — `null` for API- and app-created orders |
| `store_domain` | string or `null` | Store provenance — `null` for API- and app-created orders |
| `external_order_id` | string or `null` | Store-side order id — `null` for API- and app-created orders |
| `external_reference` | string or `null` | **Your idempotency key**, unique per workspace |
| `deal_id` | UUID or `null` | Optional link to a [deal](deals.md) of the same contact |
| `financial_status` | enum | `pending`, `paid`, `partially_paid`, `refunded`, `partially_refunded`, `voided`. `partially_paid` appears on reads (set in-app) but is not reachable through API writes |
| `fulfillment_status` | enum | `unfulfilled`, `partially_fulfilled`, `fulfilled` — **read-only via the API** (recorded in-app or by store sync; no `/v1` route sets it) |
| `currency` | string | 3-letter uppercase; defaults to the workspace currency |
| `total` | number | Header money — see [money math](#money-math) |
| `subtotal` | number | Sum of rounded line totals |
| `discount_total` | number | Document-level discount |
| `shipping_total` | number | |
| `tax_total` | number | |
| `refunded_total` | number | Rollup of the refund ledger |
| `item_count` | integer | Quantity sum, rounded to the nearest integer |
| `first_item_name` | string or `null` | |
| `coupon_codes` | string[] | Applied discount/coupon codes |
| `placed_at` | ISO 8601 | Order time (defaults to creation time) |
| `paid_at` | ISO 8601 or `null` | Stamped on first entry into a paid state; historical — kept through later refund states |
| `cancelled_at` | ISO 8601 or `null` | The cancellation stamp — cancellation is **not** a financial status |
| `refunded_at` | ISO 8601 or `null` | Last refund instant |
| `external_updated_at` | ISO 8601 or `null` | Store-sync snapshot clock — `null` for API- and app-created orders |
| `payment_reference` | string or `null` | Reference of the recorded payment backing this order (see [mark-paid](#post-apiv1ordersidmark-paid)) |
| `payment_synced_at` | ISO 8601 or `null` | Payment-recording convergence stamp (informational) |
| `note` | string or `null` | |
| `metadata` | object or `null` | Read-only via the API — not settable on any `/v1` route |
| `created_by` | UUID or `null` | `null` for API writes |
| `created_at` / `updated_at` | ISO 8601 | |

Line item (`items[]`, detail/write responses only, ordered by `position`):

| Field | Type | Notes |
|---|---|---|
| `id`, `workspace_id`, `order_id` | UUID | |
| `position` | integer | 0-based |
| `product_id` | UUID or `null` | Soft catalog link — `null` when no product resolved; survives product deletion as `null` |
| `external_product_id` | string or `null` | Store-side product id — `null` for API-created lines |
| `title` | string | Denormalized snapshot |
| `sku` | string or `null` | Denormalized snapshot |
| `quantity` | number | Decimal quantities allowed (weight/hours); default 1 |
| `unit_price` | number | In the order currency |
| `discount_percent` | number or `null` | Percent-only per-line discount, 0–100 |
| `line_total` | number | Server-computed — see [money math](#money-math) |
| `created_at` | ISO 8601 | |

Refund (`refunds[]`, detail/write responses only, ordered by `refunded_at` ascending):

| Field | Type | Notes |
|---|---|---|
| `id`, `workspace_id`, `order_id` | UUID | |
| `external_refund_id` | string or `null` | Caller idempotency key; `null` for keyless refunds |
| `amount` | number | Positive, in the order currency |
| `currency` | string | The order's currency |
| `reason` | string or `null` | |
| `refunded_at` | ISO 8601 | Defaults to record time |
| `created_at` | ISO 8601 | |

### Money math

Totals are computed server-side and are authoritative — client-sent totals are never trusted:

- Per line: `line_total` = round2(`quantity` × `unit_price` × (1 − `discount_percent`/100))
- `subtotal` = sum of the rounded line totals
- `total` = max(0, `subtotal` − `discount_total` + `shipping_total` + `tax_total`)

Rounding is 2-decimal, half-up.

### Store provenance fields

`number`, `store_connection_id`, `store_domain`, `external_order_id`, and `external_updated_at` are populated only for orders synced from a connected e-commerce store (where store sync is available on the workspace) — for every order you create via the API or in the app they are always `null`. Store-synced orders are **read-only through this API**: the mutation routes reject them with `409` `error_code: "STORE_SYNCED_READ_ONLY"`. Orders created via the API can never trigger that error.

## GET /api/v1/orders

This route uses dedicated query parameters (not the generic `filter`) with the deals/payments pagination family (see [where deals and payments differ](getting-started.md#where-deals-and-payments-differ)) — but note the clamping difference on `limit`/`offset` below the table. There is **no `search` parameter** on this route.

| Param | Type | Notes |
|---|---|---|
| `status` | enum | Financial status: `pending`, `paid`, `partially_paid`, `refunded`, `partially_refunded`, `voided`. Any other value is **silently ignored** (unfiltered result) |
| `contact_id` | UUID | Exact match. Malformed → 400 `"contact_id must be a UUID"`; empty (`?contact_id=`) is treated as absent |
| `source` | string | Exact match — `manual`, `api`, `automation` (store platform values are reserved for store-synced orders) |
| `store_connection_id` | UUID | Exact match. Malformed → 400 `"store_connection_id must be a UUID"`. Matches only store-synced orders — nothing for API/app-created orders |
| `external_reference` | string | Exact match — look up an order by your idempotency reference |
| `placed_from` | ISO 8601 | Orders placed at/after. Unparseable → 400 `"placed_from is not a valid date"` |
| `placed_to` | ISO 8601 | Orders placed at/before. Unparseable → 400 `"placed_to is not a valid date"` |
| `limit` | integer | Default **25**, cap 100, floor 1 — see below |
| `offset` | integer | Default 0, floor 0 — see below |

**Pagination clamping:** unlike deals and payments (which return 400 on malformed paging), orders never rejects `limit`/`offset` values — a malformed or zero `limit` silently defaults to 25 and out-of-range values are clamped into 1–100; a malformed or negative `offset` silently defaults to 0.

Results are ordered by **`placed_at` descending** (not `created_at`).

```bash
curl -G "https://app.otok.io/api/v1/orders" \
  -H "Authorization: Bearer otok_live_abc123..." \
  --data-urlencode 'status=paid' \
  --data-urlencode 'placed_from=2026-07-01'
```

Response `200` — `{ data, total, limit, offset }`; each row is the order object above with joined contact fields, **without** `items`/`refunds`.

| Status | Meaning |
|---|---|
| 400 | Malformed UUID query param (`"contact_id must be a UUID"`, …) or unparseable `placed_from`/`placed_to` |
| 403 | `error_code: "FEATURE_NOT_INCLUDED_IN_PLAN"` — plan lacks the Orders feature |

## GET /api/v1/orders/:id

The full order with `items[]` + `refunds[]` + joined contact identity.

- `200` — the order.
- `400` — non-UUID id.
- `404` — `"Order not found"` (an unknown id and another workspace's order are indistinguishable).

## POST /api/v1/orders

Creates an order — or, when `external_reference` matches an existing order, **updates its mutable fields** (idempotent upsert; see below). Response **201 in both cases** with the full order object (items + refunds + contact join).

> **No `duplicate` flag.** Unlike `POST /v1/contacts` / `/v1/deals` / `/v1/payments` / `/v1/bookings`, the order create response carries **no top-level `duplicate` boolean** — a fresh create and an `external_reference` match return the same full-order body. To distinguish the two, compare the response's `created_at` against your request time, or pre-check with `GET /v1/orders?external_reference=…`.

### Request body

| Field | Type | Required | Constraints |
|---|---|---|---|
| `contact_id` | UUID | one of `contact_id` OR `phone`/`email` | Existing contact (404 `"Contact not found"` if not in this workspace) |
| `phone` | string | ″ | ≤32 chars; a matching contact is used, or one is created |
| `email` | string | ″ | Valid email; same upsert semantics |
| `name` | string | no | ≤200 — used only when a **new** contact is created |
| `items` | array | no | ≤200 items (see [item shape](#item-shape)) |
| `currency` | string | no | ≤8 chars, uppercased. Omitted → workspace currency |
| `discount_total` | number | no | ≥0 (document-level discount) |
| `shipping_total` | number | no | ≥0 |
| `tax_total` | number | no | ≥0 |
| `financial_status` | enum | no | `pending` (default) or `paid` **only** — a paid create records the payment and fires order-paid automations. Never applied on an `external_reference` match |
| `placed_at` | string | no | ISO 8601; defaults to now |
| `coupon_codes` | string[] | no | ≤50 entries |
| `note` | string | no | ≤5000 |
| `deal_id` | UUID | no | Must be a deal of the **same contact** — 404 `ORDER_DEAL_NOT_FOUND` when unknown to the workspace, 409 `ORDER_DEAL_CONTACT_MISMATCH` when it belongs to another contact |
| `external_reference` | string | no | ≤255 — **the idempotency key**, unique per workspace |

### Item shape

| Field | Type | Required | Constraints |
|---|---|---|---|
| `product_id` | UUID | no | Explicit catalog product — **strict**: unresolvable → 400 `INVALID_PRODUCT`; inactive → 400 `PRODUCT_INACTIVE` |
| `product_sku` | string | no | ≤120 — resolve by SKU. **Tolerant**: no match → the line keeps its literal title with `product_id: null`; an **inactive** match still rejects (`PRODUCT_INACTIVE`) |
| `product_external_id` | string | no | ≤255 — resolve by your external product id; same tolerant semantics as SKU |
| `title` | string | required unless a product resolves | ≤300 — when a product resolves, the line title **derives from the product name** (any client-sent title is ignored); no product and no title → 400 `"Order items require a title or product_id"` |
| `sku` | string | no | ≤120 — denormalized SKU snapshot on the line (falls back to `product_sku`) |
| `unit_price` | number | no | 0 – 9,999,999,999. Omitted with a priced product → the product's price. Omitted with a **dynamic-priced** product (no catalog price) → 400 `ORDER_ITEM_PRICE_REQUIRED`. Omitted with no product → 0 |
| `quantity` | number | no | Positive; decimals allowed; default 1 |
| `discount_percent` | number | no | 0–100 (percent-only per-line discount) |

A product reference is resolved in order: `product_id` → `product_sku` → `product_external_id` (first provided wins).

### Contact resolution

Shared with the [contacts upsert](contacts.md#post-apiv1contacts--upsert) (same as deals and payments):

- `contact_id` wins when present (validated for workspace membership → 404 `"Contact not found"`).
- Otherwise `phone`/`email` are upserted exactly like `POST /v1/contacts`: normalized phone match wins, email is the fallback; a match **updates** that contact, no match **creates** one.
- Phone resolving to one contact and email to a different one → **409 `CONTACT_MERGE_REQUIRED`** with a `merge_request_id` (a merge request is parked; the order is **not** created — see [contacts](contacts.md#identity-conflict--409-contact_merge_required)).
- Neither `contact_id` nor `phone`/`email` → **400** `"Provide contact_id, or a phone/email to attach the order to a contact"`.

### Idempotent upsert via `external_reference`

`external_reference` is unique per workspace. A repeat POST with a matching value **updates that order instead of creating a duplicate** — this is race-safe: a concurrent create that loses the uniqueness race is automatically retried as an update against the winner.

- **Always updated (when present in the body):** `note`, `coupon_codes`, `placed_at`, `deal_id`.
- **Money fields** (`items`, `currency`, `discount_total`, `shipping_total`, `tax_total`) apply **only while the order is still `pending`** — once paid, money is locked and repeat POSTs silently skip these fields; corrections flow through refunds/cancel.
- **`financial_status` is never changed on a match** — an exact replay of a created-as-paid POST is a clean no-op; status moves ride the mark-paid/cancel/refund endpoints. A repeat POST can never resurrect a cancelled order.
- **The contact is never re-pointed** on a match (unlike deals, where a repeat POST re-applies the resolved contact). Contact resolution still runs first, so a repeat POST must still carry `contact_id` or `phone`/`email` — and phone/email upsert side effects still run on the contact itself.
- Response: 201 with the full updated order (no `duplicate` marker — see above).

A direct-conflict 409 (`error_code: "ORDER_REFERENCE_EXISTS"`, message `"An order with this external_reference already exists."`) exists in the contract but is resolved automatically by the retry-as-update path — callers should not normally observe it.

### Example

```bash
curl -X POST "https://app.otok.io/api/v1/orders" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+972501234567",
    "email": "dana@example.com",
    "name": "Dana Levi",
    "currency": "ILS",
    "shipping_total": 20,
    "items": [
      { "product_sku": "WGT-1", "quantity": 2, "unit_price": 120 },
      { "title": "Gift wrap", "unit_price": 100 }
    ],
    "coupon_codes": ["SUMMER10"],
    "external_reference": "shop-order-1042"
  }'
```

Response `201`:

```json
{
  "id": "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9",
  "workspace_id": "…",
  "contact_id": "9c2f1a4e-3b7d-4e2a-9f0c-1d2e3f4a5b6c",
  "contact_name": "Dana Levi",
  "contact_phone": "+972501234567",
  "contact_email": "dana@example.com",
  "order_number": 1042,
  "number": null,
  "platform": "api",
  "source": "api",
  "store_connection_id": null,
  "store_domain": null,
  "external_order_id": null,
  "external_reference": "shop-order-1042",
  "deal_id": null,
  "financial_status": "pending",
  "fulfillment_status": "unfulfilled",
  "currency": "ILS",
  "total": 360,
  "subtotal": 340,
  "discount_total": 0,
  "shipping_total": 20,
  "tax_total": 0,
  "refunded_total": 0,
  "item_count": 3,
  "first_item_name": "Widget",
  "coupon_codes": ["SUMMER10"],
  "placed_at": "2026-07-14T10:00:00.000Z",
  "paid_at": null,
  "cancelled_at": null,
  "refunded_at": null,
  "external_updated_at": null,
  "payment_reference": null,
  "payment_synced_at": null,
  "note": null,
  "metadata": null,
  "created_by": null,
  "created_at": "2026-07-14T10:00:00.000Z",
  "updated_at": "2026-07-14T10:00:00.000Z",
  "items": [
    {
      "id": "11a2b3c4-…",
      "workspace_id": "…",
      "order_id": "0a1b2c3d-…",
      "position": 0,
      "product_id": "77e8f9a0-…",
      "external_product_id": null,
      "title": "Widget",
      "sku": "WGT-1",
      "quantity": 2,
      "unit_price": 120,
      "discount_percent": null,
      "line_total": 240,
      "created_at": "2026-07-14T10:00:00.000Z"
    },
    {
      "id": "22b3c4d5-…",
      "workspace_id": "…",
      "order_id": "0a1b2c3d-…",
      "position": 1,
      "product_id": null,
      "external_product_id": null,
      "title": "Gift wrap",
      "sku": null,
      "quantity": 1,
      "unit_price": 100,
      "discount_percent": null,
      "line_total": 100,
      "created_at": "2026-07-14T10:00:00.000Z"
    }
  ],
  "refunds": []
}
```

### Errors

| Status | Code / message | Meaning |
|---|---|---|
| 400 | validation array | Body violations — unknown properties rejected; length/range/enum/ISO-8601 checks per the tables above |
| 400 | `"Provide contact_id, or a phone/email…"` | No contact reference |
| 400 | `"Order items require a title or product_id"` | Line with neither |
| 400 | `INVALID_PRODUCT` / `PRODUCT_INACTIVE` | Explicit `product_id` unresolvable / product inactive (an inactive SKU / external-id match also rejects) |
| 400 | `ORDER_ITEM_PRICE_REQUIRED` | Dynamic-priced product without an explicit `unit_price` |
| 400 | `"placed_at is not a valid date"` | The value passed ISO-8601 syntax but is not a real date |
| 400 | `"discount_total must be a non-negative number"` (etc.) | Money-field checks |
| 403 | `FEATURE_NOT_INCLUDED_IN_PLAN` | Plan lacks the Orders feature (body has no `statusCode` field) |
| 403 | `PLAN_LIMIT_EXCEEDED` | `"Plan limit reached for max_orders (N)…"` — orders are uncapped by default on all plans; this appears only when a cap has been set on the workspace |
| 404 | `"Contact not found"` | `contact_id` not in this workspace |
| 404 | `ORDER_DEAL_NOT_FOUND` | `deal_id` unknown to the workspace |
| 409 | `ORDER_DEAL_CONTACT_MISMATCH` | `deal_id` belongs to another contact |
| 409 | `CONTACT_MERGE_REQUIRED` | Phone and email resolve to two different contacts |
| 409 | `ORDER_REFERENCE_EXISTS` | Reference collision — normally resolved automatically as an update; not typically observable |

(`error_code` values appear as an `error_code` field on the response body.)

### Side effects

Creation fires the workspace's **order-created automations** (plus **order-paid** when created as `paid`), writes the contact's activity timeline, and emits registered `order.created` (and `order.paid`) [webhooks](webhooks.md#order-events). A paid create also records a completed payment for the full order total, in the order's currency, on the contact's payment history. API writes are attributed to source `api` with no acting user.

## POST /api/v1/orders/:id/refunds

Appends to the order's refund ledger, rolls the financial status to `partially_refunded`/`refunded`, mirrors the refund into the recorded payment, and fires the **order-refunded automations** + the `order.refunded` webhook.

### Request body

| Field | Type | Required | Constraints |
|---|---|---|---|
| `amount` | number | yes | Positive, in the order's currency; must not exceed the remaining total (`total` − `refunded_total`) |
| `external_refund_id` | string | no | ≤255 — **the idempotency key**: a repeat POST with the same value applies nothing and returns `duplicate: true`. **Without it, refunds are NOT idempotent** — every POST appends a new refund. Supply it whenever your system can retry |
| `reason` | string | no | ≤1000 |
| `refunded_at` | string | no | ISO 8601; defaults to now |

The example continues the order created [above](#example), assuming it was first [marked paid](#post-apiv1ordersidmark-paid) — refunding a never-paid order returns 400 `ORDER_NEVER_PAID`.

```bash
curl -X POST "https://app.otok.io/api/v1/orders/0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9/refunds" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{ "amount": 50, "external_refund_id": "r-1", "reason": "damaged" }'
```

### Response `201`

```json
{
  "duplicate": false,
  "order": {
    "id": "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9",
    "financial_status": "partially_refunded",
    "refunded_total": 50,
    "refunded_at": "2026-07-15T09:30:00.000Z",
    "…": "…full order object with items + refunds…",
    "refunds": [
      {
        "id": "33c4d5e6-…",
        "workspace_id": "…",
        "order_id": "0a1b2c3d-…",
        "external_refund_id": "r-1",
        "amount": 50,
        "currency": "ILS",
        "reason": "damaged",
        "refunded_at": "2026-07-15T09:30:00.000Z",
        "created_at": "2026-07-15T09:30:00.000Z"
      }
    ]
  }
}
```

`duplicate: true` means the `external_refund_id` was already recorded on this order — nothing was applied and the current order state is returned.

### Semantics

- Refunds require the order to have **ever been paid** (`paid_at` set — a `partially_paid` order qualifies). Never-paid → 400 `error_code: "ORDER_NEVER_PAID"`, message `"Cannot refund an order that was never paid."`.
- A refund that exhausts the remaining total moves `financial_status` to `refunded`; a partial one to `partially_refunded`. These states are reachable **only** through refunds — never through a status endpoint.
- Refunding a cancelled-but-paid order is allowed — cancellation doesn't touch the money axis.
- `refunded_at` is stamped on the order header with each refund.
- An amount exceeding the remaining total → 400 `"Refund amount exceeds the order's remaining total (X)"`.

### Errors

| Status | Code / message |
|---|---|
| 400 | `ORDER_NEVER_PAID`; `"Refund amount must be a positive number"`; `"Refund amount exceeds the order's remaining total (…)"`; `"refundedAt is not a valid date"`; validation array |
| 403 | `FEATURE_NOT_INCLUDED_IN_PLAN` |
| 404 | `"Order not found"` |
| 409 | `STORE_SYNCED_READ_ONLY` — [store-synced orders](#store-provenance-fields) only |

## POST /api/v1/orders/:id/mark-paid

Moves the financial status to `paid`, records the payment (a completed one-time payment for the full order total, in the order's currency, on the contact's payment history) — or **links onto an existing payment** via `payment_reference` — and fires the **order-paid automations** + the `order.paid` webhook.

### Request body (all optional)

| Field | Type | Notes |
|---|---|---|
| `payment_reference` | string | ≤255 — the `external_reference` of an **existing** payment (e.g. one your system already recorded via [`POST /v1/payments`](payments.md)) to link the order onto instead of recording a new payment. Link-only — the payment's amount is never rewritten |

```bash
curl -X POST "https://app.otok.io/api/v1/orders/0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9/mark-paid" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{ "payment_reference": "shop-charge-1042" }'
```

Response `201` — the full order object.

### Transition rules

| From | `mark-paid` allowed? |
|---|---|
| `pending` | yes |
| `partially_paid` | yes |
| `paid` | **no-op success** — 201, no side effects, no duplicate automations |
| `refunded` / `partially_refunded` / `voided` | **409** `error_code: "ORDER_ILLEGAL_TRANSITION"`, message `"Illegal status transition <from> → paid. Refund states are set by recording refunds."` |

`paid_at` is stamped on first entry into a paid state and is historical — it is kept through later refund states.

### Errors

The `ORDER_PAYMENT_*` codes validate `payment_reference` and are checked **before** linking:

| Status | Code / message | Meaning |
|---|---|---|
| 403 | `FEATURE_NOT_INCLUDED_IN_PLAN` | Plan lacks the Orders feature |
| 404 | `"Order not found"` | Unknown id or another workspace's order |
| 404 | `ORDER_PAYMENT_REFERENCE_NOT_FOUND` | No payment in this workspace matches the reference |
| 409 | `ORDER_ILLEGAL_TRANSITION` | Refund states / `voided` — see the [transition rules](#transition-rules) above |
| 409 | `ORDER_PAYMENT_CONTACT_MISMATCH` | The payment belongs to another contact |
| 409 | `ORDER_PAYMENT_NOT_LINKABLE` | Not a one-time payment with a completed charge |
| 409 | `ORDER_PAYMENT_ALREADY_LINKED` | The order is already linked to a **different** payment reference (re-sending the same reference is fine) |
| 409 | `STORE_SYNCED_READ_ONLY` | [Store-synced orders](#store-provenance-fields) only |

## POST /api/v1/orders/:id/cancel

Stamps `cancelled_at` and fires the **order-cancelled automations** + the `order.cancelled` webhook. No request body.

```bash
curl -X POST "https://app.otok.io/api/v1/orders/0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9/cancel" \
  -H "Authorization: Bearer otok_live_abc123..."
```

Response `201` — the full order object.

Semantics:

- Cancellation is a **stamp, not a status**: `financial_status` keeps its last state — recorded revenue stands until a refund is recorded. Cancel a paid order, then record refunds as money is actually returned.
- **Idempotent:** cancelling an already-cancelled order is a 201 no-op (no duplicate automations).
- A cancelled `pending` order can still be marked paid later — the cancellation stamp is workflow state on the fulfillment side and does not block later payment transitions.

| Status | Meaning |
|---|---|
| 403 | `FEATURE_NOT_INCLUDED_IN_PLAN` |
| 404 | `"Order not found"` |
| 409 | `STORE_SYNCED_READ_ONLY` — [store-synced orders](#store-provenance-fields) only |
