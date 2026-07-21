# Products

The workspace **product catalog**, shared by [deals](deals.md) and customer [payments](payments.md): when a deal or payment carries a `product_id`, its title derives from the product name, and a deal created without an amount defaults to the product's price. The API mirrors the in-app catalog (Tools → Products) — same rows, same rules.

All endpoints require [authentication](getting-started.md#authentication); there is no extra plan feature (like contacts and tags, products sell on API access alone). Products cannot be deleted — deactivate with `is_active: false` so existing deals/payments keep resolving their attached product.

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
| `price` | number or `null` | Default price in the workspace payment currency, as a JSON number. **`null` = dynamic pricing** — a deal referencing the product then needs an explicit amount |
| `vat_mode` / `vat_rate` | enum / number, or `null`s | Per-product VAT override (`inclusive` / `exclusive` + percent 0–100). One **both-or-neither pair** — `null`s mean the workspace payments default applies at resolution time |
| `is_active` | boolean | Inactive products stay attached to existing deals/payments but cannot be attached to new ones |
| `created_by` | UUID or `null` | `null` for API creates |
| `created_at` / `updated_at` | ISO 8601 | |

## GET /api/v1/products

Standard [list envelope](getting-started.md#pagination) (`data`/`total`/`limit`/`offset`; `limit` default 50, cap 500), newest first. Filters combine (AND):

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
| `price` | number or `null` | no | ≥0; `null` = dynamic pricing |
| `vat_mode` | `inclusive` \| `exclusive` \| `null` | no | Travels with `vat_rate` as one both-or-neither pair (400 when only one leg is sent); send both `null` to clear |
| `vat_rate` | number or `null` | no | 0–100, max 2 decimals |
| `is_active` | boolean | no | Defaults to `true` |

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

Deactivate instead of deleting:

```bash
curl -X PATCH "https://app.otok.io/api/v1/products/6f2a1b3c-..." \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{"is_active": false}'
```

| Status | Code | Meaning |
|---|---|---|
| 404 | `product_not_found` | Unknown id, or another workspace's product |
| 409 | `product_conflict` | The new `sku`/`external_id` already belongs to a different product |

## Notes

- **Attachment rules** (enforced on deals/payments, not here): only **active** products attach to new records; re-saving a record that already carries an inactive product never fails; deleting is impossible, so denormalized titles always keep resolving.
- The public API resolves product references on [deal creation](deals.md) by `product_id` → `sku` → `external_id`.
