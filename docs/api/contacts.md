# Contacts

Manage workspace contacts and their notes. Contacts are the core record most other resources (deals, payments, bookings, campaigns) attach to.

All endpoints require [authentication](getting-started.md#authentication). There is no DELETE endpoint for contacts on the API.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/contacts` | List contacts (paginated, filterable) |
| GET | `/api/v1/contacts/:id` | Get one contact |
| POST | `/api/v1/contacts` | **Upsert** a contact by phone/email/national ID |
| PATCH | `/api/v1/contacts/:id` | Update a contact by id |
| GET | `/api/v1/contacts/:id/consent` | Read per-channel marketing consent — see [Consent & Suppressions](consent-and-suppressions.md) |
| PUT | `/api/v1/contacts/:id/consent/:channel` | Record a consent decision — see [Consent & Suppressions](consent-and-suppressions.md) |
| GET | `/api/v1/contacts/:id/documents` | List a contact's financial documents (requires the **Payments** feature) |
| GET | `/api/v1/contacts/:id/notes` | List a contact's notes |
| POST | `/api/v1/contacts/:id/notes` | Add a note |
| PATCH | `/api/v1/notes/:id` | Edit / pin a note |
| DELETE | `/api/v1/notes/:id` | Delete a note |

> **Consent lives on its own page.** A contact's WhatsApp/email marketing consent — the recorded decision, its legal basis, deliverability, and the composed send-time suppression verdict — is read and written through the consent endpoints, documented in [Consent & Suppressions](consent-and-suppressions.md).

## The contact object

Responses return the full contact record plus computed fields:

- `tags` — array of tag **ids** (strings)
- `groups` — array of group **ids**
- `event_attendances` — `[{id, event_id, status, registered_at, attended_at, unregistered_at}]`
- `whatsapp_subscribed`, `email_subscribed` (booleans), `whatsapp_deliverability`, `email_deliverability` — per-channel consent state (contacts without a subscription record report `false` / `"unknown"`)
- `national_id` — normalized national ID, or `null`.
- `owner_user_id` and `owner` — the owning member id and `{ id, name, email }`, or `null` when unowned.
- `score_band` — read-only lead-scoring band: `"cold"`, `"warm"`, `"hot"`, or `null`

> **Round-trip warning — tags/groups are NAMES on input, IDS on output.** `POST`/`PATCH` accept tag and group **names**; `GET` returns **ids**. Never echo the ids from a GET back into a write: unrecognized names are auto-created, so a UUID sent as a "name" creates a brand-new tag literally named like that UUID. Map ids back to names first (see [Tags & Contact Groups](tags-and-groups.md)).

---

## GET /api/v1/contacts

Standard [list conventions](getting-started.md#list-conventions) apply (`filter`, `sort`, `limit` default 50 / cap 500, `offset`, `search`).

`search` matches `name`, `first_name`, `last_name`, `email`, `phone`, `company_name` (case-insensitive substring), plus an exact match on the E.164-normalized form of the term and the contact's historical phone/email identifiers.

```bash
curl -G "https://app.otok.io/api/v1/contacts" \
  -H "Authorization: Bearer otok_live_abc123..." \
  --data-urlencode 'filter={"lifecycle_stage":"customer"}' \
  --data-urlencode 'sort=-updated_at' \
  --data-urlencode 'limit=25'
```

Response `200` — `{ data, total, limit, offset }`.

| Status | Meaning |
|---|---|
| 400 | Invalid `filter` JSON / non-object filter / invalid `limit`/`offset` / a mistyped filter value (`Invalid filter value for "<field>": …` — see [filter-value validation](getting-started.md#filter-value-validation)) |
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

Creates a contact, or **updates the existing contact** that the given `phone`/`email` resolves to. This is the recommended way to write contacts from external systems — including changing a contact’s phone or email.

### Request body

Every field is optional. Unknown fields → 400.

| Field | Type | Constraints |
|---|---|---|
| `phone` | string | ≤32 chars; normalized to E.164 (local numbers use the workspace default country) |
| `name` | string | ≤200 |
| `first_name` / `last_name` | string | ≤100 each |
| `email` | string | valid email, ≤255 |
| `national_id` | string | ≤20 chars; Israeli national ID, normalized to nine digits after check-digit validation. Invalid check digits are ignored. Participates in matching after phone/email. |
| `owner_email` | string | Active workspace member’s login email; takes precedence over `owner_user_id`. An unknown or inactive member returns 400 `INVALID_CONTACT_OWNER`. |
| `owner_user_id` | UUID or `null` | Active workspace member id; `null` clears the owner. |
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
| `employee_count` | integer | 0 – 2,147,483,647 |
| `currency_preference` | string | ≤8 |
| `address_line1` / `address_line2` | string | ≤200 each |
| `city` / `state` / `country` | string | ≤100 each |
| `postal_code` | string | ≤20 |
| `gender` | enum | `male`, `female`, `other`, `prefer_not_to_say` |
| `date_of_birth` | string | ISO 8601 date |
| `language` | string | ≤12 |
| `utm_source` / `utm_medium` / `utm_campaign` / `utm_term` / `utm_content` / `gclid` / `fbclid` | string | ≤200 each |
| `msclkid` / `gbraid` / `wbraid` / `ttclid` / `li_fat_id` | string | ≤500 each; advertising click identifiers |
| `lead_score` | number | **Engine-owned:** silently ignored while workspace lead scoring is enabled — the response echoes the computed score. Writable only when scoring is disabled. |
| `linkedin_url` / `facebook_url` | string | ≤500 each |
| `instagram_handle` / `twitter_handle` | string | ≤100 each |
| `custom_fields` | object | Arbitrary keys; **shallow-merged** into the existing object on update |
| `tags` | string[] | Tag **names**, each 1–100 chars. Missing tags are auto-created. |
| `groups` | string[] | Group **names**, each 1–100 chars. Missing groups are auto-created. |

Changing a contact's owner also transfers eligible live records held by the previous owner, including open deals, tasks and inquiries, draft/sent quotes, and upcoming bookings.

An impossible incoming phone does not replace an existing valid phone. Send an empty string to explicitly clear it; inspect the returned phone after writing.

### Marketing metadata

The following native fields appear in the contact's **Marketing** section. They
are optional strings accepted by both `POST /api/v1/contacts` and
`PATCH /api/v1/contacts/:id`, and returned with contact records (nullable when
unset). Supply them as top-level properties, alongside the UTM fields.

| Field | Maximum length | Description |
|---|---|---|
| `source_page_url` | 2048 | URL of the source page associated with the contact. |
| `source_page_title` | 500 | Title of the source page associated with the contact. |
| `referrer` | 2048 | Referring URL or source associated with the contact. |
| `user_agent` | 2048 | Browser or client user-agent string associated with the contact. |
| `affiliate` | 200 | Affiliate name or identifier associated with the contact. |

Example request body:

```json
{
  "email": "jane@example.com",
  "source_page_url": "https://example.com/signup",
  "source_page_title": "Newsletter signup",
  "referrer": "https://example.com/blog",
  "user_agent": "Mozilla/5.0",
  "affiliate": "partner-123"
}
```

### Acquisition events and inquiry capture (POST only)

Use `acquisition` for an actual submission, including a returning contact submitting a new form. It is a request option, not a stored contact profile field.

| Field inside `acquisition` | Constraints |
|---|---|
| `event_id` | Required, non-empty string, ≤180 chars. Reuse for retries for the **same contact**; use a new id for each genuine submission. |
| `occurred_at` | ISO 8601 timestamp; omitted uses capture time. |
| `visitor_id` | 8–64 letters, digits, underscores or hyphens. |
| `landing_url` / `referrer_url` | Strings, ≤2048 chars each. |
| `utm_source` / `utm_medium` / `utm_campaign` / `utm_term` / `utm_content` | Strings, ≤500 chars each. |
| `gclid` / `fbclid` / `msclkid` / `gbraid` / `wbraid` / `ttclid` / `li_fat_id` | Strings, ≤500 chars each. |
| `platform_campaign_id` / `form_name` | Strings, ≤500 chars each. |

The event's source values take precedence over corresponding top-level fields. Top-level marketing fields alone create acquisition context only when a contact is first created; ordinary profile updates do not add another acquisition event. Capture is best-effort: a successful profile write does not guarantee that attribution was recorded.

The top-level `inquiry` option controls the inquiry queue:

| Value | Behavior |
|---|---|
| `create` (default) | Opens an inquiry when a contact is created **or** an explicit acquisition is supplied, including for an existing contact. |
| `always` | Also captures ordinary updates. Without an acquisition id, updates for the same contact within one UTC hour collapse into one inquiry. |
| `never` | Opens no inquiry. Use for bulk backfills and CRM syncs. Does not disable an explicitly supplied acquisition event. |

With `acquisition.event_id`, both the event and its inquiry are deduplicated per contact and event id. Send the same identity and event id when retrying.

Example body (all values are illustrative):

```json
{
  "email": "jane@example.com",
  "acquisition": {
    "event_id": "signup-example-001",
    "landing_url": "https://example.com/signup",
    "utm_source": "newsletter",
    "utm_campaign": "autumn-course",
    "form_name": "Course interest"
  }
}
```

Both `acquisition` and `inquiry` are rejected on PATCH with 400. PATCH is a profile edit and never opens an inquiry.

### Upsert resolution

1. `phone`, `email`, and `national_id` are normalized.
2. The API looks up the current owner of each identifier — resolution is **history-aware**: a phone/email that was moved off a contact still resolves to its most recent holder if no current owner exists.
3. Matching precedence is **phone → email → national ID**. Split matches follow the rules below. Always use the contact `id` returned by the API.
4. Match found → **update**: scalar fields overwrite, `custom_fields` shallow-merge, and `tags`/`groups` are **added** to the existing set (never removed by this route).
5. No match → **create**. Concurrent creates of the same identity are safe — the loser of the race is retried as an update of the winner.

The response is **201 in both cases** (create and update) with the full contact object, plus a top-level boolean **`duplicate`** field: `false` when this request created the contact, `true` when it matched and updated an existing one.

### Identity conflict — 409 `CONTACT_MERGE_REQUIRED`

When incoming identifiers resolve to different **current** contacts, POST can automatically merge complementary records: every non-empty phone, email and national ID must agree across the records and the incoming payload. Blanks can be filled. A phone-only record and a compatible email-only record can therefore become one contact; the response returns the surviving id with `duplicate: true`.

Conflicting identifiers, historical split matches, and pairs awaiting or preserving a human review decision still require in-app resolution. In that case the API opens a merge request and responds:

```json
{
  "statusCode": 409,
  "error": "Conflict",
  "error_code": "CONTACT_MERGE_REQUIRED",
  "merge_request_id": "3a2b1c0d-4e5f-6a7b-8c9d-0e1f2a3b4c5d",
  "message": "The provided identifiers belong to different existing contacts. A merge request has been opened — resolve it in the app, then retry."
}
```

The non-identity fields of your request are parked with the merge request and applied when it is resolved. Retry after the merge request is resolved in the app. Repeated conflicting requests for the same pair reuse the same merge request.

### Example

```bash
curl -X POST "https://app.otok.io/api/v1/contacts" \
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
  "duplicate": false,
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

### Identity conflict — 409 `CONTACT_MERGE_REQUIRED` (PATCH)

Setting `phone`/`email`/`national_id` to an identifier that belongs to a *different* contact does **not** apply the write. Like the POST upsert's conflict path, the API opens a merge request for the workspace to resolve in-app and responds:

```json
{
  "statusCode": 409,
  "error": "Conflict",
  "error_code": "CONTACT_MERGE_REQUIRED",
  "merge_request_id": "3a2b1c0d-4e5f-6a7b-8c9d-0e1f2a3b4c5d",
  "message": "This change would give the contact a phone or email that already belongs to another contact. A merge request was opened — resolve it (merge or dismiss) to apply the change."
}
```

The non-identity fields sent in the same PATCH are held on the merge request and applied when it is resolved (merge **or** dismiss).

> **The conflict check is history-aware.** A PATCH that sets a phone/email no contact *currently* holds but that another contact *previously* held also parks a merge request and returns this 409 — matching the in-app editor's behavior.

| Param | Type | Notes |
|---|---|---|
| `id` | UUID (path) | Non-UUID → 400 |

```bash
curl -X PATCH "https://app.otok.io/api/v1/contacts/9c2f1a4e-3b7d-4e2a-9f0c-1d2e3f4a5b6c" \
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
| 409 | `error_code: "CONTACT_MERGE_REQUIRED"` | The new phone/email belongs (or previously belonged) to another contact — see above |

---

## GET /api/v1/contacts/:id/documents

Read-only listing of a contact's **financial documents** — invoices, receipts, and credit documents — aggregated from every stored document pointer on the contact's [payments](payments.md), payment entries, and [payment requests](payment-requests.md), deduplicated, merged, and sorted date-descending (nulls last).

> **Plan feature required:** unlike the rest of the contacts routes, this endpoint requires the **Payments** feature on the workspace's plan (the same gate as `/v1/payments*`). Without it, calls return `403` with `error_code: "FEATURE_NOT_INCLUDED_IN_PLAN"` — see [feature-gated resource groups](getting-started.md#feature-gated-resource-groups).

| Param | Type | Notes |
|---|---|---|
| `id` | UUID (path) | Non-UUID → 400 |
| `live` | `true` \| `false` (query) | Default `false` (stored pointers only). `true` additionally queries the connected payment provider for a live document listing and merges it in — bounded to ~2.5 s; a timeout or provider failure degrades to the stored listing (reported in `live.error`), and a missing/not-entitled provider degrades to an empty live listing. Any other value → 400 `"Invalid live: must be true or false"` |

```bash
curl "https://app.otok.io/api/v1/contacts/9c2f1a4e-3b7d-4e2a-9f0c-1d2e3f4a5b6c/documents?live=true" \
  -H "Authorization: Bearer otok_live_abc123..."
```

Response `200`:

```json
{
  "documents": [
    {
      "key": "sumit:123456",
      "kind": "tax_invoice_receipt",
      "rawType": null,
      "isCredit": false,
      "provider": "sumit",
      "documentId": "123456",
      "number": "2043",
      "url": "https://app.sumit.co.il/…/document.pdf",
      "date": "2026-07-14T10:00:00.000Z",
      "amount": 350,
      "currency": "ILS",
      "origin": "merged",
      "sources": [
        { "type": "contact_payment", "id": "7b6a5c4d-…" },
        { "type": "provider", "provider": "sumit" }
      ]
    }
  ],
  "live": { "attempted": true, "ok": true, "complete": true, "error": null }
}
```

Document fields:

| Field | Meaning |
|---|---|
| `key` | Aggregator-computed stable render key — carries no semantics |
| `kind` | Canonical document kind (`tax_invoice`, `tax_invoice_receipt`, `receipt`, `receipt_for_invoice`, `proforma_invoice`, `donation_receipt`, `credit_invoice`, `credit_invoice_receipt`, `credit_receipt`, `credit_donation_receipt`, `order`, `price_quote`, `delivery_note`, `payment_demand`) — or `null` with the provider's original label in `rawType` |
| `isCredit` | Credit/refund document |
| `provider` | `cardcom` / `sumit` / `null` |
| `documentId` / `number` | Provider durable id; human-facing document number |
| `url` | **May be `null`** (legacy number-only rows) — always check before opening, and only open http(s) URLs |
| `date` / `amount` / `currency` | Stored documents carry the host row's instant/amount; live documents carry the provider document's own values |
| `origin` | `stored`, `live`, or `merged` (found in both) |
| `sources` | The records the document was aggregated from: `{type: "contact_payment", id}`, `{type: "payment_entry", id, paymentId}`, `{type: "payment_request", id}`, `{type: "provider", provider}` |

The `live` object reports the provider lookup: `attempted` (a live lookup ran), `ok` (`false` = it failed or timed out), `complete` (`false` = the live listing may be missing documents), `error` (`"timeout"`, `"provider_error"`, or `null`). With the default `live=false`, `attempted` is `false` and the listing is stored-only.

| Status | Meaning |
|---|---|
| 400 | Non-UUID contact id, or a malformed `live` value |
| 403 | `FEATURE_NOT_INCLUDED_IN_PLAN` — plan lacks the Payments feature |
| 404 | `"contacts with ID <id> not found"` — same lookup and wording as `GET /v1/contacts/:id`, so an unknown or cross-workspace contact answers identically instead of an empty-but-plausible list |

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
curl -X POST "https://app.otok.io/api/v1/contacts/9c2f1a4e-3b7d-4e2a-9f0c-1d2e3f4a5b6c/notes" \
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
