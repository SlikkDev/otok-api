# Bookings & Meeting Types

Read your workspace's meeting types, query open slots, and create/cancel/reschedule/reassign bookings. Meeting types themselves are configured in the app — the API surface for them is read-only.

All endpoints require [authentication](getting-started.md#authentication).

> **Plan feature required:** every route on this page (bookings **and** meeting-types) requires the **Booking** feature on the workspace's plan, in addition to API access. Without it, all calls return `403` with `error_code: "FEATURE_NOT_INCLUDED_IN_PLAN"` — see [feature-gated resource groups](getting-started.md#feature-gated-resource-groups).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/meeting-types` | List meeting types |
| GET | `/api/v1/meeting-types/:id` | Get one meeting type |
| GET | `/api/v1/meeting-types/:id/slots` | Get open slots for a date range |
| GET | `/api/v1/meeting-types/:id/embed` | Get website-embed material (hosted page URL, publishable key, snippet) |
| GET | `/api/v1/bookings` | List bookings |
| GET | `/api/v1/bookings/:id` | Get one booking |
| POST | `/api/v1/bookings` | Create a booking |
| POST | `/api/v1/bookings/:id/cancel` | Cancel a booking |
| POST | `/api/v1/bookings/:id/reschedule` | Move a booking to a new slot |
| POST | `/api/v1/bookings/:id/reassign` | Change the assigned host |

## Meeting types

Meeting type object:

```json
{
  "id": "mt-1a2b3c4d-…",
  "name": "Intro call",
  "slug": "intro-call",
  "description": "30-minute discovery call",
  "duration_minutes": 30,
  "location_type": "zoom",
  "is_active": true,
  "scheduling_kind": "round_robin",
  "host": { "id": null, "name": "Sales team" },
  "hosts": [
    { "user_id": "u-1111…", "name": "Avi Cohen" },
    { "user_id": "u-2222…", "name": "Noa Bar" }
  ],
  "created_at": "2026-05-01T08:00:00.000Z"
}
```

- `scheduling_kind` — `single` (default; one host), or a team kind such as round-robin/collective. `hosts` lists the configured host pool (exactly one entry for `single`); `host` is a back-compat convenience (its `id` is `null` for team kinds).
- Internal configuration (schedules, booking-page questions, buffers, etc.) is not exposed.

### GET /api/v1/meeting-types

Standard [list conventions](getting-started.md#list-conventions) (`filter`, `sort` default `-created_at`, `limit` default 50 / cap 500, `offset`, `search`). Mistyped `filter` values return 400 — see [filter-value validation](getting-started.md#filter-value-validation).

```bash
curl -G "https://app.otok.io/api/v1/meeting-types" \
  -H "Authorization: Bearer otok_live_abc123..." \
  --data-urlencode 'filter={"is_active":true}'
```

Response `200` — `{ data, total, limit, offset }`.

### GET /api/v1/meeting-types/:id

Response `200` — a meeting type object. `404` when unknown in this workspace. Non-UUID id → 400.

### GET /api/v1/meeting-types/:id/slots

Returns the open start instants for the meeting type — the same availability the public booking page offers.

| Param | Type | Required | Constraints |
|---|---|---|---|
| `from` | ISO 8601 | yes | Range start (inclusive) |
| `to` | ISO 8601 | yes | Range end (exclusive); must be after `from`; **range may not exceed 62 days** |

```bash
curl -G "https://app.otok.io/api/v1/meeting-types/mt-1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809/slots" \
  -H "Authorization: Bearer otok_live_abc123..." \
  --data-urlencode 'from=2026-07-20T00:00:00Z' \
  --data-urlencode 'to=2026-07-27T00:00:00Z'
```

Response `200`:

```json
{
  "meeting_type_id": "mt-1a2b3c4d-…",
  "timezone": "Asia/Jerusalem",
  "duration_minutes": 30,
  "slots": [
    { "start": "2026-07-20T06:00:00.000Z", "end": "2026-07-20T06:30:00.000Z" },
    { "start": "2026-07-20T06:30:00.000Z", "end": "2026-07-20T07:00:00.000Z" }
  ]
}
```

`timezone` is the host schedule's IANA zone; slot instants are UTC ISO timestamps.

| Status | Message |
|---|---|
| 400 | `"Meeting type is not active"` |
| 400 | `"from/to must be valid ISO dates"` / `` "`to` must be after `from`" `` / `"Requested range may not exceed 62 days"` |
| 404 | Unknown meeting type |

## Embedding the booking calendar

### GET /api/v1/meeting-types/:id/embed

Everything needed to put the booking calendar on your own website — the same material shown in the oToK app under **Settings → Booking**.

```bash
curl "https://app.otok.io/api/v1/meeting-types/mt-1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809/embed" \
  -H "Authorization: Bearer otok_live_abc123..."
```

Response `200`:

| Field | Type | Meaning |
|---|---|---|
| `workspace_ref` | string | The workspace's public ref used in hosted booking URLs |
| `slug` | string | The meeting type's slug |
| `embed_key` | string | The workspace's **publishable** embed key (`bk_…`) — see below |
| `page_url` | string | The hosted booking page for this meeting type — link to it directly if you don't want an inline embed |
| `snippet_html` | string | A ready-to-paste two-line HTML snippet (a placeholder element + a script tag) rendering the booking calendar inline. Paste it verbatim where the calendar should appear — the key and meeting-type reference are already filled in |

`404` when the meeting type is unknown in this workspace; non-UUID id → 400.

**The embed key is publishable by design.** `embed_key` (`bk_…`) is meant to appear in your page's HTML — it is **not** the secret API key (`otok_live_…`), grants no API access, and must never be swapped for it in the snippet. It is workspace-level and rotatable: rotation, the allowed-origins list, and the embed on/off switch live in the oToK app under **Settings → Booking**. Rotating the key invalidates previously pasted snippets — re-fetch this endpoint (or copy the new snippet from the app) after a rotation.

Bookings made through the embed carry `source: "embed"` — the [booking webhook events](webhooks.md#booking-event-data) distinguish them from `public_page`, `manual`, and `api` bookings.

---

## Bookings

Booking object (all read and write routes):

```json
{
  "id": "bk-9f8e7d6c-…",
  "meeting_type_id": "mt-1a2b3c4d-…",
  "contact_id": "9c2f1a4e-…",
  "host_user_id": "u-1111…",
  "hosts": [ { "user_id": "u-1111…", "name": "Avi Cohen", "role": "assigned" } ],
  "status": "confirmed",
  "start_at": "2026-07-20T06:00:00.000Z",
  "end_at": "2026-07-20T06:30:00.000Z",
  "host_timezone": "Asia/Jerusalem",
  "invitee_timezone": "Europe/Berlin",
  "invitee_name": "Dana Levi",
  "invitee_email": "dana@example.com",
  "invitee_phone": "+972501234567",
  "join_url": "https://zoom.us/j/000000000",
  "notes": null,
  "source": "api",
  "cancelled_at": null,
  "cancelled_by": null,
  "cancellation_reason": null,
  "rescheduled_at": null,
  "previous_start_at": null,
  "reschedule_count": 0,
  "created_at": "2026-07-14T10:00:00.000Z",
  "updated_at": "2026-07-14T10:00:00.000Z"
}
```

`hosts` lists the assigned host first, then any co-hosts. `status` is one of `confirmed`, `cancelled`, `completed`, `no_show`. Internal fields (calendar ids, invitee management tokens, booking-page answers) are never exposed.

### GET /api/v1/bookings

| Param | Type | Notes |
|---|---|---|
| `status` | enum | `confirmed`, `cancelled`, `completed`, `no_show` |
| `meeting_type_id` | UUID | |
| `from` | ISO 8601 | `start_at >= from` |
| `to` | ISO 8601 | `start_at <= to` |
| `sort` | string | Default `-start_at`; `-` prefix for descending |
| `limit` | integer ≥ 0 | Default 50, cap 500 |
| `offset` | integer ≥ 0 | Default 0 |

All filters are optional and combined with AND. Malformed values → 400.

Response `200` — `{ data, total, limit, offset }`.

### GET /api/v1/bookings/:id

Response `200` — a booking object. `404` when unknown in this workspace. Non-UUID id → 400.

### POST /api/v1/bookings

Books a slot. The slot must be open at booking time; slot-taking is race-safe.

| Field | Type | Required | Constraints |
|---|---|---|---|
| `meeting_type_id` | UUID | yes | Must be active |
| `start_at` | string | yes | ISO 8601 — must be an open slot (use the slots endpoint) |
| `timezone` | string | yes | Valid IANA zone (e.g. `Europe/Berlin`) — recorded as the invitee's timezone |
| `contact_id` | UUID | one of `contact_id` OR `invitee` | Existing contact. When both are given, `contact_id` wins |
| `invitee` | object | ″ | `{ "name": <required, ≤200>, "email": <required, valid email, ≤320>, "phone": <optional, ≤40> }`. Upserted into contacts by phone/email; the email receives the confirmation and manage link |
| `notes` | string | no | ≤2000 |
| `host_user_id` | UUID | no | **Round-robin meeting types only:** pin the booking to this pool host (must be an active pool member with the slot free). Pinned bookings still count toward round-robin fairness |

```bash
curl -X POST "https://app.otok.io/api/v1/bookings" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{
    "meeting_type_id": "mt-1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809",
    "start_at": "2026-07-20T06:00:00.000Z",
    "timezone": "Europe/Berlin",
    "invitee": { "name": "Dana Levi", "email": "dana@example.com", "phone": "+972501234567" }
  }'
```

Response `201` — the booking object with its `hosts` roster, plus a top-level boolean **`duplicate`** field (`false` on a fresh create, `true` on a replay — see below). The usual booking side effects run (confirmation email, calendar/Zoom setup where configured).

**Idempotency is server-derived** — you do not send a key. A double submit of the same slot + meeting type + contact (+ pinned host, when used) returns the **existing confirmed booking** as a success instead of failing or double-booking: still `201`, with `duplicate: true`. For round-robin types, a pinned create can never silently replay onto a different host than the one pinned.

| Status | Code / message | Meaning |
|---|---|---|
| 400 | `"Either contact_id or an invitee object is required"` | No contact reference |
| 400 | `"Meeting type is not active"` / `"start_at must be a valid ISO date"` / `"timezone must be a valid IANA time zone id"` | Validation |
| 400 | `"Host pinning is only supported on round-robin meeting types"` / `"The pinned host is not an active member of this meeting type's pool"` | Bad `host_user_id` |
| 404 | `"No availability schedule configured for this meeting type"` | Meeting type misconfigured |
| 409 | `error_code: "SLOT_TAKEN"` — `"The selected time is no longer available"` | Slot no longer open (taken concurrently, host pool exhausted, pinned host busy). **Never forceable** — re-fetch slots and pick another time |
| 409 | `error_code: "CONTACT_MERGE_REQUIRED"` | The invitee's phone and email resolve to two different existing contacts (see [contacts](contacts.md#identity-conflict--409-contact_merge_required)) |

### POST /api/v1/bookings/:id/cancel

| Field | Type | Required | Constraints |
|---|---|---|---|
| `reason` | string | no | ≤1000 |

Response `201` — the booking with `status: "cancelled"` and `cancelled_at` / `cancelled_by` / `cancellation_reason` set. API cancellations are attributed to the host side.

| Status | Message |
|---|---|
| 400 | `"Only confirmed bookings can be cancelled"` |
| 404 | `"Booking not found"` |

### POST /api/v1/bookings/:id/reschedule

| Field | Type | Required | Constraints |
|---|---|---|---|
| `start_at` | string | yes | ISO 8601 — a new open slot |
| `timezone` | string | no | ≤64 — updates the invitee timezone; omitted keeps the existing one |

Response `201` — the booking with `previous_start_at`, `rescheduled_at`, and an incremented `reschedule_count`.

| Status | Code / message |
|---|---|
| 400 | `"Only confirmed bookings can be rescheduled"` / `"start_at must be a valid ISO date"` / `"The meeting type for this booking no longer exists"` |
| 404 | `"Booking not found"` / `"No availability schedule configured for this meeting type"` |
| 409 | `error_code: "SLOT_TAKEN"` — the target slot is no longer open |

### POST /api/v1/bookings/:id/reassign

Change which host owns a confirmed booking. Reassignment is **pre-start only** and not available for collective meeting types (where every pool host attends).

| Field | Type | Required | Constraints |
|---|---|---|---|
| `user_id` | UUID | no | Any **active** workspace member. Omitted → automatic round-robin re-pick excluding the current host (round-robin types only) |
| `reason` | string | no | ≤1000 — recorded on the assignment history |
| `force` | boolean | no | Override host-availability failures (see below). Must be literally `true` |

Response `201` — the booking with its new `hosts` roster.

| Status | Code / message | Meaning |
|---|---|---|
| 400 | `"Only confirmed bookings can be reassigned"` / `"This booking has already started"` | State guards |
| 400 | `"Collective bookings cannot be reassigned — every pool host attends"` | Collective type |
| 400 | `"This host is already assigned to the booking"` | No-op target |
| 400 | `"Choose a host — automatic reassignment is only available on round-robin meeting types"` | Omitted `user_id` on a non-round-robin type |
| 400 | `"The target host must be an active member of this workspace"` | Bad `user_id` |
| 404 | `"Booking not found"` / `"The meeting type for this booking no longer exists"` | |
| 409 | `error_code: "HOST_UNAVAILABLE"` — `"The selected host is not available at this time — use force to assign anyway"` | The target host fails a soft availability check (schedule window, notice period, buffers, daily cap, busy external calendar). **Overridable** by repeating the request with `"force": true` |
| 409 | `error_code: "SLOT_TAKEN"` | The target host has a genuine conflicting booking — **never overridable**, even with `force` |
| 409 | `error_code: "BOOKING_MODIFIED"` | The booking changed concurrently while reassigning — re-read and retry |

## 409 handling summary

| `error_code` | Retry strategy |
|---|---|
| `SLOT_TAKEN` | Pick a different slot/host. Never forceable |
| `HOST_UNAVAILABLE` | Ask a human, or repeat with `force: true` if the override is intended |
| `BOOKING_MODIFIED` | Re-read the booking and retry the operation |
| `CONTACT_MERGE_REQUIRED` | Resolve the merge request in the app, then retry |
