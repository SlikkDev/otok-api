# Sales

The **sales ledger**: what each contact bought. A sale is a **header** (the buyer, a per-workspace sale number, the currency, the owner) over one or more **line items** — each a product from the [catalog](products.md), optionally in a [product cycle](product-cycles.md), with a quantity and a price. Money is linked to a sale, never inferred: charges recorded on the contact's [payments](payments.md) ledger are **allocated** to the sale, and the sale's **settlement status** (`unpaid` → `partially_paid` → `paid`, and on to `partially_refunded` / `refunded`) is derived from the allocated money.

Recording a sale **does not charge anyone** — it records that the sale happened. Collect money with a [payment request](payment-requests.md), record it on the [payments](payments.md) ledger and [allocate](#post-apiv1salesidallocations) it to the sale, or let the app do it: sales are also created automatically when a quote is accepted, an order is paid, a pay-link for a product is paid, a booking deposit or a priced event registration is collected — those sales appear here too, with their own `source`.

Sale writes fire the workspace's sale automations and the opt-in [`sale.*` webhooks](webhooks.md#sale-events) exactly as in-app writes do.

All endpoints require [authentication](getting-started.md#authentication).

> **Plan feature required:** every route on this page requires the **Sales** feature (`sales`) on the workspace's plan, in addition to API access. Without it, all calls return `403` with `error_code: "FEATURE_NOT_INCLUDED_IN_PLAN"` — see [feature-gated resource groups](getting-started.md#feature-gated-resource-groups). The Sales feature is included on every plan, so in practice this error appears only when the feature has been switched off for a specific workspace.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/sales` | List sales (filterable, paginated) |
| GET | `/api/v1/sales/:id` | Get a sale with its items, payments, pay-links and documents |
| POST | `/api/v1/sales` | Record a sale (idempotent via `external_reference`) |
| PATCH | `/api/v1/sales/:id` | Edit the sale's note |
| DELETE | `/api/v1/sales/:id` | Delete an unfunded, unlinked sale — **needs the "Allow permanent deletion" key capability** |
| POST | `/api/v1/sales/:id/cancel` | Cancel the sale (or some of its items), optionally refunding it |
| POST | `/api/v1/sales/:id/reinstate` | Reinstate cancelled items |
| POST | `/api/v1/sales/:id/refund` | Refund a charge that funds this sale — **needs the "Allow refunds" key capability** |
| PUT | `/api/v1/sales/:id/owner` | Assign or clear the sale's owner |
| PUT | `/api/v1/sales/:id/deal` | Link or unlink one of the buyer's deals |
| POST | `/api/v1/sales/:id/allocations` | Allocate an existing charge to this sale |
| DELETE | `/api/v1/sales/:id/allocations/:allocationId` | Release an allocation (no money moves) — **needs the "Allow permanent deletion" key capability** |

All POSTs return **201**, including the action routes; `GET`, `PATCH`, `PUT` and `DELETE` return **200**. Path ids must be UUIDs (a non-UUID id returns 400). Coded errors use the standard error shape extended with an `error_code` field — key on `error_code`, not on the message text.

## API key capabilities

Two routes move or destroy data beyond what an ordinary key may do. Each needs a capability that only the **workspace owner** can turn on for a key, in **Settings → Developers**:

| Capability | Setting in the app | Needed for |
|---|---|---|
| `allow_money_out` | **Allow refunds** | `POST /v1/sales/:id/refund`, and `POST /v1/sales/:id/cancel` with a `money.mode` other than `keep`. Also unlocks the money-out details on `GET /v1/sales/:id` (see [the sale view](#get-apiv1salesid)) |
| `allow_hard_delete` | **Allow permanent deletion through the API** | `DELETE /v1/sales/:id` and `DELETE /v1/sales/:id/allocations/:allocationId` |

Without the capability the call is refused **before anything is written**:

| Status | `error_code` | Message |
|---|---|---|
| 403 | `API_KEY_MONEY_OUT_DISABLED` | `"This API key does not allow refunds. An owner can enable money-out access in API key settings."` |
| 403 | `HARD_DELETE_OWNER_ONLY` | `"Permanent deletion is restricted to the workspace owner. Archive the record instead, or ask an owner to delete it."` |

New keys start with both capabilities off.

## The sale object

**Money is numeric.** Every money field serializes as a **JSON number** rounded to 2 decimals, in the sale's currency. A sale has **one currency**: its items and the money allocated to it are summed without conversion.

| Field | Type | Notes |
|---|---|---|
| `id` | UUID | |
| `workspace_id` | UUID | |
| `number` | integer | Per-workspace running sale number, assigned at create |
| `contact_id` | UUID | **The buyer.** The contact who paid may differ (see [allocations](#allocations)) |
| `deal_id` | UUID or `null` | A [deal](deals.md) of the same buyer, when linked |
| `owner_user_id` | UUID or `null` | The responsible team member, or `null` (unowned) |
| `created_by` | UUID or `null` | The team member who recorded it — `null` for API- and automation-recorded sales |
| `currency` | string | 3-letter uppercase code |
| `vat_mode` / `vat_rate` | enum / number, or `null`s | The sale's VAT posture — `inclusive` / `exclusive` with a 0–100 rate; always both or neither |
| `expects_payment` | boolean | `false` = a record only: with no money linked, the sale reads `untracked` instead of `unpaid` |
| `sold_at` | ISO 8601 | When the sale happened |
| `note` | string or `null` | |
| `source` | string | Where the sale was recorded — `api`, `manual` (in-app), `automation`, or the record that created it: `quote`, `order`, `payment_request`, `recurring`, `booking`, `event`, `form`, `store`, … **Tolerate unknown values** |
| `external_reference` | string or `null` | **Your idempotency key** (see [create](#post-apiv1sales)), or a system key on sales the app created from another record |
| `status` | enum | `active`, `partially_cancelled` (some items cancelled), `cancelled` (every item cancelled) |
| `line_count` | integer | Every item, cancelled ones included |
| `total_amount` | number or `null` | Sum of the **active** priced items' line totals; `null` while no active item has a price |
| `has_unpriced_lines` | boolean | An active item has no price, so the total is open |
| `paid_total` | number | Money allocated to the sale from completed charges |
| `refunded_total` | number | Money refunded from the sale |
| `pending_refund_total` | number | Refunds started but not yet settled |
| `settlement_status` | enum | See below |
| `created_at` / `updated_at` | ISO 8601 | `updated_at` moves on edits, not on money changes |

Read responses may carry additional fields — tolerate unknown keys.

### Settlement status

`settlement_status` is derived from the sale's own totals — you never set it:

| Value | Meaning |
|---|---|
| `untracked` | `expects_payment` is `false` and no money is linked |
| `unpaid` | No money yet |
| `partially_paid` | Some money, less than the total |
| `paid` | The allocated money covers the total |
| `partially_refunded` | Some of the money was refunded |
| `refunded` | All of the money was refunded |

### Items

Each line of a sale:

| Field | Type | Notes |
|---|---|---|
| `id` | UUID | The **item** id — what `cancel` / `reinstate` take in `items` |
| `sale_id` | UUID | The sale it belongs to |
| `position` | integer | Line order, 0-based |
| `contact_id` | UUID | The buyer |
| `recipient_contact_id` | UUID or `null` | Who receives the product, when it is not the buyer (`null` = the buyer) |
| `product_id` | UUID or `null` | The catalog product (`null` only after the product was deleted) |
| `cycle_id` | UUID or `null` | The product cycle, when the line is in one |
| `title` | string | The product's name, **frozen** at the time of sale |
| `quantity` | integer | |
| `unit_amount` | number or `null` | Price per unit; `null` = unpriced |
| `discount_percent` | number or `null` | Per-line discount, 0–100 |
| `line_total` | number or `null` | `quantity × unit_amount × (1 − discount_percent / 100)`, rounded to the cent; computed by the server, `null` while unpriced |
| `currency` | string | The sale's currency |
| `purchased_at` | ISO 8601 | The sale's `sold_at` |
| `note` / `source` | string or `null` / string | |
| `status` | enum | `active` or `cancelled` |
| `cancelled_at` / `cancel_reason` / `cancel_note` | | Set while the item is cancelled |
| `created_at` / `updated_at` | ISO 8601 | |

### Allocations

An **allocation** says "this much of that charge funds this sale". A charge is a payment **entry** on the [payments](payments.md) ledger — one charge can fund several sales, and one sale can be funded by several charges, from the buyer or from someone else. Refunds of a charge appear as **negative** allocations on the sales that charge funds.

| Field | Type | Notes |
|---|---|---|
| `id` | UUID | |
| `sale_id` | UUID | |
| `payment_entry_id` | UUID | The charge (or refund) entry |
| `payment_id` | UUID | That entry's payment |
| `amount` | number | Positive for a charge, negative for a refund |
| `currency` | string | |
| `source` | string | Who linked it |
| `created_by` | UUID or `null` | |
| `created_at` | ISO 8601 | |

## GET /api/v1/sales

Dedicated query parameters with the deals/payments pagination family — see [where deals and payments differ](getting-started.md#where-deals-and-payments-differ). Ordered by `sold_at` descending (newest first). List rows are bare sale headers — no items, allocations or buyer details.

| Param | Type | Notes |
|---|---|---|
| `contact_id` | UUID | The buyer. Malformed → 400 `"Invalid contact_id: must be a UUID"` |
| `owner_user_id` | UUID | Malformed → 400 |
| `status` | enum | `active`, `partially_cancelled`, `cancelled` — an unknown value returns **400** `"Invalid sale status"` |
| `settlement_status` | enum | `untracked`, `unpaid`, `partially_paid`, `paid`, `partially_refunded`, `refunded` — an unknown value returns **400** `"Invalid settlement status"` |
| `external_reference` | string | Exact match — look a sale up by your own key |
| `limit` | integer | Default **25**, cap 100 (larger values are clamped). Malformed → 400 `"Invalid limit: must be a non-negative integer"` |
| `offset` | integer | Default 0. Malformed → 400 |

```bash
curl -G "https://app.otok.io/api/v1/sales" \
  -H "Authorization: Bearer otok_live_abc123..." \
  --data-urlencode 'contact_id=9c2f1a4e-3b7d-4e2a-9f0c-1d2e3f4a5b6c' \
  --data-urlencode 'settlement_status=unpaid'
```

Response `200` — `{ data, total, limit, offset }`.

## GET /api/v1/sales/:id

The full sale view — everything the in-app sale page shows. `404` — `"Sale not found"`.

| Field | Notes |
|---|---|
| `tier` | How much money detail this response carries: `1` for an ordinary key, `2` for a key with **Allow refunds** |
| `sale` | The [sale object](#the-sale-object), plus: `buyer` (`{ id, name, phone, email, owner_user_id, anonymised_at }`), `owner` and `created_by_user` (`{ id, full_name, email }` or `null`), `outstanding` (`total_amount − paid_total + refunded_total`, or `null` while the total is open), `allocatable` (how much more money the sale can take, or `null`), `possible_duplicates` (other non-cancelled sales of the same buyer sharing a product within 30 days either side, where at least one of the two was created automatically from another record — two hand-recorded repeat purchases are not flagged: `{ id, number, source, sold_at, status, shared_product_ids }`; informational only), and — only when the sale's currency differs from the workspace currency — `fx` (`{ workspace_currency, rate, converted_total, warning }`) |
| `items` | The [items](#items) in line order, each with `product` (`{ id, name, is_active }` or `null`) and `cycle` (`{ id, name, starts_on, ends_on }` or `null`) |
| `allocations` | One row per charge funding the sale: `{ allocation, entry, payment, payer, payer_is_other_contact, remaining, twins }` — the [allocation](#allocations), the payment entry and payment it points at, the payer (`{ id, name }`), the charge's remaining refundable balance, and `twins` (that charge's refunds on this sale, `{ allocation, entry }`) |
| `pay_links` | [Payment requests](payment-requests.md) minted for this sale: `{ id, status, amount, currency, title, charge_kind, contact_id, contact_payment_id, expires_at, paid_at, cancelled_at, created_at }` (with **Allow refunds**, also the provider and test-mode flag) |
| `related` | `{ deal, quotes, orders }` — the linked deal (`{ id, title, status }` or `null`) and the quotes / orders that point at this sale (`{ id, number, status }`) |
| `documents` | The sale's financial documents (invoices, receipts, credit documents) — the same item shape as [`GET /v1/contacts/:id/documents`](contacts.md#get-apiv1contactsiddocuments) |
| `timeline` | The sale's history, newest last: `{ kind, at, id, … }` with `kind` = `activity`, `settlement`, or `item_transition`. Tolerate unknown kinds |
| `actions` | For each action (`cancel`, `reinstate`, `refund`, `allocate`, `unallocate`, `setOwner`, `linkDeal`, `edit`, `delete`, …), a prediction `{ allowed, blockers }` of whether that route would accept the call right now, with `blockers` naming the codes it would refuse with. Informational — the routes stay authoritative. Tolerate unknown actions and codes |
| `money` | **Allow refunds only.** `{ charges: [...] }` — one entry per charge funding the sale, with `paymentId`, `entryId`, the charge's `net` share of this sale, its refundable `remaining`, the `amount` a refund of this sale would take from it, and `route` (`gateway` = refundable through the connected payment provider, `recorded_outside` / `ledger_only` = books-only, `blocked`) with `blockers`. Use `entryId` as the `entry_id` of [a refund](#post-apiv1salesidrefund) |
| `incidents` | **Allow refunds only.** Open payment issues on the sale's charges that need follow-up in the app |

A section that does not apply to the key's tier is **omitted**, not `null`.

## POST /api/v1/sales

Records a sale. **Does not charge the buyer.**

### Request body

| Field | Type | Required | Constraints |
|---|---|---|---|
| `contact_id` | UUID | **yes** | The buyer — an existing contact of this workspace |
| `items` | object[] | **yes** | 1–100 [items](#item-shape) |
| `currency` | string | no | Exactly 3 letters, uppercased. Omitted → the workspace payment currency |
| `sold_at` | string | no | ISO 8601. Omitted → now (backdating is allowed) |
| `note` | string or `null` | no | ≤2000 |
| `deal_id` | UUID or `null` | no | A deal **of the same buyer** |
| `owner_user_id` | UUID or `null` | no | An active team member. **Omitted → the buyer's owner** (while still a member), else unowned; `null` → unowned |
| `external_reference` | string or `null` | no | ≤200 — **idempotency key**, unique per workspace (see below) |
| `vat_mode` | enum or `null` | no | `inclusive`, `exclusive` — always **together** with `vat_rate`. Omitted → the products' shared VAT setting when every item's product agrees, else the workspace default |
| `vat_rate` | number or `null` | no | 0 – 100, ≤2 decimals — always together with `vat_mode` |
| `expects_payment` | boolean | no | Default `true`. `false` records the sale for history only — with no money linked it reads `untracked` |

### Item shape

| Field | Type | Required | Constraints |
|---|---|---|---|
| `product_id` | UUID | **yes** | An **active** catalog product |
| `cycle_id` | UUID or `null` | no | An open cycle **of this product**. Required when the product's sales must be attributed to a cycle |
| `quantity` | integer | no | 1 – 100,000. Default 1 |
| `unit_amount` | number or `null` | no | 0 – 1,000,000,000, ≤2 decimals. **Omitted → the catalog price** (the cycle's price, else the product's). A different price is accepted only when the product (or cycle) allows price overrides — otherwise 400 `SALE_PRICE_LOCKED`. `null` records the line unpriced, which leaves the sale's total open |
| `discount_percent` | number or `null` | no | 0 – 100, ≤2 decimals |
| `recipient_contact_id` | UUID | no | Who receives the product, when it is not the buyer — an existing contact |

Each line's `title` is the product's name at the time of sale.

### Idempotency via `external_reference`

A POST whose `external_reference` matches an existing sale **writes nothing** and returns that sale with `duplicate: true` — concurrent duplicates included. The body of the replay is not compared with the original. Use your own system's order or invoice id.

Some prefixes are **reserved** for sales the app records from its own records: a reference starting with `order:`, `quote:`, `pr:`, `cycle:`, `store:`, `cardcom:`, `form:`, `booking:`, or `event:` returns 400 `RESERVED_EXTERNAL_REFERENCE`. You can still *look up* such sales with `GET /v1/sales?external_reference=…`.

### Example

```bash
curl -X POST "https://app.otok.io/api/v1/sales" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{
    "contact_id": "9c2f1a4e-3b7d-4e2a-9f0c-1d2e3f4a5b6c",
    "items": [
      { "product_id": "2b3c4d5e-6f70-8192-a3b4-c5d6e7f8091a", "quantity": 1 },
      { "product_id": "3c4d5e6f-7081-92a3-b4c5-d6e7f8091a2b", "unit_amount": 120, "discount_percent": 10 }
    ],
    "currency": "ILS",
    "external_reference": "crm-invoice-4471"
  }'
```

Response `201`:

```json
{
  "sale": {
    "id": "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d",
    "number": 1042,
    "contact_id": "9c2f1a4e-3b7d-4e2a-9f0c-1d2e3f4a5b6c",
    "deal_id": null,
    "owner_user_id": "708192a3-b4c5-d6e7-f809-1a2b3c4d5e6f",
    "currency": "ILS",
    "vat_mode": "inclusive",
    "vat_rate": 18,
    "expects_payment": true,
    "sold_at": "2026-10-01T09:00:00.000Z",
    "source": "api",
    "external_reference": "crm-invoice-4471",
    "status": "active",
    "line_count": 2,
    "total_amount": 458,
    "has_unpriced_lines": false,
    "paid_total": 0,
    "refunded_total": 0,
    "pending_refund_total": 0,
    "settlement_status": "unpaid"
  },
  "items": [
    { "id": "6b7c8d9e-…", "position": 0, "title": "Onboarding session", "quantity": 1, "unit_amount": 350, "discount_percent": null, "line_total": 350, "status": "active" },
    { "id": "7c8d9e0f-…", "position": 1, "title": "Workbook", "quantity": 1, "unit_amount": 120, "discount_percent": 10, "line_total": 108, "status": "active" }
  ],
  "duplicate": false
}
```

(Abridged — full sale and item objects are returned.)

### Errors

| Status | Code / message | Meaning |
|---|---|---|
| 400 | validation messages | Missing `items`, more than 100 items, bad UUIDs, out-of-range numbers, unknown fields |
| 400 | `INVALID_PRODUCT` / `PRODUCT_INACTIVE` | The product is not in this workspace / is inactive |
| 400 | `INVALID_CYCLE` / `CYCLE_PRODUCT_MISMATCH` / `CYCLE_ARCHIVED` / `CYCLE_CANCELLED` | The cycle is unknown, belongs to another product, or is closed |
| 400 | `CYCLE_REQUIRED` | The product's sales must be attributed to a cycle |
| 400 | `SALE_PRICE_LOCKED` | A `unit_amount` that differs from the catalog price on a product (or cycle) that does not allow overrides |
| 400 | `"vat_mode and vat_rate must be provided together"` | A lone VAT leg |
| 400 | `RESERVED_EXTERNAL_REFERENCE` | The `external_reference` uses a reserved prefix |
| 400 | `INVALID_CONTACT_OWNER` | `owner_user_id` is not an active team member |
| 403 | `FEATURE_NOT_INCLUDED_IN_PLAN` | Plan lacks the Sales feature |
| 404 | `"Contact not found"` / `"Deal not found"` | Unknown buyer, recipient, or deal in this workspace |
| 409 | `SALE_DEAL_CONTACT_MISMATCH` | The deal belongs to another contact |
| 409 | `CYCLE_FULL` | The cycle is at capacity |
| 409 | `CONTACT_ANONYMISED` | The buyer was anonymised — no new sale can be recorded for them |

### Side effects

The sale appears on the buyer's activity timeline, the workspace's **sale-recorded automations** fire once for the sale, and [`sale.recorded`](webhooks.md#sale-events) is delivered. Each item gives the buyer — or the item's `recipient_contact_id` — access to the product. The buyer is subscribed (as a customer) on the channels they can be reached on, unless they opted out. A replay (`duplicate: true`) does none of this.

## PATCH /api/v1/sales/:id

Edits the sale's note — the only editable header field; money, items, and the buyer are fixed once recorded.

| Field | Type | Notes |
|---|---|---|
| `note` | string or `null` | ≤2000. `null` clears it |

Response `200` — the sale object. An empty body returns 400 `"Provide a note to update (null clears it)."`; `404` — `"Sale not found"`.

## POST /api/v1/sales/:id/cancel

Cancels every active item of the sale, or only the items listed. Cancelling **keeps the money** unless you ask otherwise.

| Field | Type | Required | Constraints |
|---|---|---|---|
| `reason` | enum | **yes** | `customer_request`, `duplicate`, `mistake`, `not_delivered`, `payment_failed`, `fraud`, `other` |
| `items` | UUID[] | no | ≤100 item ids of this sale. Omitted → every active item |
| `note` | string or `null` | no | ≤2000 |
| `money` | object | no | What happens to the money — omitted = `{ "mode": "keep" }` |
| `money.mode` | enum | yes (in `money`) | `keep` (money stays on the sale), `refund` (refund every charge funding the sale — through the connected payment provider where the charge was taken through one, otherwise recorded), `recorded_outside` (record the refunds as returned outside oToK) |
| `money.reason` | enum | no | The refund reason printed on the credit document — `requested_by_customer`, `duplicate`, `fraudulent`, `order_change`, `product_unsatisfactory`, `sale_cancelled`, `refunded_outside`, `chargeback`, `other`. Default `sale_cancelled` |

Rules:

- A `money.mode` other than `keep` needs the key's **Allow refunds** capability (403 `API_KEY_MONEY_OUT_DISABLED`, checked before anything is cancelled), and applies to a **full** cancel only — listing a strict subset of the active items with a money mode returns 400 `PARTIAL_CANCEL_KEEPS_MONEY` (refund from [the refund route](#post-apiv1salesidrefund) instead).
- The items are cancelled **first**; the refunds run afterwards, one per funding charge, each capped at what is still refundable. A refused refund **does not undo the cancellation** — it is reported in `refunds[]` with an `errorCode`.
- A **full** cancel also withdraws the sale's pending pay-links, waives an unpaid booking deposit the sale was created for, and — when the workspace's sales settings say so — cancels the order the sale was created from.

```bash
curl -X POST "https://app.otok.io/api/v1/sales/5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d/cancel" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{ "reason": "customer_request", "money": { "mode": "refund" } }'
```

Response `201`:

| Field | Notes |
|---|---|
| `sale` | The sale after the cancel |
| `cancelled` | The items this call cancelled |
| `refunds` | One outcome per funding charge (empty for `keep`): `{ paymentId, entryId, amount, remaining, mode, outcome?, refundEntryId?, incidentId?, errorCode?, error? }`. `mode` is `auto` (through the provider where possible) or `recorded_outside`; `outcome` is the [refund outcome](#refund-outcomes); `errorCode`/`error` describe a refused refund (`NOTHING_TO_REFUND` when the charge had nothing left) |
| `pay_links_cancelled` | How many pending pay-links of the sale were withdrawn |

| Status | Code / message | Meaning |
|---|---|---|
| 400 | `PARTIAL_CANCEL_KEEPS_MONEY` | A money mode with a partial item list |
| 400 | validation messages | Missing/unknown `reason`, bad `money.mode` |
| 403 | `API_KEY_MONEY_OUT_DISABLED` | A money mode without **Allow refunds** |
| 404 | `"Sale not found"` / `"Purchase not found"` | Unknown sale, or a listed item that is not on this sale |
| 409 | `SALE_ALREADY_CANCELLED` | Nothing active left to cancel |
| 409 | `PURCHASE_ALREADY_CANCELLED` | A listed item is already cancelled |

Each cancelled item fires the **sale-cancelled automations** and a [`sale.cancelled`](webhooks.md#sale-events) webhook.

## POST /api/v1/sales/:id/reinstate

Reinstates every cancelled item of the sale, or only the items listed.

| Field | Type | Required | Constraints |
|---|---|---|---|
| `items` | UUID[] | no | ≤100 item ids of this sale. Omitted → every cancelled item |

Response `201` — `{ sale, reinstated }`. Money is not touched. Reinstating fires no webhook.

| Status | Code / message | Meaning |
|---|---|---|
| 404 | `"Sale not found"` / `"Purchase not found"` | Unknown sale or item |
| 409 | `SALE_NOT_CANCELLED` / `PURCHASE_NOT_CANCELLED` | Nothing cancelled to reinstate / a listed item is not cancelled |
| 409 | `CYCLE_FULL` | The item's cycle has no room left |

## POST /api/v1/sales/:id/refund

Refunds **one charge** that funds this sale. The items stay active — to cancel *and* refund in one call, use [cancel](#post-apiv1salesidcancel) with a `money.mode`.

> Needs the key's **Allow refunds** capability — 403 `API_KEY_MONEY_OUT_DISABLED` otherwise.

| Field | Type | Required | Constraints |
|---|---|---|---|
| `reason` | enum | **yes** | `requested_by_customer`, `duplicate`, `fraudulent`, `order_change`, `product_unsatisfactory`, `sale_cancelled`, `refunded_outside`, `chargeback`, `other` |
| `mode` | enum | **yes** | `auto` — refund through the connected payment provider when the charge was taken through one (needs the **Workspace payments** feature; 409 `PLAN_FEATURE_REQUIRED` otherwise); `recorded_outside` — record the refund only, the money was (or will be) returned outside oToK. A charge that did not go through a provider is always recorded only, whichever mode is named |
| `entry_id` | UUID | conditionally | The charge entry to refund. **May be omitted only when exactly one charge funds the sale** — see `money.charges[].entryId` on [the sale view](#get-apiv1salesid) or `allocations[].entry.id` |
| `amount` | number | no | > 0 and ≤ this charge's remaining share of **this sale**. Omitted → that whole remaining share |
| `note` | string | no | ≤1000 — stored on the refund entry |
| `idempotency_key` | string | no | ≤200, unique per workspace. A replay returns the original refund with `duplicate: true` instead of refunding twice — even after the charge is fully refunded |

```bash
curl -X POST "https://app.otok.io/api/v1/sales/5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d/refund" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "requested_by_customer",
    "mode": "auto",
    "amount": 100,
    "idempotency_key": "crm-refund-4471-1"
  }'
```

Response `201`:

| Field | Notes |
|---|---|
| `payment` | The [payment](payments.md#the-payment-model) the charge belongs to, with its entries — the new refund entry included |
| `entry` | The refund entry (negative `amount`, `refunds_entry_id` pointing at the charge) |
| `outcome` | See [refund outcomes](#refund-outcomes) |
| `incidentId` | Present when the outcome needs follow-up in the app |
| `duplicate` | `true` when `idempotency_key` replayed an earlier refund |

### Refund outcomes

| `outcome` | Meaning |
|---|---|
| `gateway_refunded` | The payment provider returned the money |
| `voided` | The provider cancelled the charge before it settled — the payer was never charged |
| `credit_document_only` | The provider issued a credit document, but the money itself must still be returned — follow up in the app (`incidentId`) |
| `recorded_outside` | Recorded as returned outside oToK |
| `ledger_only` | Recorded on the ledger only (the charge did not go through a provider) |
| `duplicate` | An `idempotency_key` replay |

### Errors

| Status | Code / message | Meaning |
|---|---|---|
| 400 | `"Select a charge entry that funds this sale."` | `entry_id` omitted while several charges fund the sale, or it names a charge that does not |
| 400 | `"Refund exceeds this charge's remaining allocation to the sale."` | `amount` is more than the charge's remaining share of this sale |
| 400 | validation messages | Missing/unknown `reason` or `mode` |
| 403 | `API_KEY_MONEY_OUT_DISABLED` | The key lacks **Allow refunds** |
| 404 | `"Sale not found"` | |
| 409 | `IDEMPOTENCY_KEY_MISMATCH` | The `idempotency_key` was used for a different sale, charge, or amount |
| 409 | `PLAN_FEATURE_REQUIRED` | `mode: "auto"` on a provider charge without the **Workspace payments** feature — retry with `recorded_outside` |
| 409 | `PROVIDER_NOT_CONNECTED` | The provider the charge was taken through is no longer connected |
| 409 | `REFUND_IN_STORE` | The payment was synced from an online store — refund it in the store |
| 409 | `REQUEST_NOT_REFUNDABLE` | The charge came from a test-mode pay-link and never moved money |

Refunds fire the payment-refunded automations, [`payment.refunded`](webhooks.md), and — once the refund settles — [`sale.refunded`](webhooks.md#sale-events).

## PUT /api/v1/sales/:id/owner

| Field | Type | Required | Notes |
|---|---|---|---|
| `owner_user_id` | UUID or `null` | **yes** | An active team member, or `null` to make the sale unowned |

Response `200` — the sale object. 400 `INVALID_CONTACT_OWNER` for a user who is not an active member; `404` — `"Sale not found"`. Changing a sale's owner does not change the contact's owner.

## PUT /api/v1/sales/:id/deal

| Field | Type | Required | Notes |
|---|---|---|---|
| `deal_id` | UUID or `null` | **yes** | A deal **of the sale's buyer**, or `null` to unlink |

Response `200` — the sale object. `404` — `"Sale not found"` / `"Deal not found"`; 409 `SALE_DEAL_CONTACT_MISMATCH` when the deal belongs to another contact.

## POST /api/v1/sales/:id/allocations

Links an **existing** charge — a payment entry from [`/v1/payments`](payments.md) (`entries[].id`) — to this sale. Nothing is charged and no money moves; the sale's `paid_total` and `settlement_status` update. Use it when money was recorded on the ledger separately from the sale.

| Field | Type | Required | Constraints |
|---|---|---|---|
| `payment_entry_id` | UUID | **yes** | A **charge** entry in `pending` or `completed` status, in the sale's currency. The payer may be any contact |
| `amount` | number | no | 0.01 – 1,000,000,000, ≤2 decimals. **Omitted → as much as both sides allow**: the smaller of what the charge has not yet allocated elsewhere and what the sale can still take |

If the charge was already partly refunded, those refunds are linked to the sale too (as negative allocations), so the sale reads `partially_refunded` rather than overpaid.

Response `201` — the new [allocation](#allocations).

| Status | Code / message | Meaning |
|---|---|---|
| 400 | `CURRENCY_MISMATCH` | The charge and the sale use different currencies |
| 400 | `SALE_TOTAL_UNKNOWN` | The sale's total is open (an unpriced item) — pass an explicit `amount` |
| 400 | `INVALID_ALLOCATION_AMOUNT` | `amount` is not positive |
| 404 | `"Sale not found"` / `"Payment entry not found"` | |
| 409 | `ENTRY_NOT_ALLOCATABLE` | The entry is a refund, or a charge that is not pending/completed |
| 409 | `NOTHING_TO_ALLOCATE` | The charge is fully allocated, or the sale is fully funded |
| 409 | `ALLOCATION_EXCEEDS_ENTRY` / `ALLOCATION_EXCEEDS_SALE` | `amount` is more than the charge has left / the sale can take |
| 409 | `ALLOCATION_EXISTS` | This charge is already allocated to this sale |

## DELETE /api/v1/sales/:id/allocations/:allocationId

Releases a **charge** allocation — the charge no longer funds this sale; the charge's refunds on this sale are released with it. No money moves; the payment stays on the ledger.

> Needs the key's **Allow permanent deletion** capability — 403 `HARD_DELETE_OWNER_ONLY` otherwise.

Response `200` — `{ released, twins }`: the released allocation and the refund allocations released with it.

| Status | Code / message | Meaning |
|---|---|---|
| 404 | `"Allocation not found"` | Unknown, or not an allocation of this sale |
| 409 | `ALLOCATION_IS_REFUND` | A refund allocation — it is released with its charge, never on its own |
| 409 | `REFUND_IN_FLIGHT` | A provider refund of this charge is still in progress |

## DELETE /api/v1/sales/:id

Permanently deletes a sale recorded by mistake, with its items. Only a sale with **no money and no links** can be deleted — a sale with allocations, or one a quote, order, or pay-link points at, returns 409 `SALE_HAS_ALLOCATIONS` (cancel it instead).

> Needs the key's **Allow permanent deletion** capability — 403 `HARD_DELETE_OWNER_ONLY` otherwise.

Response `200` — `{ "success": true }`. `404` — `"Sale not found"`. Deleting fires no webhook.

## Webhooks

Four opt-in events — `sale.recorded`, `sale.cancelled`, `sale.paid`, `sale.refunded` — fire for sales from **every** source (API, in-app, automations, and the sales the app records from quotes, orders, pay-links and bookings). Register them by listing them at [`POST /v1/webhook-endpoints`](webhooks.md); see [sale event `data`](webhooks.md#sale-event-data) for the payloads.

## Related

- [Payments](payments.md) — the ledger whose charges fund sales
- [Payment Requests](payment-requests.md) — collect money through a hosted pay-link
- [Products](products.md) and [Product cycles](product-cycles.md) — what a sale's items point at
- [Webhooks](webhooks.md#sale-events)
