# Getting Started

The oToK REST API lets you manage contacts, tags, groups, campaigns, deals, payments, orders, bookings, and transactional email from your own systems. All endpoints live under a versioned `/v1` path and authenticate with workspace API keys.

## Base URL

```
https://app.otok.io/api/v1/
```

Interactive API documentation (Swagger UI) is served at:

```
https://app.otok.io/api/v1/docs
```

## Creating an API key

1. In the oToK app, open **Settings → Developers → API keys**.
2. Click **Create**, give the key a name (up to 100 characters), and confirm.
3. Copy the key from the one-time reveal dialog. Keys look like `otok_live_…` and are **shown exactly once** — oToK stores only a hash, so a lost key cannot be recovered. Create a new one instead.

Notes:

- Managing API keys requires the workspace **settings management** permission. Agents without it will see the Developers section but their requests to manage keys will fail.
- Keys can be **revoked** at any time from the same screen. Revocation is immediate and permanent (there is no un-revoke); revoked keys remain listed for audit.
- Keys do not expire on their own, and there are no per-key scopes: a key grants access to the entire `/v1` surface on behalf of its workspace. Writes made with an API key are attributed to the workspace, not to any individual agent.
- The "last used" column in the app is accurate to about one minute.

## Plan requirement

The REST API requires a plan with API access (**Growth or higher**). Requests from a workspace whose plan lacks API access are rejected with:

```
HTTP 403
{"statusCode": 403, "message": "The REST API requires a plan with API access (Growth or higher)", "error": "Forbidden"}
```

### Feature-gated resource groups

Endpoint groups that mirror a plan-gated product area additionally require that feature on the workspace's plan. **Every route in each group is gated** — reads and writes alike:

| Endpoints | Required plan feature |
|---|---|
| `/v1/deals*` (all routes) and `/v1/pipelines` | Deals |
| `/v1/payments*` (all routes, including `/refund`) | Payments |
| `/v1/orders*` (all routes, including the action routes) | Orders |
| `/v1/campaigns*` (all routes, including `/execute`) | Campaigns |
| `/v1/bookings*` and `/v1/meeting-types*` (all routes) | Booking |

A workspace whose plan lacks the feature receives `403 Forbidden` on every call in the group, with this body (note: unlike the standard shape, there is **no `statusCode` field**):

```json
{
  "message": "Your current plan does not include access to this feature: deals. Please upgrade your plan.",
  "error_code": "FEATURE_NOT_INCLUDED_IN_PLAN"
}
```

The identifier after `feature:` is the lowercase plan-feature id — `deals`, `payments`, `orders`, `campaigns`, or `booking` — not the product display name. Key on `error_code: "FEATURE_NOT_INCLUDED_IN_PLAN"`, not on the message text.

All other resources — contacts, notes, tags, contact groups, templates, transactional emails, and webhook endpoints — require only plan-wide API access.

## Authentication

Send the key as a bearer token on every request:

```
Authorization: Bearer otok_live_...
```

| Problem | Response |
|---|---|
| Missing or non-`Bearer` `Authorization` header | `401` — `"Missing API key"` |
| Malformed, unknown, or **revoked** key | `401` — `"Invalid API key"` |
| Plan without API access | `403` — see above |
| Plan without the resource group's feature | `403` — `error_code: "FEATURE_NOT_INCLUDED_IN_PLAN"` (see above) |

A revoked key is indistinguishable from an unknown key — both return `401 "Invalid API key"`. If a previously working integration starts failing with this error, check whether the key was revoked.

## First request

```bash
curl "https://app.otok.io/api/v1/contacts?limit=5" \
  -H "Authorization: Bearer otok_live_abc123..."
```

```json
{
  "data": [
    {
      "id": "9c2f1a4e-3b7d-4e2a-9f0c-1d2e3f4a5b6c",
      "name": "Dana Levi",
      "phone": "+972501234567",
      "email": "dana@example.com",
      "lifecycle_stage": "lead",
      "tags": ["b1a2c3d4-0000-0000-0000-000000000001"],
      "groups": [],
      "created_at": "2026-07-01T09:15:00.000Z",
      "updated_at": "2026-07-10T14:03:00.000Z"
    }
  ],
  "total": 1,
  "limit": 5,
  "offset": 0
}
```

## Error responses

The API uses **two error body shapes**. Handle errors by HTTP status code first, then inspect the body:

**1. Domain errors** (business-rule failures on the email and webhook-endpoint APIs, and failures of `POST /v1/campaigns/:id/execute`) use a structured envelope:

```json
{ "error": { "code": "quota_exceeded", "message": "Monthly email quota exhausted" } }
```

Key on `error.code` — the `message` text is informative and may change.

**2. Framework errors** (validation failures, authentication, authorization, rate limiting, and most resource errors) use the standard shape:

```json
{ "statusCode": 400, "message": ["name must be shorter than or equal to 200 characters"], "error": "Bad Request" }
```

`message` is a string for most errors and an array of per-field messages for request-validation failures.

**3. `error_code` variants.** Some 4xx responses extend the standard shape with a machine-readable `error_code` field (and occasionally extra fields), for example:

```json
{
  "statusCode": 409,
  "error": "Conflict",
  "error_code": "CONTACT_MERGE_REQUIRED",
  "merge_request_id": "3a2b1c0d-...",
  "message": "The provided phone and email belong to two different existing contacts. A merge request has been opened — resolve it in the app, then retry."
}
```

When an `error_code` is documented for an endpoint, prefer it over matching on message text. Deals, payments, orders, bookings, and contacts use this style for their coded errors. `CONTACT_MERGE_REQUIRED` (with its `merge_request_id`) is returned by `POST /v1/contacts` and, with a different `message`, by `PATCH /v1/contacts/:id` — see [Contacts](contacts.md). The [feature-gating 403](#feature-gated-resource-groups) also carries an `error_code` but omits `statusCode`.

### Request validation

Request bodies are strictly validated:

- Unknown/undocumented body properties are **rejected with 400** — do not send extra fields. This includes properties nested inside documented objects (e.g. the template-send `body_variables`/`header_config`/`button_configs` shapes): `400` with `property <name> should not exist`.
- Fields are type-checked and constraint-checked per the tables on each endpoint page. `message` is an array of per-field strings on these failures (e.g. `["body_variables.0.text must be a string"]`).
- Numeric bounds are enforced as 400 validation errors — e.g. payment `amount` ≤ 9,999,999,999; `installment_count` between 2 and 360; contact `employee_count` between 0 and 2,147,483,647.
- Date fields on write bodies accept **date-only** values (`"2026-07-01"`), interpreted as a date. An unparseable value on a date field returns 400: `Invalid date value for "scheduled_at": "<value>"`. Orders body dates use their own wording — `"placed_at is not a valid date"` / `"refundedAt is not a valid date"` (see [Orders](orders.md)).
- Path `:id` parameters must be UUIDs; a non-UUID id returns 400 (with one documented exception on `DELETE /v1/webhook-endpoints/:id`, which returns 404).

### Filter-value validation

On the list endpoints that accept the JSON `filter` parameter (contacts, campaigns, templates, tags, contact-groups, meeting-types) — and in `audience_filters` condition trees on campaign bodies — filter values are **type-checked against the target field** before the query runs. A mistyped value returns `400 Bad Request` in the standard shape:

```json
{ "statusCode": 400, "message": "<see below>", "error": "Bad Request" }
```

| Field kind | Example request | 400 `message` |
|---|---|---|
| date/timestamp | `?filter={"created_at":"not-a-date"}` | `Invalid filter value for "created_at": "not-a-date" is not a date` |
| UUID | `?filter={"id":"abc"}` | `Invalid filter value for "id": "abc" is not a UUID` |
| enum | `?filter={"lifecycle_stage":"bogus"}` | `Invalid filter value for "lifecycle_stage": must be one of <allowed values, comma-separated>` |
| numeric | `?filter={"employee_count":"abc"}` | `Invalid filter value for "employee_count": "abc" is not a number` |
| boolean | `?filter={"is_active":"maybe"}` | `Invalid filter value for "is_active": "maybe" is not a boolean` |

Values that coerce cleanly are accepted: date-only strings are valid date filters (`?filter={"created_at":"2026-01-01"}` works), numeric strings are accepted for numeric fields (`"125"` → `125`), and `"true"`/`"false"` strings are accepted for boolean fields.

Substring operators (`contains`, `not_contains`, `starts_with`, `ends_with`) in `$where` condition trees are rejected on non-text fields:

```json
{
  "statusCode": 400,
  "message": "Invalid filter on \"id\": substring operators (contains, starts_with, ends_with) only apply to text fields",
  "error": "Bad Request"
}
```

### Duplicate names (409)

Tag and contact-group names are unique per workspace (case-insensitive). `POST`/`PATCH` with a name that already exists returns `409 Conflict` in the standard shape:

```json
{ "statusCode": 409, "message": "A tag with this name already exists", "error": "Conflict" }
```

(`"A contact group with this name already exists"` for groups.) See [Tags & Contact Groups](tags-and-groups.md).

## Rate limits

| Scope | Limit |
|---|---|
| Per API key (default, all endpoints) | **100 requests / minute** |
| `POST /v1/emails` | **300 requests / minute** per key |
| Per source IP, across all API-key traffic | **300 requests / minute** |

The per-key bucket is shared across all source IPs using that key. Exceeding a limit returns **HTTP 429** with a `Retry-After` header indicating how long to wait. Spread bursts out and honor `Retry-After` with exponential backoff.

## List conventions

Most list endpoints (contacts, tags, contact-groups, campaigns, templates, meeting-types) accept:

| Param | Type | Default | Notes |
|---|---|---|---|
| `filter` | JSON object (string-encoded) | `{}` | Invalid JSON → 400 `"Invalid filter: must be valid JSON"`; a non-object (array/scalar) → 400 `"Invalid filter: must be a JSON object"`. Filter **values** are type-checked against the target field — a mistyped value returns 400 (see [filter-value validation](#filter-value-validation)). Any `workspace_id` in the filter is ignored and replaced with your authenticated workspace. |
| `sort` | string | `-created_at` | Field name; `-` prefix for descending. |
| `limit` | integer ≥ 0 | `50` | Hard cap **500**. Non-integer or negative → 400. |
| `offset` | integer ≥ 0 | `0` | Non-integer or negative → 400. |
| `search` | string | — | Free-text search (fields vary per resource). |

List responses use a consistent envelope:

```json
{ "data": [ ... ], "total": 123, "limit": 50, "offset": 0 }
```

`total` is the count of all matches, so `offset + limit < total` means there are more pages.

`GET /v1/bookings` does not accept `filter` or `search` — it uses dedicated query parameters (`status`, `meeting_type_id`, `from`/`to`) with the standard `limit`/`offset` and a `-start_at` sort default — see [Bookings](bookings.md).

### Filter grammar

The `filter` object supports:

- **Exact match:** `{"lifecycle_stage": "lead"}`. An array value matches any of its members: `{"status": ["draft", "scheduled"]}`.
- **`$where`** — a nested condition tree: `{"$where": {"combinator": "and", "rules": [{"field": "city", "operator": "contains", "value": "Tel"}]}}` (max 100 nodes, max 200 items per array value).
- **`$gt`** — greater-than shortcut: `{"$gt": {"lead_score": 50}}`. This is the only top-level comparison shortcut; use `$where` for other range comparisons.
- **Contacts only:** `$jsonb_contains` for `tags`/`groups` (by **UUID**), `$event_attendance` (`{"event_id": "...", "status": "attended"}`), and the virtual consent fields `whatsapp_subscribed`, `email_subscribed` (boolean), `whatsapp_deliverability`, `email_deliverability`.

Example — contacts in a group, subscribed to email:

```bash
curl -G "https://app.otok.io/api/v1/contacts" \
  -H "Authorization: Bearer otok_live_abc123..." \
  --data-urlencode 'filter={"$jsonb_contains":{"groups":["7f6e5d4c-0000-0000-0000-000000000002"]},"email_subscribed":true}'
```

### Where deals and payments differ

`GET /v1/deals` and `GET /v1/payments` use dedicated query parameters instead of `filter`, and paginate differently:

- `limit` **default 25, cap 100**; `offset` min 0 (default 0).
- Absent or empty `limit`/`offset` values default; a **malformed value returns 400** — `"Invalid limit: must be a non-negative integer"` (`Invalid offset: …` for `offset`).
- UUID query parameters on `GET /v1/deals` (`pipeline_id`, `stage_id`, `contact_id`, `owner_user_id`) are validated — a malformed value returns 400 `"Invalid pipeline_id: must be a UUID"`; an empty value (`?pipeline_id=`) is treated as absent, not an error.
- Unrecognized enum filter values (e.g. `status=bogus`) are silently ignored rather than returning 400.

`GET /v1/orders` belongs to the same family (dedicated query parameters, default 25 / cap 100, no `filter`), with three differences:

- Malformed `limit`/`offset` values never return 400 on orders — a malformed or zero `limit` silently defaults to 25 and out-of-range values are clamped into 1–100; a malformed or negative `offset` defaults to 0.
- Its UUID-parameter validation messages are worded differently: `"contact_id must be a UUID"` (orders) vs `"Invalid contact_id: must be a UUID"` (deals/payments).
- There is no `search` parameter on `GET /v1/orders`.

See [Deals](deals.md), [Payments](payments.md), and [Orders](orders.md).

## Success status codes

- `GET` / `PATCH` → **200**.
- `POST` → **201**, including action-style routes (`/stage`, `/status`, `/cancel`, `/refund`, booking `/reschedule`, etc.). Treat any 2xx as success.
- `POST /v1/campaigns/:id/execute` → **200** on success; failures use real error statuses (404/409 — see [Campaigns](campaigns.md)).
- `DELETE /v1/webhook-endpoints/:id` → **204** (no body); `DELETE /v1/notes/:id` → **200** with `{"success": true}`. These are the **only** DELETE endpoints: the API never deletes customer data — contacts, deals, payments, orders, campaigns, tags, and contact groups have no DELETE routes.
- The idempotent create routes (`POST /v1/contacts`, `/v1/deals`, `/v1/payments`, `/v1/orders`, `/v1/bookings`) return **201 for both** a fresh create and an upsert/replay. All of them except orders carry a top-level boolean **`duplicate`** field (`false` on a fresh create, `true` when the call matched an existing record); **`POST /v1/orders` carries no `duplicate` field** — both outcomes return the same full-order body (see [Orders](orders.md#post-apiv1orders)). Order **refunds** (`POST /v1/orders/:id/refunds`) do return `{ duplicate, order }` on their `external_refund_id` idempotency.
- `POST /v1/emails` is the one idempotent route whose status code also splits: **201** for a fresh send, **200** for an idempotent replay (its body carries the same `duplicate` field).

## CORS and calling context

The API is designed for **server-to-server** use. Call it from backend code (curl, server jobs) — origin-less requests are accepted. Browser-based calls from arbitrary origins are rejected by CORS; never embed an API key in client-side code.

## Request logging

Every authenticated `/v1` request that reaches an endpoint is recorded (method, path, status, duration, IP, user agent — metadata only, never bodies). Workspace admins can review this log in **Settings → Developers**.

## Next steps

- [Contacts](contacts.md) — upsert contacts, manage notes
- [Tags & Contact Groups](tags-and-groups.md)
- [Campaigns](campaigns.md) — WhatsApp campaigns
- [Templates](templates.md) — send WhatsApp template messages
- [Deals & Pipelines](deals.md)
- [Payments](payments.md)
- [Orders](orders.md) — e-commerce orders, refunds, mark-paid/cancel
- [Transactional Emails](emails.md)
- [Webhooks](webhooks.md) — email delivery/engagement events + order lifecycle events
- [Bookings & Meeting Types](bookings.md)
