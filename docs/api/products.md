# Products

The workspace **product catalog**, shared by [deals](deals.md) and customer [payments](payments.md): when a deal or payment carries a `product_id`, its title derives from the product name, and a deal created without an amount defaults to the product's price. The API mirrors the in-app catalog (Products) — same rows, same rules.

All endpoints require [authentication](getting-started.md#authentication); there is no extra plan feature (like contacts and tags, products sell on API access alone). Products cannot be deleted — archive with `manual_status: "archived"` so existing deals/payments keep resolving their attached product.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/products` | List products (filterable, paginated) |
| GET | `/api/v1/products/:id` | Get one product |
| POST | `/api/v1/products` | Create a product — **idempotent upsert via `external_id`** |
| PATCH | `/api/v1/products/:id` | Partial update (incl. deactivation) |

## The product object

| Field | Type | Notes |
|---|---|---|
| `id` | UUID | |
| `workspace_id` | UUID | |
| `name` | string | Deals/payments referencing the product derive their title from it |
| `sku` | string or `null` | Per-workspace-unique product code (human-facing) |
| `external_id` | string or `null` | Per-workspace-unique id of this product **in your system** — the POST idempotency key |
| `description` | string or `null` | |
| `price` | number or `null` | Default price in the workspace payment currency, as a JSON number. `null` = no default price — a deal referencing the product then needs an explicit amount |
| `dynamic_pricing` | boolean | Default `true`: [cycle](product-cycles.md) prices — and sales recorded without a cycle — may override `price`. `false` fixes the price: every cycle and sale uses `price` (see [Fixed pricing](#fixed-pricing)) |
| `vat_mode` / `vat_rate` | enum / number, or `null`s | Per-product VAT override (`inclusive` / `exclusive` + percent 0–100). One **both-or-neither pair** — `null`s mean the workspace payments default applies at resolution time |
| `is_active` | boolean | Inactive products stay attached to existing deals/payments but cannot be attached to new ones |
| `starts_on` / `ends_on` | date or `null` | Schedule dates in the workspace calendar |
| `duration_unit` / `manual_status` | enum / nullable enum | Schedule unit and optional archive/cancel override |
| `enforce_cycle_capacity` / `require_cycle` | boolean | Sales capacity and cycle requirements |
| `attendance_on_sale` | boolean | Read-only here (set in the app): a sale of this product registers the buyer for the product's matching upcoming events |
| `recurring_sale_policy` | `fill_one` \| `per_period` | How a recurring payment plan for this product records [sales](sales.md) — see the request field below |
| `created_by` | UUID or `null` | `null` for API creates |
| `created_at` / `updated_at` | ISO 8601 | |

## GET /api/v1/products

Standard [list envelope](getting-started.md#list-conventions) (`data`/`total`/`limit`/`offset`; `limit` default 50, cap 500), newest first. Filters combine (AND):

| Param | Type | Notes |
|---|---|---|
| `q` | string | Literal substring match on `name` or `description` (case-insensitive; `%`/`_` are not wildcards) |
| `sku` | string | Exact-match lookup by SKU |
| `external_id` | string | Exact-match lookup by external id |
| `is_active` | boolean | `true` \| `false`; any other value returns 400 |
| `limit` / `offset` | integer | Standard paging; malformed values return 400 |

```bash
curl "https://app.otok.io/api/v1/products?is_active=true&q=onboarding" \
  -H "Authorization: Bearer otok_live_abc123..."
```

## GET /api/v1/products/:id

Returns the product, or 404 `product_not_found` (structured `{"error": {"code", "message"}}` envelope) for an unknown or cross-workspace id.

## POST /api/v1/products — idempotent upsert

### Request body

| Field | Type | Required | Constraints |
|---|---|---|---|
| `name` | string | yes | 1–200 chars |
| `sku` | string or `null` | no | ≤100 chars; per-workspace-unique |
| `external_id` | string or `null` | no | ≤200 chars; per-workspace-unique — **the idempotency key** |
| `description` | string or `null` | no | ≤2000 chars |
| `price` | number or `null` | no | ≥0; `null` = no default price |
| `dynamic_pricing` | boolean | no | Default `true`. `false` fixes the price — see [Fixed pricing](#fixed-pricing) |
| `vat_mode` | `inclusive` \| `exclusive` \| `null` | no | Travels with `vat_rate` as one both-or-neither pair (400 when only one leg is sent); send both `null` to clear |
| `vat_rate` | number or `null` | no | 0–100, max 2 decimals |
| `is_active` | boolean | no | Defaults to `true`; `false` alone is rejected for dated products. Use `manual_status` to archive/cancel them. |
| `starts_on` / `ends_on` | date or `null` | no | Workspace-calendar `YYYY-MM-DD`; real dates, end not before start. |
| `duration_unit` | enum | no | `days` (default), `weeks`, `months`, `years`. |
| `manual_status` | enum or `null` | no | `archived`, `cancelled`, or `null` to remove the override. Archive/cancel makes the product inactive. |
| `enforce_cycle_capacity` | boolean | no | Default `false`: full [cycles](product-cycles.md) are advisory. `true` rejects new sales into full cycles with 409 `CYCLE_FULL`. |
| `require_cycle` | boolean | no | Default `false`. `true` requires a cycle on sales (400 `CYCLE_REQUIRED`); deal cycles remain optional. |
| `recurring_sale_policy` | `fill_one` \| `per_period` | no | How a recurring payment plan for this product records sales: `fill_one` (default) keeps paying into one sale until it is fully paid; `per_period` opens a new sale for every billing period. A plan keeps the policy it started with — a change applies to new plans only |

### Upsert resolution

When `external_id` matches an existing product, that product's fields are **updated** instead of a new one being created, and the response carries `duplicate: true`. Both outcomes return **201** with the full product:

```bash
curl -X POST "https://app.otok.io/api/v1/products" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Onboarding package",
    "external_id": "prod-9",
    "sku": "ONB-1",
    "price": 249.9
  }'
```

Response `201`:

```json
{
  "id": "6f2a1b3c-4d5e-6071-8293-a4b5c6d7e8f9",
  "workspace_id": "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9",
  "name": "Onboarding package",
  "sku": "ONB-1",
  "external_id": "prod-9",
  "description": null,
  "price": 249.9,
  "vat_mode": null,
  "vat_rate": null,
  "is_active": true,
  "created_by": null,
  "created_at": "2026-07-16T10:00:00.000Z",
  "updated_at": "2026-07-16T10:00:00.000Z",
  "duplicate": false
}
```

### Errors

| Status | Code | Meaning |
|---|---|---|
| 400 | — | Validation failure, or a lone-leg `vat_mode`/`vat_rate` pair |
| 409 | `product_conflict` | A **different** product already holds this `sku` or `external_id` (structured envelope; also fires on a concurrent-create race) |

## PATCH /api/v1/products/:id

Partial update — same fields as POST, all optional; only the fields present in the body change (a field you don't send is never nulled). Returns the updated product (no `duplicate` marker).

Archive instead of deleting:

```bash
curl -X PATCH "https://app.otok.io/api/v1/products/6f2a1b3c-..." \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{"manual_status": "archived"}'
```

| Status | Code | Meaning |
|---|---|---|
| 404 | `product_not_found` | Unknown id, or another workspace's product |
| 409 | `product_conflict` | The new `sku`/`external_id` already belongs to a different product |

## Notes

- **Attachment rules** (enforced on deals/payments, not here): only **active** products attach to new records; re-saving a record that already carries an inactive product never fails; deleting is impossible, so denormalized titles always keep resolving.
- The public API resolves product references on [deal creation](deals.md) by `product_id` → `sku` → `external_id`.

### Fixed pricing

With `dynamic_pricing: false` the product's `price` is the only price: a deal created without an amount defaults to it even when its cycle has a price of its own, setting a different `price` on one of the product's [cycles](product-cycles.md) is refused with 400 `PRODUCT_PRICE_LOCKED`, and a sale recorded at a different unit amount is refused with 400 `SALE_PRICE_LOCKED`. Turning it back on (`true`, the default) lets cycles and sales override the price again.

### Scheduling

Dated products use automatic schedule status. Use `manual_status: "archived"` or `"cancelled"` to override it. For a dated product, `is_active: false` without an archive/cancel status returns 400 `PRODUCT_STATUS_AUTOMATIC`. Dates are validated together with existing values on PATCH; an end before the start returns 400 `PRODUCT_DATES_INCOHERENT`. Setting `is_active: true` without `manual_status` clears a previous override.

Use [product cycles](product-cycles.md) for multiple cohorts, runs or versions of a product.
