# Contacts

Manage workspace contacts and their notes. Contacts are the core record most other resources (deals, payments, bookings, campaigns) attach to.

All endpoints require [authentication](getting-started.md#authentication). There is no DELETE endpoint for contacts on the API.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/contacts` | List contacts (paginated, filterable) |
| GET | `/api/v1/contacts/:id` | Get one contact |
| POST | `/api/v1/contacts` | **Upsert** a contact by phone/email |
| PATCH | `/api/v1/contacts/:id` | Update a contact by id |
| GET | `/api/v1/contacts/:id/notes` | List a contact's notes |
| POST | `/api/v1/contacts/:id/notes` | Add a note |
| PATCH | `/api/v1/notes/:id` | Edit / pin a note |
| DELETE | `/api/v1/notes/:id` | Delete a note |

## The contact object

Responses return the full contact record plus computed fields:

- `tags` — array of tag **ids** (strings)
- `groups` — array of group **ids**
- `event_attendances` — `[{id, event_id, status, registered_at, attended_at, unregistered_at}]`
- `whatsapp_subscribed`, `email_subscribed` (booleans), `whatsapp_deliverability`, `email_deliverability` — per-channel consent state (contacts without a subscription record report `false` / `"unknown"`)
- `score_band` — read-only lead-scoring band: `"cold"`, `"warm"`, `"hot"`, or `null`

> **Round-trip warning — tags/groups are NAMES on input, IDS on output.** `POST`/`PATCH` accept tag and group **names**; `GET` returns **ids**. Never echo the ids from a GET back into a write: unrecognized names are auto-created, so a UUID sent as a "name" creates a brand-new tag literally named like that UUID. Map ids back to names first (see [Tags & Contact Groups](tags-and-groups.md)).

---

## GET /api/v1/contacts

Standard [list conventions](getting-started.md#list-conventions) apply (`filter`, `sort`, `limit` default 50 / cap 500, `offset`, `search`).

`search` matches `name`, `first_name`, `last_name`, `email`, `phone`, `company_name` (case-insensitive substring), plus an exact match on the E.164-normalized form of the term and the contact's historical phone/email identifiers.

```bash
curl -G "https://<your-host>/api/v1/contacts" \
  -H "Authorization: Bearer otok_live_abc123..." \
  --data-urlencode 'filter={"lifecycle_stage":"customer"}' \
  --data-urlencode 'sort=-updated_at' \
  --data-urlencode 'limit=25'
```

Response `200` — `{ data, total, limit, offset }`.

| Status | Meaning |
|---|---|
| 400 | Invalid `filter` JSON / non-object filter / invalid `limit`/`offset` |
| 401 / 403 / 429 | Auth, plan, rate limit |

## GET /api/v1/contacts/:id

| Param | Type | Notes |
|---|---|---|
| `id` | UUID (path) | Non-UUID → 400 |

Response `200` — a single contact object (same enrichment as list).

| Status | Meaning |
|---|---|
| 404 | `"contacts with ID <id> not found"` — unknown in this workspace |

---

## POST /api/v1/contacts — upsert

Creates a contact, or **updates the existing contact** that the given `phone`/`email` resolves to. This is the recommended way to write contacts from external systems — including changing a contact's phone or email.

### Request body

Every field is optional. Unknown fields → 400.

| Field | Type | Constraints |
|---|---|---|
| `phone` | string | ≤32 chars; normalized to E.164 (local numbers use the workspace default country) |
| `name` | string | ≤200 |
| `first_name` / `last_name` | string | ≤100 each |
| `email` | string | valid email, ≤255 |
| `avatar_url` | string | ≤500 |
| `notes` | string | ≤5000 |
| `lifecycle_stage` | enum | `lead`, `prospect`, `customer`, `inactive`, `archived` |
| `source` | enum | `manual`, `import`, `widget`, `campaign`, `api`, `form` |
| `block_state` | enum | `none`, `workspace`, `global` |
| `company_name` | string | ≤200 |
| `vat_number` | string | ≤40 |
| `job_title` | string | ≤120 |
| `industry` | string | ≤80 |
| `company_website` | string | ≤500 |
| `annual_revenue` | number | |
| `employee_count` | integer | |
| `currency_preference` | string | ≤8 |
| `address_line1` / `address_line2` | string | ≤200 each |
| `city` / `state` / `country` | string | ≤100 each |
| `postal_code` | string | ≤20 |
| `gender` | enum | `male`, `female`, `other`, `prefer_not_to_say` |
| `date_of_birth` | string | ISO 8601 date |
| `language` | string | ≤12 |
| `utm_source` / `utm_medium` / `utm_campaign` / `utm_term` / `utm_content` / `gclid` / `fbclid` | string | ≤200 each |
| `lead_score` | number | **Engine-owned:** silently ignored while workspace lead scoring is enabled — the response echoes the computed score. Writable only when scoring is disabled. |
| `linkedin_url` / `facebook_url` | string | ≤500 each |
| `instagram_handle` / `twitter_handle` | string | ≤100 each |
| `custom_fields` | object | Arbitrary keys; **shallow-merged** into the existing object on update |
| `tags` | string[] | Tag **names**, each 1–100 chars. Missing tags are auto-created. |
| `groups` | string[] | Group **names**, each 1–100 chars. Missing groups are auto-created. |

### Upsert resolution

1. `phone` and `email` are normalized.
2. The API looks up the current owner of each identifier — resolution is **history-aware**: a phone/email that was moved off a contact still resolves to its most recent holder if no current owner exists.
3. **Phone wins**: if the phone resolves to a contact, that contact is updated; otherwise the email match is used.
4. Match found → **update**: scalar fields overwrite, `custom_fields` shallow-merge, and `tags`/`groups` are **added** to the existing set (never removed by this route).
5. No match → **create**. Concurrent creates of the same identity are safe — the loser of the race is retried as an update of the winner.

The response is **201 in both cases** (create and update) with the full contact object. There is no created-vs-updated marker; compare `created_at`/`updated_at` if you need to distinguish.

### Identity conflict — 409 `CONTACT_MERGE_REQUIRED`

If the `phone` resolves to one existing contact and the `email` to a *different* one, the API does **not** write and does **not** auto-merge. It opens a merge request for the workspace to resolve in-app and responds:

```json
{
  "statusCode": 409,
  "error": "Conflict",
  "error_code": "CONTACT_MERGE_REQUIRED",
  "merge_request_id": "3a2b1c0d-4e5f-6a7b-8c9d-0e1f2a3b4c5d",
  "message": "The provided phone and email belong to two different existing contacts. A merge request has been opened — resolve it in the app, then retry."
}
```

The non-identity fields of your request are parked with the merge request and applied when it is resolved. Retry after the merge request is resolved in the app. Repeated conflicting requests for the same pair reuse the same merge request.

### Example

```bash
curl -X POST "https://<your-host>/api/v1/contacts" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+972501234567",
    "email": "dana@example.com",
    "first_name": "Dana",
    "last_name": "Levi",
    "lifecycle_stage": "lead",
    "tags": ["VIP", "Newsletter"],
    "custom_fields": { "plan_interest": "pro" }
  }'
```

Response `201`:

```json
{
  "id": "9c2f1a4e-3b7d-4e2a-9f0c-1d2e3f4a5b6c",
  "phone": "+972501234567",
  "email": "dana@example.com",
  "name": "Dana Levi",
  "first_name": "Dana",
  "last_name": "Levi",
  "lifecycle_stage": "lead",
  "tags": ["b1a2c3d4-0000-0000-0000-000000000001", "b1a2c3d4-0000-0000-0000-000000000002"],
  "groups": [],
  "custom_fields": { "plan_interest": "pro" },
  "whatsapp_subscribed": true,
  "email_subscribed": false,
  "score_band": null,
  "created_at": "2026-07-14T10:00:00.000Z",
  "updated_at": "2026-07-14T10:00:00.000Z"
}
```

### Errors

| Status | Code / message | Meaning |
|---|---|---|
| 400 | validation messages | Bad field values or unknown fields |
| 400 | `error_code: "PHONE_BLACKLISTED"` — `"This phone number is on the blacklist and cannot be saved to a contact."` | The phone is blocked by a workspace or global blacklist rule |
| 400 | `"Limit reached. Your plan allows a maximum of N contacts…"` | Contact limit reached (only applies when a cap is set on the workspace) |
| 409 | `error_code: "CONTACT_MERGE_REQUIRED"` | See above |

### Side effects

Creating or updating a contact via the API behaves like an in-app write: per-channel consent records are seeded (WhatsApp implied; email `unknown` when an email is provided, both attributed to source `api`), contact-change automations (tag/group/field triggers) fire, activity history is recorded, and connected integrations sync. `block_state` set to a non-`none` value without a blacklist match is recorded with an import block source.

---

## PATCH /api/v1/contacts/:id

Update a contact **by id**. Same field set and validation as POST (all optional).

Semantics that differ from POST:

- **`tags`/`groups` REPLACE the full set.** The contact ends up with exactly the names you send; an empty array clears all tags/groups. (On POST they are additive.) Names still auto-create.
- `custom_fields` still shallow-merge — you cannot remove a key by omitting it; set it to `null` explicitly.
- `name` and `first_name`/`last_name` stay in sync: patching only `first_name` recombines it with the stored `last_name`; patching only `name` re-splits it on the first whitespace.
- `block_state` changes route through the consent/blocking subsystem; lifting a block re-evaluates blacklist rules, and global blocks cannot be lifted via the API.

> **Changing phone/email: prefer the POST upsert.** This route does not perform identity-conflict resolution. `POST /v1/contacts` is the supported way to change a contact's phone or email — it detects when the new identifier already belongs to another contact and opens a merge request instead of failing.

| Param | Type | Notes |
|---|---|---|
| `id` | UUID (path) | Non-UUID → 400 |

```bash
curl -X PATCH "https://<your-host>/api/v1/contacts/9c2f1a4e-3b7d-4e2a-9f0c-1d2e3f4a5b6c" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{ "lifecycle_stage": "customer", "tags": ["VIP"] }'
```

Response `200` — the updated contact object.

| Status | Code / message | Meaning |
|---|---|---|
| 400 | validation / unknown fields / non-UUID id | |
| 400 | `error_code: "PHONE_BLACKLISTED"` | Only when the patch *changes* the phone to a blacklisted number |
| 404 | `"Contact <id> not found"` | Unknown in this workspace |

---

## Notes

Notes are plain-text annotations on a contact. API note payloads are **text only** (rich-text and mentions are in-app features; sending them returns 400). Notes created via the API have no author user and are attributed to source `api`.

Note object:

```json
{
  "id": "5e4d3c2b-...",
  "workspace_id": "...",
  "contact_id": "9c2f1a4e-...",
  "author_user_id": null,
  "author_name": null,
  "source": "api",
  "body": "Asked for a demo next week",
  "body_json": null,
  "mentioned_user_ids": null,
  "pinned_at": null,
  "conversation_id": null,
  "created_at": "2026-07-14T10:05:00.000Z",
  "updated_at": "2026-07-14T10:05:00.000Z"
}
```

(`author_name` is included on list responses only.)

### GET /api/v1/contacts/:id/notes

Returns a JSON **array** of all the contact's notes — this endpoint is not paginated and takes no query parameters. Pinned notes come first (most recently pinned on top), then the rest newest-first.

| Status | Meaning |
|---|---|
| 400 | Non-UUID contact id |
| 404 | `"Contact not found"` |

### POST /api/v1/contacts/:id/notes

| Field | Type | Required | Constraints |
|---|---|---|---|
| `body` | string | yes | ≤5000 chars; trimmed — empty after trim → 400 `"Note body cannot be empty"` |
| `pinned` | boolean | no | `true` pins the note immediately |

```bash
curl -X POST "https://<your-host>/api/v1/contacts/9c2f1a4e-3b7d-4e2a-9f0c-1d2e3f4a5b6c/notes" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{ "body": "Asked for a demo next week", "pinned": true }'
```

Response `201` — the created note.

| Status | Meaning |
|---|---|
| 400 | Empty/oversized body, unknown fields |
| 404 | `"Contact not found"` |

### PATCH /api/v1/notes/:id

| Field | Type | Required | Constraints |
|---|---|---|---|
| `body` | string | no | ≤5000; empty → 400 |
| `pinned` | boolean | no | Pin/unpin |

Both fields are optional; sending neither returns the current note unchanged. A body change bumps `updated_at` (shows as "edited" in-app); a pin toggle alone does not. If the note is the contact's **profile note**, a body edit also updates the contact's `notes` field (and fires the corresponding field-change automations).

Response `200` — the note after the update.

| Status | Meaning |
|---|---|
| 400 | Empty body / >5000 chars / non-UUID id |
| 404 | `"Note not found"` or `"Contact not found"` |

### DELETE /api/v1/notes/:id

Response `200`:

```json
{ "success": true }
```

Deleting the contact's profile note also clears the contact's `notes` field. A deletion breadcrumb is kept in the contact's activity timeline.

| Status | Meaning |
|---|---|
| 404 | `"Note not found"` or `"Contact not found"` |
