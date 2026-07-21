# Consent & Suppressions

oToK's compliance surface has **two deliberately independent layers**, and this page covers both:

1. **Per-channel consent** — the contact's recorded marketing-consent *decision* on each channel (`whatsapp` / `email`), with its legal basis and evidence trail. Read and written on the [contact](contacts.md).
2. **The email suppression list** — a workspace-level *send-time block* on specific addresses, independent of any contact's consent.

They compose at send time: every email send checks **both** (plus deliverability and the blacklist). Adding a suppression does **not** change a contact's consent state, and removing one does **not** resubscribe anyone.

All endpoints require [authentication](getting-started.md#authentication). Consent endpoints are not feature-gated; the suppression endpoints require the **Email marketing** feature (`email_marketing`) on the workspace's plan — without it every `/v1/suppressions*` call returns `403` with `error_code: "FEATURE_NOT_INCLUDED_IN_PLAN"`. Errors on this page use the structured envelope `{"error": {"code", "message"}}` (validation failures use the [standard shape](getting-started.md#error-responses)).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/contacts/:id/consent` | Read a contact's consent — both channels at once |
| PUT | `/api/v1/contacts/:id/consent/:channel` | Record a consent decision on one channel |
| GET | `/api/v1/suppressions` | List the workspace's suppression rows |
| POST | `/api/v1/suppressions` | Suppress an address (idempotent) — `email_marketing` feature |
| DELETE | `/api/v1/suppressions/:id` | Remove a suppression |

## Consent

### The per-channel consent object

Each channel composes three things: the stored **consent decision**, the provider-owned **deliverability** axis, and (email only) the composed send-time **suppression verdict**.

| Field | Type | Notes |
|---|---|---|
| `consent_state` | enum | `subscribed`, `unsubscribed`, `unknown`. **`unknown` = no decision recorded yet — treat it as not sendable.** |
| `consent_basis` | enum or `null` | `express_opt_in`, `double_opt_in`, `soft_opt_in`, `implied`, `imported` |
| `consent_source` | string or `null` | Provenance of the stored decision — API writes read `api` or `api:<your source>`; other surfaces stamp their own (form ids, `manual`, …) |
| `consent_at` / `consent_expires_at` | ISO 8601 or `null` | When the decision was recorded / when it expires |
| `deliverability` | enum | `unknown`, `deliverable`, `temporarily_bounced`, `bounced`, `complained` — **provider-owned** (bounce/complaint feedback), never writable through the API. `complained` is sticky (see below) |
| `unsubscribed_at` / `complained_at` / `last_bounce_at` | ISO 8601 or `null` | |
| `suppressed` | boolean | **Email channel only.** The composed send-time verdict — `true` when the suppression list, the blacklist, or a `bounced`/`complained` deliverability blocks sends |
| `suppression_reason` | string or `null` | **Email channel only.** Why, prefixed by the layer — e.g. `suppression:manual`, `suppression:unsubscribe`, `blacklist:global`, `blacklist:workspace`, `deliverability:bounced`. `null` when not suppressed |

### GET /api/v1/contacts/:id/consent

Returns both channels at once, plus the contact-level `block_state` (`none` / `workspace` / `global` — independent of per-channel consent).

```bash
curl "https://app.otok.io/api/v1/contacts/9c2f1a4e-.../consent" \
  -H "Authorization: Bearer otok_live_abc123..."
```

Response `200`:

```json
{
  "contact_id": "9c2f1a4e-3b7d-4e2a-9f0c-1d2e3f4a5b6c",
  "block_state": "none",
  "channels": {
    "whatsapp": {
      "consent_state": "subscribed",
      "consent_basis": "express_opt_in",
      "consent_source": "form:welcome",
      "consent_at": "2026-06-01T09:00:00.000Z",
      "consent_expires_at": null,
      "deliverability": "deliverable",
      "unsubscribed_at": null,
      "complained_at": null,
      "last_bounce_at": null
    },
    "email": {
      "consent_state": "unknown",
      "consent_basis": null,
      "consent_source": null,
      "consent_at": null,
      "consent_expires_at": null,
      "deliverability": "unknown",
      "unsubscribed_at": null,
      "complained_at": null,
      "last_bounce_at": null,
      "suppressed": false,
      "suppression_reason": null
    }
  }
}
```

| Status | Code | Meaning |
|---|---|---|
| 404 | `contact_not_found` | Unknown contact, or another workspace's contact |

### PUT /api/v1/contacts/:id/consent/:channel

Records a subscribed/unsubscribed decision on `whatsapp` or `email` — the same path every in-app consent change takes, so the consent-evidence ledger and the contact's activity timeline apply identically. Returns the resulting **single-channel** object (same shape as in GET), so you see the applied state, stamped provenance, and deliverability.

| Field | Type | Required | Constraints |
|---|---|---|---|
| `state` | enum | yes | `subscribed` \| `unsubscribed`. **`unknown` is a system state and cannot be set** |
| `basis` | enum | no | `express_opt_in`, `double_opt_in`, `soft_opt_in`, `implied`, `imported`. Defaults to `express_opt_in` when subscribing |
| `source` | string | no | ≤100 chars; recorded as `api:<source>` in the evidence trail (plain `api` when omitted) |
| `expires_at` | ISO 8601 | no | When this consent expires |
| `ip` | string | no | ≤64 chars — end-user IP for the evidence trail |
| `user_agent` | string | no | ≤512 chars — end-user user agent for the evidence trail |

```bash
curl -X PUT "https://app.otok.io/api/v1/contacts/9c2f1a4e-.../consent/email" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{
    "state": "subscribed",
    "basis": "express_opt_in",
    "source": "crm-sync",
    "ip": "203.0.113.7"
  }'
```

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_channel` | The `:channel` segment must be `whatsapp` or `email` |
| 404 | `contact_not_found` | Unknown contact, or another workspace's contact |
| 409 | `consent_sticky_complained` | **The spam-complaint gate is sticky:** a channel whose deliverability is `complained` can never be re-subscribed through the API |

Notes:

- `deliverability` is provider-owned and **not writable** — recording consent never resets bounce/complaint state.
- Re-asserting the same state (e.g. subscribing an already-subscribed channel) is accepted and refreshes provenance; it does not fire a [`contact.consent_changed` webhook](webhooks.md#contact-events).
- Consent changes made here fire the opt-in `contact.consent_changed` webhook like any other consent surface.

## Suppressions

The workspace's slice of the email suppression list. Suppression is a **send-time overlay, deliberately separate from consent** — a row here blocks every future send to the address regardless of what any contact's consent says. The HQ-managed *global* list is enforced at send time too, but it is never returned by (and can never be lifted through) this API.

### The suppression object

| Field | Type | Notes |
|---|---|---|
| `id` | UUID | |
| `email` | string | The suppressed address |
| `reason` | enum | `unsubscribe`, `bounce`, `complaint`, `manual` (API-writable values); system rows may carry others (e.g. `global`) |
| `source` | string or `null` | Which surface created the row — `api` for API adds |
| `note` | string or `null` | |
| `created_at` | ISO 8601 | |

### GET /api/v1/suppressions

Standard [list envelope](getting-started.md#pagination) (`limit` default 50, cap 500), newest first.

| Param | Type | Notes |
|---|---|---|
| `email` | string | Exact-match filter (case-insensitive) |
| `limit` / `offset` | integer | Standard paging; malformed values return 400 |

### POST /api/v1/suppressions — idempotent add

| Field | Type | Required | Constraints |
|---|---|---|---|
| `email` | string | yes | Valid email, ≤255 chars |
| `reason` | enum | no | `unsubscribe` \| `bounce` \| `complaint` \| `manual` — defaults to `manual` |
| `note` | string | no | ≤500 chars |

Re-adding an already-suppressed address returns the **existing row** with `duplicate: true` — **201 for both outcomes**, so blind retries are safe:

```bash
curl -X POST "https://app.otok.io/api/v1/suppressions" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{"email": "jane@example.com", "reason": "manual", "note": "asked by phone"}'
```

Response `201`:

```json
{
  "id": "3d2c1b0a-9e8f-7061-5243-a1b2c3d4e5f6",
  "email": "jane@example.com",
  "reason": "manual",
  "source": "api",
  "note": "asked by phone",
  "created_at": "2026-07-16T10:00:00.000Z",
  "duplicate": false
}
```

> Adding a suppression does **not** change the contact's consent state — the contact may still read `subscribed`, but sends are blocked. Check the composed picture with [`GET /v1/contacts/:id/consent`](#get-apiv1contactsidconsent) (`channels.email.suppressed`).

### DELETE /api/v1/suppressions/:id

Response **204**, no body. Lifts **this workspace's** suppression only:

- It does **not** resubscribe anyone — consent state is unchanged, and an unsubscribed contact stays unsubscribed.
- HQ-managed global rows cannot be removed through the API (they answer 404).

| Status | Code | Meaning |
|---|---|---|
| 404 | `suppression_not_found` | Unknown id, another workspace's row, or a global row |

## How the layers compose at send time

For an email send to go out, **all** of these must pass:

1. The contact's email `consent_state` is `subscribed` (campaign/marketing sends; [transactional sends](emails.md) skip the consent check but never the suppression check).
2. The address is not on the suppression list (workspace **or** global).
3. The address is not blacklisted.
4. Deliverability is not `bounced`/`complained` (hard-bounced and complaining addresses are auto-blocked).

`GET /v1/contacts/:id/consent` shows you the whole picture in one call — `channels.email.suppressed` + `suppression_reason` are exactly the composed verdict the send pipeline uses.
