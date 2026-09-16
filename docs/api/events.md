# Events

Events and their registrations. Create the event your form or system knows about, register people into it, and move them through the roster — every write here fires exactly what the same action fires inside oToK: the reminders and automations, the `event.attendance.changed` webhook, lead scoring, and the Zoom registrant push that produces an attendee's personal join link.

> **Plan feature required:** these endpoints require the **Events** feature on the workspace's plan. Without it, calls return `403` with `error_code: "FEATURE_NOT_INCLUDED_IN_PLAN"` — see [feature-gated resource groups](getting-started.md#feature-gated-resource-groups).

## The event object

| Field | Type | Notes |
|---|---|---|
| `id` | UUID | |
| `name` | string | |
| `external_id` | string or `null` | Your own id for the event. Per-workspace unique, matched case-insensitively |
| `external_provider` | string or `null` | Read-only. Set by an integration (`"zoom"`) when the event is linked to a provider meeting — never writable, because it is the key oToK pushes registrants against |
| `start_at` / `end_at` | ISO 8601 or `null` | |
| `ended_at` | ISO 8601 or `null` | Stamped when the event actually ended |
| `status` | string | `draft`, `scheduled`, `canceled` or `completed` |
| `timezone` / `language` | string or `null` | |
| `category` | string or `null` | Free-text label. A label used once is offered on every event after it |
| `presenter` | string or `null` | |
| `link` | string or `null` | Join link shared by every attendee |
| `use_personal_links` | boolean | Each attendee gets their own join link instead of the shared one |
| `product_id` / `cycle_id` | UUID or `null` | |
| `suppress_event_automations` | boolean | Stops every automation for this event, reminders included |
| `archived_at` | ISO 8601 or `null` | Archived events are never written to |
| `created_at` | ISO 8601 | |

## The registration object

| Field | Type | Notes |
|---|---|---|
| `id` | UUID | The registration ("attendance") id |
| `event_id` / `contact_id` | UUID | |
| `status` | string | `registered`, `attended`, `no_show`, `waitlist` or `unregistered` |
| `registered_at` / `attended_at` / `unregistered_at` | ISO 8601 or `null` | Stamped as the row passes through each status |
| `join_url` | string or `null` | The attendee's personal join link, from Zoom or supplied by you |
| `created_at` / `updated_at` | ISO 8601 | |

**Status vocabulary.** These five values are what oToK stores and what every surface returns — this API, the contact object's `event_attendances[]`, and the `event.attendance.changed` webhook. On writes only, `cancelled` is accepted as an alias for `unregistered`; it is never returned, so a round-trip settles on the stored spelling.

---

## GET /api/v1/events

| Param | Type | Notes |
|---|---|---|
| `q` | string (query) | Substring match on the event name |
| `external_id` | string (query) | Exact, case-insensitive lookup by your own id |
| `limit` | integer (query) | Page size, default 50, max 500 |
| `offset` | integer (query) | Rows to skip, default 0 |

```bash
curl "https://app.otok.io/api/v1/events?external_id=autumn-webinar-2026" \
  -H "Authorization: Bearer otok_live_abc123..."
```

Response `200`: `{ "data": [ … ], "limit": 50, "offset": 0 }`, newest start date first.

## GET /api/v1/events/:id

Response `200`: the event object. A non-UUID id → 400; an event in another workspace → 404 `event_not_found`.

## POST /api/v1/events — upsert

Creates an event, or updates the one already carrying this `external_id`.

| Field | Type | Notes |
|---|---|---|
| `name` | string | **Required**, ≤300 chars |
| `external_id` | string | ≤200 chars. Sending one that already exists updates that event and answers `duplicate: true` |
| `start_at` / `end_at` | ISO 8601 | |
| `status` | string | `draft`, `scheduled`, `canceled`, `completed`. Defaults to `scheduled` — an event you create over the API is a real one, not an editor draft |
| `timezone` / `language` | string | |
| `category` / `presenter` / `link_password` | string | ≤200 chars each |
| `link` | string | ≤2000 chars |
| `use_personal_links` | boolean | |
| `product_id` / `cycle_id` | UUID | |
| `suppress_event_automations` | boolean | |

`external_provider` is not writable. It is how oToK knows a meeting belongs to a connected Zoom account, and a caller claiming it would make us push registrants at a meeting nobody owns.

```bash
curl -X POST "https://app.otok.io/api/v1/events" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{"name":"Autumn webinar","external_id":"autumn-webinar-2026","start_at":"2026-10-06T14:00:00Z"}'
```

Response `200`: the event object plus `"duplicate": true | false`.

**Idempotency.** Send the same `external_id` on every submission. The first call creates the event; the rest update it. There is no `PATCH /v1/events/:id` — the upsert *is* the update path.

---

## POST /api/v1/events/:id/attendances — register

Registers a contact for the event, or sets their status directly.

| Field | Type | Notes |
|---|---|---|
| `contact_id` | UUID | An existing contact. Mutually exclusive with `contact` |
| `contact` | object | `{ name, email, phone, national_id }` — upserted with the same identity resolution `POST /v1/contacts` uses (phone, then email, then national ID), so registering someone who already exists never creates a second copy of them. At least one identifier is required |
| `status` | string | Default `registered`. Accepts `cancelled` as an alias for `unregistered` |
| `zoom_registration` | `auto` \| `skip` | Default `auto`. See below |
| `join_url` | string | The attendee's personal join link. Honoured with `zoom_registration: "skip"` |
| `acquisition` | object | How this registration was acquired — the same object [`POST /v1/contacts`](contacts.md#acquisition-events-and-inquiry-capture-post-only) takes, minus `attendance_id`, which is stamped for you |

```bash
curl -X POST "https://app.otok.io/api/v1/events/7f3c.../attendances" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{
        "contact": { "name": "Jane Cohen", "email": "jane@example.com" },
        "acquisition": { "event_id": "webinar-signup-8891", "utm_source": "newsletter" }
      }'
```

Response `200`: the registration object plus:

| Field | Notes |
|---|---|
| `created` | `true` when this call created the registration, `false` when it moved an existing one |
| `previous_status` | The status it moved from, or `null` when it was created |
| `zoom` | `{ "status": …, "join_url": … }` — what *this call* did with Zoom: `registered` (pushed, link returned), `pending` (Zoom was unreachable, a retry is scheduled and the "registered" automation waits for it), `failed` (Zoom refused permanently), `skipped` (you opted out) or `not_applicable` (the event isn't Zoom-linked, or nothing needed pushing) |

**Registering the same person twice does nothing twice.** One registration per person per event: a retried form submission answers the same row with `created: false`, and fires no automation a second time.

**Zoom.** On a Zoom-linked event, `auto` registers the attendee with Zoom exactly as an in-app registration does, so their personal join link exists and the reminders that carry it work. Use `skip` only when you registered them with Zoom yourself, and pass the `join_url` you were given — a blank value never clears a link that is already there.

**Refusals.**

| Status | Code | When |
|---|---|---|
| 409 | `event_archived` | The event is archived — it takes no writes at all |
| 409 | `event_canceled` | The event is canceled and the status is `registered` or `waitlist`. Marking `attended` / `no_show` still works: a roster is a record of what happened, not a plan |
| 404 | `event_not_found` / `contact_not_found` | The event or contact is not in this workspace |
| 400 | `contact_ambiguous` / `contact_required` | Both `contact_id` and `contact`, or a `contact` with no identifier |
| 400 | `attendance_id_not_allowed` | `acquisition.attendance_id` was supplied — this call is the link, so it is stamped for you |

An event that has merely **ended** still accepts registrations and roster marking.

## GET /api/v1/events/:id/attendances

| Param | Type | Notes |
|---|---|---|
| `status` | string (query) | One of the five stored statuses (or `cancelled` for `unregistered`). Any other value → 400 `invalid_status` |
| `limit` / `offset` | integer (query) | Page size default 50, max 500 |

Response `200`: `{ "data": [ … ], "limit": 50, "offset": 0 }`, newest first.

## PATCH /api/v1/attendances/:id

Moves an existing registration.

```bash
curl -X PATCH "https://app.otok.io/api/v1/attendances/9a1e.../" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{"status":"attended"}'
```

Response `200`: the registration object plus `created: false` and `previous_status`. The same refusals as the POST apply — an archived event takes no move, and a canceled one takes no move back to `registered` or `waitlist`.

---

## Automations this fires

A registration made here is a registration like any other. It triggers the **Event Activity** automations (registered / unregistered / attended / waitlist), wakes any Wait-until-condition parked on the contact, records the lead-scoring signal, and emits [`event.attendance.changed`](webhooks.md) — each exactly once per real status change, even if two of your servers call at the same moment.

Marking someone `no_show` records and scores like the rest, and wakes a waiting automation, but has no trigger of its own: automate no-shows with an **Event Date/Time** trigger targeting that status.

## Related

- [Contacts](contacts.md) — the identity resolution the inline `contact` uses, and the `acquisition` object
- [Webhooks](webhooks.md) — `event.attendance.changed`
