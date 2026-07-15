# Campaigns (WhatsApp)

Create, schedule, and execute WhatsApp campaigns. A campaign targets an audience with a WhatsApp template (or custom message) and reports delivery counters as it runs.

All endpoints require [authentication](getting-started.md#authentication). Standard [list conventions](getting-started.md#list-conventions) apply to the list route. Campaigns cannot be deleted via the API.

> **Plan feature required:** every campaigns route (including `/execute`) requires the **Campaigns** feature on the workspace's plan, in addition to API access. Without it, all calls return `403` with `error_code: "FEATURE_NOT_INCLUDED_IN_PLAN"` — see [feature-gated resource groups](getting-started.md#feature-gated-resource-groups).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/campaigns` | List campaigns |
| GET | `/api/v1/campaigns/:id` | Get one campaign |
| POST | `/api/v1/campaigns` | Create a campaign |
| PATCH | `/api/v1/campaigns/:id` | Update a campaign |
| POST | `/api/v1/campaigns/:id/execute` | Queue a scheduled campaign for immediate execution |

## The campaign object

Full campaigns include: `id`, `workspace_id`, `name`, `description`, `status`, `type`, `template_id`, `template_name`, `audience_baseline`, `audience_id`, `audience_filters`, `custom_message`, `scheduled_at`, `timezone`, `started_at`, `completed_at`, `total_recipients`, `sent_count`, `delivered_count`, `read_count`, `failed_count`, `reply_count`, `pending_retry_count`, `instance_id`, `variables`, `created_at`, `updated_at`.

> **List rows omit `variables` and `audience_filters`** — fetch a single campaign (`GET /v1/campaigns/:id`) to read them.

## GET /api/v1/campaigns

```bash
curl -G "https://app.otok.io/api/v1/campaigns" \
  -H "Authorization: Bearer otok_live_abc123..." \
  --data-urlencode 'filter={"status":"scheduled"}' \
  --data-urlencode 'sort=-created_at'
```

Response `200` — `{ data, total, limit, offset }`.

| Status | Meaning |
|---|---|
| 400 | Invalid `filter` JSON / invalid `limit`/`offset` / a mistyped filter value (`Invalid filter value for "<field>": …` — see [filter-value validation](getting-started.md#filter-value-validation)) |
| 403 | `error_code: "FEATURE_NOT_INCLUDED_IN_PLAN"` — plan lacks the Campaigns feature |

## GET /api/v1/campaigns/:id

Response `200` — the full campaign object. `404` — `"campaigns with ID <id> not found"`. Non-UUID id → 400.

## POST /api/v1/campaigns

### Request body

| Field | Type | Required | Constraints |
|---|---|---|---|
| `name` | string | yes | 1–200 chars |
| `description` | string | no | ≤2000 |
| `status` | enum | no | `draft`, `scheduled` only — execution states cannot be set via the API. Omitted → `draft` |
| `type` | enum | no | `broadcast`, `drip`, `triggered`. Omitted → `broadcast` |
| `template_id` | UUID | no | WhatsApp template to send |
| `template_name` | string | no | ≤512 |
| `audience_id` | UUID | no | A saved audience; takes precedence over `audience_filters` |
| `audience_filters` | object | no | A `$where` condition tree (same grammar as the contacts `filter` `$where`); validated at write time |
| `custom_message` | string | no | |
| `scheduled_at` | string | no | ISO 8601. A date-only value (`"2026-07-01"`) is accepted and interpreted as a date; an unparseable value → 400 `Invalid date value for "scheduled_at": "<value>"` |
| `timezone` | string | no | ≤64 chars; omitted → `UTC` |
| `instance_id` | UUID | no | WhatsApp instance (phone number connection) to send from |
| `variables` | object | no | Template variable mappings |

### Audience validation

- `audience_id` must belong to your workspace — otherwise **404 `"Audience not found"`**.
- `audience_filters` is validated structurally and test-compiled at write time; failures return **400** with `{"message": "Invalid audience_filters definition", "errors": [...]}`.
- At send time, the audience can only **narrow** the built-in WhatsApp send-eligibility baseline (subscribed, not blocked, deliverable) — it can never widen it.

### Scheduling behavior

If the campaign is saved with `status: "scheduled"` **and** a `scheduled_at`, it is **automatically queued to execute at `scheduled_at`** — you do not need to call `/execute`. Any change to the campaign re-syncs the schedule (an earlier pending schedule is cancelled and, if still scheduled with a `scheduled_at`, re-queued).

### Example

```bash
curl -X POST "https://app.otok.io/api/v1/campaigns" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{
    "name": "July promo",
    "status": "scheduled",
    "template_id": "1f2e3d4c-5b6a-7980-a1b2-c3d4e5f60718",
    "audience_id": "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9",
    "scheduled_at": "2026-07-20T08:00:00.000Z",
    "timezone": "Asia/Jerusalem"
  }'
```

Response `201` — the full created campaign object.

### Errors

| Status | Meaning |
|---|---|
| 400 | Field validation, unknown fields, `"Invalid audience_filters definition"` — condition-tree **values** are type-checked like list filters (see [filter-value validation](getting-started.md#filter-value-validation)) |
| 400 | `Invalid date value for "scheduled_at": "<value>"` — unparseable `scheduled_at` |
| 400 | `"Limit reached. Your plan allows a maximum of <n> campaigns. Please upgrade your plan."` — only when a monthly campaign cap is set on the workspace |
| 403 | `error_code: "FEATURE_NOT_INCLUDED_IN_PLAN"` — plan lacks the Campaigns feature |
| 404 | `"Audience not found"` — `audience_id` not in this workspace |

## PATCH /api/v1/campaigns/:id

Same fields as create, all optional; same audience validation and scheduling re-sync.

The API can only set `status` to `draft` or `scheduled`. There is no restriction based on the campaign's current status — patching a running/completed campaign is possible and re-syncs scheduling based on the new state, so take care not to accidentally re-schedule a finished campaign.

Response `200` — the updated campaign.

| Status | Meaning |
|---|---|
| 400 / 404 | As in create; `404 "campaigns with ID <id> not found"` for an unknown id |

## POST /api/v1/campaigns/:id/execute

Queues a campaign for immediate execution. **The campaign must have `status: "scheduled"`** — a draft must first be PATCHed to `scheduled`.

No request body.

Response `200` — the campaign was queued:

```json
{ "success": true, "message": "Campaign queued for execution", "jobId": "execute-1f2e3d4c-..." }
```

Failures return real error statuses with the structured `{"error": {"code", "message"}}` envelope:

| Status | `error.code` | Meaning |
|---|---|---|
| 404 | `campaign_not_found` | `"Campaign not found"` — the campaign id is not in this workspace |
| 409 | `campaign_not_scheduled` | `"Campaign status is '<status>' — only 'scheduled' campaigns can be executed"` |

> **Draft campaigns 409 on execute.** A campaign created via `POST /v1/campaigns` without an explicit `status` defaults to `draft`, so a naive create → execute sequence returns the 409 above. Set `status: "scheduled"` on create, or PATCH it, before executing.

Execution is queued with a per-campaign job id, so repeated execute calls while a run is queued do not enqueue duplicates.

```bash
curl -X POST "https://app.otok.io/api/v1/campaigns/1f2e3d4c-5b6a-7980-a1b2-c3d4e5f60718/execute" \
  -H "Authorization: Bearer otok_live_abc123..."
```

### Audience resolution at execute time

The audience is resolved when the campaign actually runs: `audience_id` first (a missing/foreign audience fails the run rather than sending to everyone), then `audience_filters`, then the campaign's audience baseline. Delivery progress is reflected in the campaign's counters (`sent_count`, `delivered_count`, …), which you can poll via `GET /v1/campaigns/:id`.
