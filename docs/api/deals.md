# Deals & Pipelines

Manage sales deals on your workspace's pipelines. A deal belongs to exactly one contact and one pipeline stage, and carries an `open` / `won` / `lost` status that is **separate from its stage** — closing a deal stamps `closed_at` and keeps its last stage.

All endpoints require [authentication](getting-started.md#authentication). Deals cannot be deleted via the API.

> **Plan feature required:** every route on this page (including `GET /v1/pipelines`) requires the **Deals** feature on the workspace's plan, in addition to API access. Without it, all calls return `403` with `error_code: "FEATURE_NOT_INCLUDED_IN_PLAN"` — see [feature-gated resource groups](getting-started.md#feature-gated-resource-groups).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/pipelines` | List pipelines with their stages |
| GET | `/api/v1/deals` | List deals (filterable) |
| GET | `/api/v1/deals/:id` | Get one deal |
| POST | `/api/v1/deals` | Create a deal (idempotent upsert via `external_reference`) |
| PATCH | `/api/v1/deals/:id` | Update deal fields |
| POST | `/api/v1/deals/:id/stage` | Move a deal to a stage |
| POST | `/api/v1/deals/:id/status` | Set status: open / won / lost |

## GET /api/v1/pipelines

Returns a JSON **array** (no pagination envelope) of the workspace's pipelines, ordered by position, each with its ordered `stages`. Use this to map stage ids before creating or moving deals.

```bash
curl "https://app.otok.io/api/v1/pipelines" \
  -H "Authorization: Bearer otok_live_abc123..."
```

```json
[
  {
    "id": "aa11bb22-3344-5566-7788-99aabbccddee",
    "workspace_id": "…",
    "name": "Sales",
    "description": null,
    "is_default": true,
    "position": 0,
    "created_by": "…",
    "created_at": "2026-01-05T09:00:00.000Z",
    "updated_at": "2026-01-05T09:00:00.000Z",
    "stages": [
      { "id": "st-1111…", "pipeline_id": "aa11bb22-…", "name": "New", "color": "#3b82f6", "position": 0, "win_probability": 10, "created_at": "…", "updated_at": "…" },
      { "id": "st-2222…", "pipeline_id": "aa11bb22-…", "name": "Negotiation", "color": "#f59e0b", "position": 1, "win_probability": 60, "created_at": "…", "updated_at": "…" }
    ]
  }
]
```

Exactly one pipeline per workspace has `is_default: true`. A stage's `win_probability` is an integer 0–100 (`null` behaves as 100%) used for forecasting.

## The deal object

Deal responses include all deal fields — `id`, `workspace_id`, `pipeline_id`, `stage_id`, `contact_id`, `product_id`, `owner_user_id`, `title`, `amount`, `currency`, `status`, `lost_reason`, `expected_close_at`, `closed_at`, `stage_entered_at`, `position`, `note`, `external_reference`, `source`, `created_by`, `created_at`, `updated_at`.

`GET /v1/deals`, `GET /v1/deals/:id`, `POST /v1/deals`, and `PATCH /v1/deals/:id` additionally join the contact's identity: `contact_name`, `contact_phone`, `contact_email`. The `/stage` and `/status` action routes return the bare deal row **without** these joined fields.

## GET /api/v1/deals

This route uses dedicated query parameters (not the generic `filter`), and its own pagination defaults — see [where deals and payments differ](getting-started.md#where-deals-and-payments-differ).

| Param | Type | Notes |
|---|---|---|
| `pipeline_id` | UUID | Exact match — take the id from `GET /v1/pipelines`. Malformed → 400 `"Invalid pipeline_id: must be a UUID"`; empty (`?pipeline_id=`) is treated as absent |
| `stage_id` | UUID | Exact match. Malformed → 400 `"Invalid stage_id: must be a UUID"` |
| `status` | enum | `open`, `won`, `lost` — any other value is **silently ignored** (unfiltered result) |
| `contact_id` | UUID | Exact match. Malformed → 400 `"Invalid contact_id: must be a UUID"` |
| `owner_user_id` | UUID | Exact match. Malformed → 400 `"Invalid owner_user_id: must be a UUID"` |
| `external_reference` | string | Exact match — look up a deal by your idempotency reference |
| `search` | string | Case-insensitive match over deal title + contact name/phone/email |
| `limit` | integer | Default **25**, cap 100. Absent or empty defaults; malformed → 400 `"Invalid limit: must be a non-negative integer"` |
| `offset` | integer | Default 0, min 0. Malformed → 400 `"Invalid offset: must be a non-negative integer"` |

Results are ordered newest-first.

```bash
curl -G "https://app.otok.io/api/v1/deals" \
  -H "Authorization: Bearer otok_live_abc123..." \
  --data-urlencode 'status=open' \
  --data-urlencode 'pipeline_id=aa11bb22-3344-5566-7788-99aabbccddee'
```

Response `200` — `{ data, total, limit, offset }`.

| Status | Meaning |
|---|---|
| 400 | Malformed UUID query param (`Invalid pipeline_id: must be a UUID`, …) or malformed `limit`/`offset` |
| 403 | `error_code: "FEATURE_NOT_INCLUDED_IN_PLAN"` — plan lacks the Deals feature |

## GET /api/v1/deals/:id

Response `200` — the deal + `contact_name`/`contact_phone`/`contact_email`. `404` — `"Deal not found"`. Non-UUID id → 400.

## POST /api/v1/deals

Creates a deal — or, when `external_reference` matches an existing deal, **updates it** (idempotent upsert; see below).

### Request body

| Field | Type | Required | Constraints |
|---|---|---|---|
| `contact_id` | UUID | one of `contact_id` OR `phone`/`email` | Existing contact (404 if not in this workspace) |
| `phone` | string | ″ | ≤32 chars, international format preferred |
| `email` | string | ″ | Valid email |
| `name` | string | no | ≤200 — used only when a **new** contact is created |
| `title` | string | required unless a product is attached | ≤200 |
| `product_id` | UUID | no | Attach a product by id |
| `product_sku` | string | no | ≤120 — attach by SKU |
| `product_external_id` | string | no | ≤255 — attach by your external product id |
| `amount` | number | no | 0 – 9,999,999,999; rounded to 2 decimals. Omitted → product price if a product is attached, else 0 |
| `currency` | string | no | ≤8 chars, uppercased. Omitted → workspace default currency |
| `pipeline_id` | UUID | no | Omitted → the workspace default pipeline |
| `stage_id` | UUID | no | Omitted → the pipeline's first stage |
| `owner_user_id` | UUID | no | Must be a workspace agent. Omitted → the deal is unowned |
| `expected_close_at` | string | no | ISO 8601 |
| `note` | string | no | ≤4000 |
| `external_reference` | string | no | ≤255 — **idempotency key**, unique per workspace |

### Contact resolution

Shared with the [contacts upsert](contacts.md#post-apiv1contacts--upsert):

- `contact_id` wins when present.
- Otherwise `phone`/`email` are upserted exactly like `POST /v1/contacts`: normalized phone match wins, email is the fallback; a match **updates** that contact, no match **creates** one.
- Phone resolving to one contact and email to a different one → **409 `CONTACT_MERGE_REQUIRED`** (a merge request is parked; see [contacts](contacts.md#identity-conflict--409-contact_merge_required)).
- Neither `contact_id` nor `phone`/`email` → **400** `"Provide contact_id, or a phone/email to attach the deal to a contact"`.

### Product attachment and title lock

A product reference is resolved in order: `product_id` → `product_sku` → `product_external_id` (first provided wins). While a product is attached:

- **The deal's `title` is derived from the product name — any client-sent title is ignored.**
- A missing `amount` defaults to the product's price.
- Only **active** products can be attached to new records (a product already attached to the deal stays valid even if deactivated).

### Idempotent upsert via `external_reference`

`external_reference` is unique per workspace. When a POST carries an `external_reference` that matches an existing deal, the deal is **updated instead of created**:

- **Fields updated (only those present in the body):** `product_id` (when a product reference resolves), `title` (still ignored while a product is attached), `amount`, `currency`, `owner_user_id`, `expected_close_at`, `note`.
- **`contact_id` is always re-applied** from the freshly resolved contact — a repeat POST with different phone/email **re-points the deal to that contact** (and the contact upsert side effects still run). Because contact resolution happens before the match check, every repeat POST must still carry `contact_id` or `phone`/`email`.
- **`stage_id`**, if present and different from the deal's current stage, **moves** the deal (with the same ledger/automation effects as `POST /v1/deals/:id/stage`).
- **`status` is never touched** on a match — use `POST /v1/deals/:id/status`.
- **`pipeline_id` is ignored** on a match (only stage moves apply).

The response is **201 in both cases**, with a top-level boolean **`duplicate`** field: `false` when this request created the deal, `true` when the `external_reference` matched an existing deal (fields updated / stage moved, status untouched).

### Example

```bash
curl -X POST "https://app.otok.io/api/v1/deals" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+972501234567",
    "email": "dana@example.com",
    "name": "Dana Levi",
    "title": "Annual plan — Dana Levi",
    "amount": 3600,
    "currency": "ILS",
    "expected_close_at": "2026-08-01T00:00:00.000Z",
    "external_reference": "crm-opp-10042"
  }'
```

Response `201`:

```json
{
  "id": "d3a1b2c4-5e6f-7081-92a3-b4c5d6e7f809",
  "pipeline_id": "aa11bb22-3344-5566-7788-99aabbccddee",
  "stage_id": "st-1111…",
  "contact_id": "9c2f1a4e-3b7d-4e2a-9f0c-1d2e3f4a5b6c",
  "title": "Annual plan — Dana Levi",
  "amount": "3600.00",
  "currency": "ILS",
  "status": "open",
  "expected_close_at": "2026-08-01T00:00:00.000Z",
  "external_reference": "crm-opp-10042",
  "source": "api",
  "contact_name": "Dana Levi",
  "contact_phone": "+972501234567",
  "contact_email": "dana@example.com",
  "duplicate": false,
  "created_at": "2026-07-14T10:00:00.000Z",
  "updated_at": "2026-07-14T10:00:00.000Z"
}
```

### Errors

| Status | Code / message | Meaning |
|---|---|---|
| 400 | `MISSING_TITLE` | No `title` and no product attached |
| 400 | `STAGE_PIPELINE_MISMATCH` | `stage_id` doesn't belong to the given `pipeline_id` |
| 400 | `NO_PIPELINE` | Workspace has no pipeline — create one in the app first |
| 400 | `PIPELINE_HAS_NO_STAGES` | Target pipeline has no stages |
| 400 | `INVALID_DEAL_OWNER` | `owner_user_id` is not an agent of this workspace |
| 400 | `INVALID_PRODUCT` | Product reference didn't resolve in this workspace |
| 400 | `PRODUCT_INACTIVE` | Product exists but is inactive |
| 400 | `"Provide contact_id, or a phone/email…"` | No contact reference |
| 403 | `FEATURE_NOT_INCLUDED_IN_PLAN` | Plan lacks the Deals feature (body has no `statusCode` field — see [feature-gated resource groups](getting-started.md#feature-gated-resource-groups)) |
| 403 | `PLAN_LIMIT_EXCEEDED` | Deal cap reached (only applies when a cap is set on the workspace) |
| 404 | `"Contact not found"` / `"Pipeline not found"` / `"Stage not found"` | Referenced record not in this workspace |
| 409 | `CONTACT_MERGE_REQUIRED` | Phone and email resolve to two different contacts |

(`error_code` values appear as an `error_code` field on the response body.)

### Side effects

A created deal enters at the top of its stage column, is recorded in the contact's activity timeline, fires the workspace's **deal-created automations**, and syncs to connected integrations (e.g. Salesforce). API writes are attributed to source `api` with no acting user.

## PATCH /api/v1/deals/:id

Update deal fields. All fields optional.

| Field | Type | Notes |
|---|---|---|
| `product_id` | UUID or `null` | UUID attaches/replaces (must be active unless it's the already-attached product); **`null` detaches** — the title keeps its current text |
| `title` | string | ≤200 — **ignored while a product is (or ends up) attached** |
| `amount` | number | 0 – 9,999,999,999, rounded to 2 decimals |
| `currency` | string | ≤8, uppercased |
| `contact_id` | UUID | Re-points the deal; 404 `"Contact not found"` if not in this workspace |
| `owner_user_id` | UUID or `null` | `null` unassigns; a UUID must be a workspace agent (400 `INVALID_DEAL_OWNER`) |
| `expected_close_at` | string or `null` | ISO 8601; `null` clears |
| `note` | string or `null` | ≤4000; trimmed, empty becomes `null` |

Field updates do **not** write stage-history entries and do **not** fire deal automations — only the `/stage` and `/status` routes do.

Response `200` — the updated deal + joined contact fields.

| Status | Code / message |
|---|---|
| 400 | `INVALID_PRODUCT` / `PRODUCT_INACTIVE` / `INVALID_DEAL_OWNER` / validation |
| 404 | `"Deal not found"` / `"Contact not found"` |

## POST /api/v1/deals/:id/stage

Move a deal to a stage (any stage in the workspace — cross-pipeline moves are supported; the deal's `pipeline_id` follows the target stage).

| Field | Type | Required | Constraints |
|---|---|---|---|
| `stage_id` | UUID | yes | Target stage |
| `index` | integer | no | 0–100000 — position within the stage column, 0 = top. Omitted → top |

```bash
curl -X POST "https://app.otok.io/api/v1/deals/d3a1b2c4-5e6f-7081-92a3-b4c5d6e7f809/stage" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{ "stage_id": "st-2222…" }'
```

Response `201` — the updated deal row (no joined contact fields on this route).

A move to the deal's **current** stage is a pure reorder (position only — no history entry, no automations). A genuine stage change stamps `stage_entered_at`, records a stage-transition history entry and activity row, and fires **deal-stage-changed automations**.

| Status | Meaning |
|---|---|
| 404 | `"Deal not found"` / `"Stage not found"` |

## POST /api/v1/deals/:id/status

Set the deal's status.

| Field | Type | Required | Constraints |
|---|---|---|---|
| `status` | enum | yes | `open`, `won`, `lost` — `open` reopens a closed deal |
| `lost_reason` | string | no | ≤1000 — stored only when status is `lost`; cleared otherwise |

```bash
curl -X POST "https://app.otok.io/api/v1/deals/d3a1b2c4-5e6f-7081-92a3-b4c5d6e7f809/status" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{ "status": "won" }'
```

Response `201` — the updated deal row (no joined contact fields). If the deal already has the requested status, the current row is returned unchanged (no history entry, no automations).

Semantics:

- Closing (`won`/`lost`) stamps `closed_at` and **keeps the deal on its last stage**.
- Reopening clears `closed_at` and `lost_reason`.
- `won` / `lost` fire the corresponding **deal automations** (reopen fires none), and winning a deal triggers connected revenue/conversion integrations.

| Status | Meaning |
|---|---|
| 400 | Invalid `status` value |
| 404 | `"Deal not found"` |
