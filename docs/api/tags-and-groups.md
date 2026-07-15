# Tags & Contact Groups

Tags and contact groups organize contacts. Both resources support list, get, create, and update — **there are no DELETE endpoints** on the API.

All endpoints require [authentication](getting-started.md#authentication). Standard [list conventions](getting-started.md#list-conventions) apply to the list routes (`filter`, `sort`, `limit` default 50 / cap 500, `offset`, `search`); `search` matches the `name` field. Mistyped `filter` values return 400 — see [filter-value validation](getting-started.md#filter-value-validation).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/tags` | List tags |
| GET | `/api/v1/tags/:id` | Get one tag |
| POST | `/api/v1/tags` | Create a tag |
| PATCH | `/api/v1/tags/:id` | Update a tag |
| GET | `/api/v1/contact-groups` | List groups |
| GET | `/api/v1/contact-groups/:id` | Get one group |
| POST | `/api/v1/contact-groups` | Create a group |
| PATCH | `/api/v1/contact-groups/:id` | Update a group |

> **Duplicate names:** tag and group names are unique per workspace (case-insensitive). Creating or renaming to a name that already exists returns **409 Conflict** — `"A tag with this name already exists"` / `"A contact group with this name already exists"`. On 409, look up the existing record (list with `search=<name>` and compare case-insensitively) and reuse it.

> **Relationship to contacts:** contact write endpoints take tag/group **names** and auto-create missing ones, while contact read endpoints return tag/group **ids**. Use these endpoints to map between the two. See the [round-trip warning](contacts.md#the-contact-object).

---

## Tags

Tag object:

```json
{
  "id": "b1a2c3d4-0000-0000-0000-000000000001",
  "workspace_id": "…",
  "name": "VIP",
  "color": "#f59e0b",
  "type": "both",
  "usage_count": 42,
  "created_at": "2026-06-01T08:00:00.000Z",
  "updated_at": "2026-06-01T08:00:00.000Z"
}
```

`usage_count` is computed — the number of contacts currently carrying the tag (`0` on a fresh tag).

### GET /api/v1/tags

```bash
curl -G "https://app.otok.io/api/v1/tags" \
  -H "Authorization: Bearer otok_live_abc123..." \
  --data-urlencode 'search=vip'
```

Response `200` — `{ data, total, limit, offset }`.

### GET /api/v1/tags/:id

Response `200` — a tag object. `404` — `"tags with ID <id> not found"`. Non-UUID id → 400.

### POST /api/v1/tags

| Field | Type | Required | Constraints |
|---|---|---|---|
| `name` | string | yes | 1–100 chars |
| `color` | string | no | ≤20 chars |
| `type` | enum | no | `contact`, `conversation`, `both` (default `both`) |

```bash
curl -X POST "https://app.otok.io/api/v1/tags" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{ "name": "VIP", "color": "#f59e0b", "type": "contact" }'
```

Response `201` — the created tag with `usage_count: 0`.

| Status | Meaning |
|---|---|
| 400 | Missing/empty `name`, unknown fields |
| 409 | `"A tag with this name already exists"` — names are unique per workspace (case-insensitive) |

### PATCH /api/v1/tags/:id

Same fields as create, all optional.

Response `200` — the updated tag.

| Status | Meaning |
|---|---|
| 400 | Validation / non-UUID id |
| 404 | `"tags with ID <id> not found"` |
| 409 | `"A tag with this name already exists"` — renaming to another tag's name |

---

## Contact Groups

Group object:

```json
{
  "id": "7f6e5d4c-0000-0000-0000-000000000002",
  "workspace_id": "…",
  "name": "Beta testers",
  "description": "Contacts enrolled in the beta program",
  "color": "#3b82f6",
  "is_system": false,
  "contact_count": 128,
  "created_at": "2026-05-20T12:00:00.000Z",
  "updated_at": "2026-05-20T12:00:00.000Z"
}
```

`contact_count` is computed — the number of member contacts.

### GET /api/v1/contact-groups

Response `200` — `{ data, total, limit, offset }`.

### GET /api/v1/contact-groups/:id

Response `200` — a group object. `404` — `"contactGroups with ID <id> not found"`.

### POST /api/v1/contact-groups

| Field | Type | Required | Constraints |
|---|---|---|---|
| `name` | string | yes | 1–100 chars |
| `description` | string | no | ≤500 chars |
| `color` | string | no | ≤20 chars |

```bash
curl -X POST "https://app.otok.io/api/v1/contact-groups" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{ "name": "Beta testers", "description": "Contacts enrolled in the beta program" }'
```

Response `201` — the created group with `contact_count: 0`.

| Status | Meaning |
|---|---|
| 400 | Missing/empty `name`, unknown fields |
| 409 | `"A contact group with this name already exists"` — names are unique per workspace (case-insensitive) |

### PATCH /api/v1/contact-groups/:id

Same fields as create, all optional.

Response `200` — the updated group.

| Status | Meaning |
|---|---|
| 400 | Validation / non-UUID id |
| 404 | `"contactGroups with ID <id> not found"` |
| 409 | `"A contact group with this name already exists"` — renaming to another group's name |

---

## Managing membership

Group membership and tag assignment are managed **through the contact endpoints**, not here:

- `POST /v1/contacts` — **adds** the given tag/group names to a contact.
- `PATCH /v1/contacts/:id` — **replaces** the contact's full tag/group set.

To list a group's members, filter contacts by group id:

```bash
curl -G "https://app.otok.io/api/v1/contacts" \
  -H "Authorization: Bearer otok_live_abc123..." \
  --data-urlencode 'filter={"$jsonb_contains":{"groups":["7f6e5d4c-0000-0000-0000-000000000002"]}}'
```
