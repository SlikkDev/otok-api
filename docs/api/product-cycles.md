# Product cycles

Cycles are cohorts, runs or versions of a [product](products.md). They require API access and no additional plan feature. Archive cycles to keep existing references intact.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/products/:productId/cycles` | List cycles and seat counts |
| POST | `/api/v1/products/:productId/cycles` | Create or update by case-insensitive name |
| GET | `/api/v1/product-cycles/:id` | Get one cycle |
| PATCH | `/api/v1/product-cycles/:id` | Update or archive |

## List cycles

The list accepts `is_archived` (`true` or `false`), `limit` (default 50, cap 500) and `offset` (default 0). Omitting `is_archived` includes archived cycles. Dates sort ascending, undated cycles last, then creation time. The response is `{ data, total, limit, offset }`.

Cycle records include `id`, `workspace_id`, `product_id`, the fields below, timestamps, `sales_count` and `units_taken`. Capacity uses units sold, so compare `units_taken` with `capacity`. A returned `price` can be a decimal string, number or `null`.

## Create or update

| Field | Constraints |
|---|---|
| `name` | Required on POST; 1–200 chars. Case-insensitive, unique within this product. |
| `starts_on` / `ends_on` | Real `YYYY-MM-DD` workspace-calendar dates, or `null`. End cannot precede start. |
| `duration_unit` | `days` (default), `weeks`, `months`, `years`. |
| `manual_status` | Undated cycles: `open`, `ongoing`, `ended`, `undated`, `cancelled`, or `null`. With either date set, only `cancelled` or `null` is accepted; `null` resumes automatic status. |
| `price` | Number 0–1,000,000,000, at most 2 decimals, or `null` to use product price. Workspace payment currency. |
| `capacity` | Integer 1–1,000,000, or `null` for no cap. |
| `is_archived` | Boolean, default `false`. Archive with `true`; no DELETE endpoint. |

POST matches the name within the product and updates only supplied fields. It returns **201** with `duplicate: true` for a match or `false` for creation. PATCH makes every field optional and returns **200**, without a duplicate marker.

Example POST body:

```json
{
  "name": "Autumn course",
  "starts_on": "2026-10-01",
  "ends_on": "2026-10-31",
  "duration_unit": "weeks",
  "capacity": 20
}
```

Unknown or cross-workspace products/cycles return 404. Invalid dates, reversed ranges and invalid manual statuses return 400. Renaming a cycle to another cycle's name returns 409 `CYCLE_NAME_TAKEN`.

Attach a cycle to a [deal](deals.md) with `cycle_id`; it must belong to the attached product. The product's `enforce_cycle_capacity` and `require_cycle` options govern sales, while a deal's cycle remains optional.
