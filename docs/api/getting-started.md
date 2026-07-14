# Getting Started

The oToK REST API lets you manage contacts, tags, groups, campaigns, deals, payments, bookings, and transactional email from your own systems. All endpoints live under a versioned `/v1` path and authenticate with workspace API keys.

## Base URL

```
https://<your-host>/api/v1/
```

Replace `<your-host>` with the host your oToK workspace runs on.

Interactive API documentation (Swagger UI) is served at:

```
https://<your-host>/api/v1/docs
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

A revoked key is indistinguishable from an unknown key — both return `401 "Invalid API key"`. If a previously working integration starts failing with this error, check whether the key was revoked.

## First request

```bash
curl "https://<your-host>/api/v1/contacts?limit=5" \
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

**1. Domain errors** (business-rule failures on the email and webhook-endpoint APIs) use a structured envelope:

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

When an `error_code` is documented for an endpoint, prefer it over matching on message text. Deals, payments, bookings, and contacts use this style for their coded errors.

### Request validation

Request bodies are strictly validated:

- Unknown/undocumented body properties are **rejected with 400** — do not send extra fields.
- Fields are type-checked and constraint-checked per the tables on each endpoint page.
- Path `:id` parameters must be UUIDs; a non-UUID id returns 400 (with one documented exception on `DELETE /v1/webhook-endpoints/:id`, which returns 404).

## Rate limits

| Scope | Limit |
|---|---|
| Per API key (default, all endpoints) | **100 requests / minute** |
| `POST /v1/emails` | **300 requests / minute** per key |
| Per source IP, across all API-key traffic | **300 requests / minute** |

The per-key bucket is shared across all source IPs using that key. Exceeding a limit returns **HTTP 429** with a `Retry-After` header indicating how long to wait. Spread bursts out and honor `Retry-After` with exponential backoff.

## List conventions

Most list endpoints (contacts, tags, contact-groups, campaigns, templates, meeting-types, bookings) accept:

| Param | Type | Default | Notes |
|---|---|---|---|
| `filter` | JSON object (string-encoded) | `{}` | Invalid JSON → 400 `"Invalid filter: must be valid JSON"`; a non-object (array/scalar) → 400 `"Invalid filter: must be a JSON object"`. Any `workspace_id` in the filter is ignored and replaced with your authenticated workspace. |
| `sort` | string | `-created_at` | Field name; `-` prefix for descending. |
| `limit` | integer ≥ 0 | `50` | Hard cap **500**. Non-integer or negative → 400. |
| `offset` | integer ≥ 0 | `0` | Non-integer or negative → 400. |
| `search` | string | — | Free-text search (fields vary per resource). |

List responses use a consistent envelope:

```json
{ "data": [ ... ], "total": 123, "limit": 50, "offset": 0 }
```

`total` is the count of all matches, so `offset + limit < total` means there are more pages.

### Filter grammar

The `filter` object supports:

- **Exact match:** `{"lifecycle_stage": "lead"}`. An array value matches any of its members: `{"status": ["draft", "scheduled"]}`.
- **`$where`** — a nested condition tree: `{"$where": {"combinator": "and", "rules": [{"field": "city", "operator": "contains", "value": "Tel"}]}}` (max 100 nodes, max 200 items per array value).
- **`$gt`** — greater-than shortcut: `{"$gt": {"lead_score": 50}}`. This is the only top-level comparison shortcut; use `$where` for other range comparisons.
- **Contacts only:** `$jsonb_contains` for `tags`/`groups` (by **UUID**), `$event_attendance` (`{"event_id": "...", "status": "attended"}`), and the virtual consent fields `whatsapp_subscribed`, `email_subscribed` (boolean), `whatsapp_deliverability`, `email_deliverability`.

Example — contacts in a group, subscribed to email:

```bash
curl -G "https://<your-host>/api/v1/contacts" \
  -H "Authorization: Bearer otok_live_abc123..." \
  --data-urlencode 'filter={"$jsonb_contains":{"groups":["7f6e5d4c-0000-0000-0000-000000000002"]},"email_subscribed":true}'
```

### Where deals and payments differ

`GET /v1/deals` and `GET /v1/payments` use dedicated query parameters instead of `filter`, and paginate differently:

- `limit` **default 25, cap 100**; `offset` min 0.
- Out-of-range or non-numeric values are **silently clamped/defaulted**, not rejected.
- Unrecognized enum filter values (e.g. `status=bogus`) are silently ignored rather than returning 400.

See [Deals](deals.md) and [Payments](payments.md).

## Success status codes

- `GET` / `PATCH` → **200**.
- `POST` → **201**, including action-style routes (`/execute`, `/stage`, `/status`, `/cancel`, `/refund`, booking `/reschedule`, etc.). Treat any 2xx as success.
- `DELETE /v1/webhook-endpoints/:id` → **204** (no body); `DELETE /v1/notes/:id` → **200** with `{"success": true}`.
- `POST /v1/emails` is the one route that splits: **201** for a fresh send, **200** for an idempotent replay.

## CORS and calling context

The API is designed for **server-to-server** use. If you self-host oToK and call the API from server-side code (curl, backend jobs), make sure your deployment's CORS allowlist admits origin-less requests (include the literal token `(none)` in the allowed-origins configuration). Browser-based calls from arbitrary origins are rejected by CORS.

## Request logging

Every authenticated `/v1` request that reaches an endpoint is recorded (method, path, status, duration, IP, user agent — metadata only, never bodies). Workspace admins can review this log in **Settings → Developers**.

## Next steps

- [Contacts](contacts.md) — upsert contacts, manage notes
- [Tags & Contact Groups](tags-and-groups.md)
- [Campaigns](campaigns.md) — WhatsApp campaigns
- [Templates](templates.md) — send WhatsApp template messages
- [Deals & Pipelines](deals.md)
- [Payments](payments.md)
- [Transactional Emails](emails.md)
- [Webhooks](webhooks.md) — delivery/engagement events for API sends
- [Bookings & Meeting Types](bookings.md)
