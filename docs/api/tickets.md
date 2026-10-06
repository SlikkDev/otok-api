# Customer Tickets

Your customers' support tickets — the same tickets your team works under **Tickets** in the oToK app, and that customers open and follow on the workspace's hosted help page or website widget. Over the API your own systems can open tickets, read them with their conversation, answer the customer, and triage (status, priority, category, assignee). Lifecycle changes fire the opt-in [`ticket.*` webhooks](webhooks.md#ticket-events).

Every write here does exactly what the same action does inside oToK. A ticket opened here is routed, starts its response target, alerts the team and emails the customer their ticket link like one opened on the help page; a reply here is a real team reply — the ticket moves to **Answered**, its response target is met, and the customer is emailed. Internal notes and system lines never leave through the API.

All endpoints require [authentication](getting-started.md#authentication). There is no DELETE — close a ticket instead.

> **Plan feature required:** every route on this page requires the **Customer tickets** feature (`customer_tickets`, Growth and up) on the workspace's plan. Without it, all calls return `403` with `error_code: "FEATURE_NOT_INCLUDED_IN_PLAN"` (the message embeds `customer_tickets`) — see [feature-gated resource groups](getting-started.md#feature-gated-resource-groups).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/tickets` | List tickets (filterable, paginated) |
| GET | `/api/v1/tickets/:id` | Get one ticket with a page of its conversation |
| POST | `/api/v1/tickets` | Open a ticket — idempotent via `external_reference` |
| POST | `/api/v1/tickets/:id/replies` | Reply to the customer — idempotent via `idempotency_key` |
| PATCH | `/api/v1/tickets/:id` | Triage: status, priority, category, assignee |

**Errors.** Business refusals on these routes use the structured envelope `{"error": {"code", "message"}}` — key on `error.code`. Request-validation failures (unknown or malformed fields, a non-UUID path id) use the standard `{"statusCode", "message", "error"}` shape. Two contact refusals keep their shared shape with a top-level `error_code`: `CONTACT_MERGE_REQUIRED` (see [contacts](contacts.md#identity-conflict--409-contact_merge_required)) and `CONTACT_ANONYMISED` — the ticket's contact was anonymised, so the ticket takes no more writes:

```json
{
  "message": "This contact was anonymised — …",
  "error_code": "CONTACT_ANONYMISED",
  "contact_id": "9c2f1a4e-3b7d-4e2a-9f0c-1d2e3f4a5b6c"
}
```

## The ticket object

The same object on every route here and in every [`ticket.*` webhook](webhooks.md#ticket-event-data) (`data.ticket`).

| Field | Type | Notes |
|---|---|---|
| `id` | UUID | |
| `number` | integer | The workspace's running ticket number |
| `number_label` | string | The number as customers see it, with the workspace's prefix (e.g. `"T-1042"`) |
| `subject` | string | |
| `status` | string | `open`, `pending`, `resolved`, `closed` or `spam` — see [statuses](#statuses) |
| `priority` | string | `low`, `normal`, `high` or `urgent` |
| `category` | string or `null` | One of the workspace's ticket categories |
| `source` | string | Where the ticket was opened: `portal` (the hosted help page), `widget` (the website widget), `agent` (logged by a team member in the app) or `api` |
| `language` | string | The customer's language for emails and auto-replies: `en` or `he` |
| `widget_id` | UUID or `null` | The website widget the ticket came through, when `source` is `widget` |
| `external_reference` | string or `null` | Your own key, as sent to `POST /v1/tickets` |
| `contact` | object or `null` | `{ id, name, email, phone }` — the customer |
| `assignee` | object or `null` | `{ id, name, email }` of the assigned team member; `null` when unassigned |
| `first_response_at` | ISO 8601 or `null` | When the team first replied |
| `response_target` | object or `null` | The running response target, when the workspace has targets on: `{ status, metric, due_at }` — `status` is `ok`, `at_risk` or `breached`; `metric` is `first_reply` (the first answer) or `next_reply` (the answer to a customer follow-up). `null` while no target is running (for example, once the team has answered) |
| `last_message_at` | ISO 8601 or `null` | |
| `resolved_at` / `closed_at` | ISO 8601 or `null` | |
| `created_at` / `updated_at` | ISO 8601 | |

### Statuses

| Status | Meaning |
|---|---|
| `open` | Waiting on the team — a new ticket, or the customer replied |
| `pending` | **Answered** — the team replied and the ball is with the customer. Set by a reply, never by PATCH |
| `resolved` | The team (or the customer) marked it solved. The customer can still reply, which reopens it. A resolved ticket closes on its own after the workspace's configured quiet period |
| `closed` | Done. A customer reply still reopens it |
| `spam` | Filed silently — a ticket a blocked contact opened. It is never routed, mailed or announced, takes no replies, and is left out of the default listing |

### The message object

| Field | Type | Notes |
|---|---|---|
| `id` | UUID | |
| `side` | string | `customer` or `team` |
| `origin` | string | Who posted it: `customer` (the customer themself), `agent` (a team member — including the opening message of a ticket a team member logged on the customer's behalf), `automation` (an automation's reply) or `api` (posted through this API, whoever it was posted as). Use it to recognise — and drop — your own API posts when they come back to you |
| `author` | object or `null` | `{ id, name }` of the team member behind a team message; `null` on customer messages and on team messages with no person behind them (the team, an automation) |
| `body` | string or `null` | The message text |
| `media_url` | string or `null` | A link to the message's attachment, **signed for 4 hours** — fetch the ticket again for a fresh one |
| `media_filename` / `media_mime_type` | string or `null` | |
| `media_size` | integer or `null` | Bytes |
| `created_at` | ISO 8601 | |

### The customer-email object (`last_customer_email`)

The ticket's latest email to the customer and its state — including one that did not go out. `null` when the ticket has never emailed its customer. Returned only by `GET /v1/tickets/:id`.

| Field | Type | Notes |
|---|---|---|
| `kind` | string | `reply` (the email telling the customer the team answered) or `other` (the ticket link, creation or resolved email) |
| `status` | string | `queued`, `sent`, `delivered`, `bounced`, `complained`, `failed` or `skipped_suppressed` |
| `reason` | string or `null` | Why it did not go out — `no_verified_sender`, `over_quota`, `capped`, `suppressed` or `send_failed` (see [customer emails](#customer-emails)); `null` otherwise (a `bounced` / `complained` status says it all) |
| `created_at` / `sent_at` / `bounced_at` / `complained_at` | ISO 8601 or `null` | |

---

## GET /api/v1/tickets

Filters are ANDed.

| Param | Type | Notes |
|---|---|---|
| `status` | string (query) | `open`, `pending`, `resolved`, `closed`, `spam` or `all`. Default `all`, which is **every status except `spam`** — ask for `status=spam` explicitly |
| `contact_id` | UUID (query) | Only this contact's tickets |
| `assignee` | string (query) | A team member's user id, or `unassigned`. Anything else → 400 `invalid_assignee` |
| `category` | string (query) | Exact category label, case-insensitive |
| `priority` | string (query) | `low`, `normal`, `high`, `urgent` |
| `source` | string (query) | `portal`, `widget`, `agent`, `api` |
| `external_reference` | string (query) | Your own key, exact match (whitespace trimmed). A blank value is a 400, never "no filter" |
| `created_from` / `created_to` | ISO 8601 (query) | Created at/after, at/before this instant. A date that does not exist → 400 `invalid_date` |
| `sort` | string (query) | `last_message_at`, `-last_message_at` (default — newest activity first), `created_at`, `-created_at` |
| `limit` | integer (query) | Page size, default 50, max 200 (larger values are clamped) |
| `offset` | integer (query) | Rows to skip, default 0 |

```bash
curl "https://app.otok.io/api/v1/tickets?status=open&assignee=unassigned" \
  -H "Authorization: Bearer otok_live_abc123..."
```

Response `200`: `{ "data": [ …ticket objects… ], "total": 12, "limit": 50, "offset": 0 }`. List rows carry no messages.

## GET /api/v1/tickets/:id

The ticket object, its `last_customer_email`, and **one page of its conversation** — the customer's and the team's messages, never internal notes or system lines.

| Param | Type | Notes |
|---|---|---|
| `messages_limit` | integer (query) | Messages per page, default 100, max 200 (larger values are clamped) |
| `messages_before` | UUID (query) | Fetch an older page: pass the previous answer's `messages_next_before`. A message id that is not in this ticket's conversation → 400 `invalid_cursor` |

**Paging the conversation.** The first answer holds the **newest** messages; each page is ordered **oldest to newest**. While `messages_has_more` is `true`, call again with `messages_before` set to `messages_next_before` to get the page before it.

```bash
curl "https://app.otok.io/api/v1/tickets/5b1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5?messages_limit=20" \
  -H "Authorization: Bearer otok_live_abc123..."
```

Response `200`:

```json
{
  "id": "5b1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5",
  "number": 1042,
  "number_label": "T-1042",
  "subject": "Can't log in to the course",
  "status": "pending",
  "priority": "normal",
  "category": "Access",
  "source": "api",
  "language": "en",
  "widget_id": null,
  "external_reference": "helpdesk-88213",
  "contact": { "id": "9c2f1a4e-3b7d-4e2a-9f0c-1d2e3f4a5b6c", "name": "Jane Cohen", "email": "jane@example.com", "phone": "+972501234567" },
  "assignee": { "id": "708192a3-b4c5-d6e7-f809-1a2b3c4d5e6f", "name": "Dana Levi", "email": "dana@example.com" },
  "first_response_at": "2026-10-05T09:12:40.000Z",
  "response_target": null,
  "last_message_at": "2026-10-05T09:12:40.000Z",
  "resolved_at": null,
  "closed_at": null,
  "created_at": "2026-10-05T08:57:02.000Z",
  "updated_at": "2026-10-05T09:12:40.000Z",
  "last_customer_email": {
    "kind": "reply",
    "status": "delivered",
    "reason": null,
    "created_at": "2026-10-05T09:12:41.000Z",
    "sent_at": "2026-10-05T09:12:42.000Z",
    "bounced_at": null,
    "complained_at": null
  },
  "messages": [
    {
      "id": "1f2e3d4c-5b6a-4798-8a9b-0c1d2e3f4a5b",
      "side": "customer",
      "origin": "api",
      "author": null,
      "body": "I reset my password but the course page still says access denied.",
      "media_url": null,
      "media_filename": null,
      "media_mime_type": null,
      "media_size": null,
      "created_at": "2026-10-05T08:57:02.000Z"
    },
    {
      "id": "2a3b4c5d-6e7f-4809-9a1b-2c3d4e5f6a7b",
      "side": "team",
      "origin": "agent",
      "author": { "id": "708192a3-b4c5-d6e7-f809-1a2b3c4d5e6f", "name": "Dana Levi" },
      "body": "Thanks Jane — I've re-enabled your access. Please try again.",
      "media_url": null,
      "media_filename": null,
      "media_mime_type": null,
      "media_size": null,
      "created_at": "2026-10-05T09:12:40.000Z"
    }
  ],
  "messages_has_more": false,
  "messages_next_before": null
}
```

A ticket in another workspace → 404 `ticket_not_found`; a non-UUID id → 400.

## POST /api/v1/tickets — open a ticket

| Field | Type | Notes |
|---|---|---|
| `contact_id` | UUID | An existing contact. Mutually exclusive with `contact` |
| `contact` | object | `{ name, email, phone, national_id }` — upserted with the same identity resolution `POST /v1/contacts` uses (phone, then email, then national ID), so a customer who already exists never gets a second copy. At least one valid identifier is required. A contact this call creates is recorded as a ticket intake contact |
| `subject` | string | **Required**, ≤200 chars |
| `body` | string | **Required**, ≤10,000 chars. The customer's request — the ticket's opening message |
| `category` | string | One of the workspace's ticket categories (case-insensitive). Unknown → 400 `invalid_category` |
| `priority` | string | `low`, `normal` (default), `high`, `urgent` |
| `language` | `en` \| `he` | The customer's language for emails and auto-replies. Default: the contact's, else the workspace's |
| `opened_by` | `customer` \| `team` | Default `customer`. See below |
| `assigned_user_id` | UUID | Assign to this team member (who must be able to manage tickets). Skips routing |
| `assignee_email` | string | The same, by the member's login email. Mutually exclusive with `assigned_user_id` |
| `notify_customer` | boolean | Default `true`. `false` sends no creation email (for example when importing); every other rule still applies |
| `external_reference` | string | ≤200 chars. Your own key for this ticket, unique per workspace — see [idempotency](#idempotency) |

**`opened_by`.**

- **`customer`** (default) behaves like a ticket opened on the help page: the workspace's routing rules pick the assignee (unless you name one), the first-response target starts, the team gets its "new ticket" alert, the ticket can enter the inquiry queue (under an intake procedure that enables tickets), and a ticket from a **blocked** contact is filed silently into `spam` — no email, no alert, no webhook (the answer shows `status: "spam"`).
- **`team`** behaves like a ticket a team member logged on the customer's behalf: none of those.

Either way the opening message's `origin` is `api`, the ticket's `source` is `api`, and the [`ticket.created`](webhooks.md#ticket-events) webhook fires (except for spam).

```bash
curl -X POST "https://app.otok.io/api/v1/tickets" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{
        "contact": { "name": "Jane Cohen", "email": "jane@example.com" },
        "subject": "Can'\''t log in to the course",
        "body": "I reset my password but the course page still says access denied.",
        "category": "Access",
        "external_reference": "helpdesk-88213"
      }'
```

Response `201`: the ticket object with its first page of messages (`messages`, `messages_has_more`, `messages_next_before` — the same shape as `GET /v1/tickets/:id`) plus:

| Field | Notes |
|---|---|
| `duplicate` | `false` when this call opened the ticket; `true` on a replay (answered `200`) |
| `customer_email_skipped` | Present only when the creation email was due but will not go out — see [customer emails](#customer-emails) |

The answer leaves `last_customer_email` out: the creation email is sent just after the answer. Read the ticket again to see it.

### Idempotency

Send an `external_reference` and retries are safe. A call carrying a reference that already exists **changes nothing** — no contact is upserted, no email is sent — and answers the original ticket with `duplicate: true` and status `200`. The person the retry names must be the original ticket's contact (the same `contact_id`, or an inline `contact` that resolves to it); the same reference on a different contact is a caller bug and answers 409 `external_reference_conflict`. Find a ticket by your key with `GET /v1/tickets?external_reference=…`.

### Errors

| Status | Code | When |
|---|---|---|
| 400 | `contact_ambiguous` | Both `contact_id` and `contact` |
| 400 | `contact_required` | Neither, or a `contact` with no valid phone, email or national ID |
| 400 | `subject_required` / `body_required` | Blank once whitespace is trimmed |
| 400 | `assignee_ambiguous` | Both `assigned_user_id` and `assignee_email` |
| 400 | `invalid_assignee` | No active team member who can manage tickets matches |
| 400 | `invalid_category` | Not one of the workspace's ticket categories |
| 404 | `contact_not_found` | `contact_id` is not a contact of this workspace |
| 409 | `open_ticket_limit` | The workspace's limit on open tickets is reached — resolve or close some first |
| 409 | `external_reference_conflict` | The reference already names a ticket of another contact |
| 409 | `error_code: "CONTACT_MERGE_REQUIRED"` | The inline `contact`'s phone and email resolve to two different existing contacts |
| 409 | `error_code: "CONTACT_ANONYMISED"` | The contact was anonymised |

## POST /api/v1/tickets/:id/replies — reply to the customer

A real team reply. The ticket moves to **Answered** (`pending`) — from any status, `resolved` and `closed` included — its response target is met, `first_response_at` is stamped if this is the first answer, and the customer is emailed that the team replied (once per stretch of unread replies, like an in-app reply). The message's `origin` is `api`. Replies are text only.

| Field | Type | Notes |
|---|---|---|
| `body` | string | **Required**, ≤10,000 chars |
| `author_user_id` | UUID | Post as this team member (who must be able to manage tickets). Default: the team, with no named author |
| `author_email` | string | The same, by the member's login email. Mutually exclusive with `author_user_id` |
| `idempotency_key` | string | ≤200 chars. Makes retries safe — see below. Scoped to your API key |

```bash
curl -X POST "https://app.otok.io/api/v1/tickets/5b1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5/replies" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{"body":"Thanks Jane — your access is back. Please try again.","author_email":"dana@example.com","idempotency_key":"reply-88213-1"}'
```

Response `201`:

| Field | Notes |
|---|---|
| `message` | The posted [message](#the-message-object) |
| `ticket` | The [ticket object](#the-ticket-object) after the reply |
| `duplicate` | `false`, or `true` on a replay (answered `200`) |
| `customer_email_skipped` | Present only when the "team replied" email was due but will not go out — see [customer emails](#customer-emails) |

**Idempotency.** Re-sending the same `idempotency_key` with the same body to the same ticket posts nothing and answers the original reply with `duplicate: true` (`200`). The same key with a different body, or on another ticket, answers 409 `idempotency_key_mismatch`. Without a key, every call posts a new reply.

| Status | Code | When |
|---|---|---|
| 400 | `author_ambiguous` | Both `author_user_id` and `author_email` |
| 400 | `invalid_author` | No active team member who can manage tickets matches |
| 404 | `ticket_not_found` | Not a ticket of this workspace |
| 409 | `ticket_is_spam` | A ticket in spam takes no replies |
| 409 | `idempotency_key_mismatch` | The key was already used for a different reply |
| 409 | `error_code: "CONTACT_ANONYMISED"` | The ticket's contact was anonymised |

## PATCH /api/v1/tickets/:id — triage

Every field is optional; only what you send changes.

| Field | Type | Notes |
|---|---|---|
| `status` | string | `open`, `resolved` or `closed`. (`pending` comes only from a reply) |
| `priority` | string | `low`, `normal`, `high`, `urgent` |
| `category` | string or `null` | A ticket category; `null` clears it |
| `assigned_user_id` | UUID or `null` | Assign to this team member (who must be able to manage tickets); `null` unassigns |
| `assignee_email` | string | Assign by login email. Mutually exclusive with `assigned_user_id` |

```bash
curl -X PATCH "https://app.otok.io/api/v1/tickets/5b1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{"status":"resolved"}'
```

Response `200`: the ticket object, plus `customer_email_skipped` when a resolve made by this call was due to email the customer and that email will not go out. Resolving emails the customer when the workspace sends "resolved" emails; closing and every other change email no one.

| Status | Code | When |
|---|---|---|
| 400 | `assignee_ambiguous` | Both `assigned_user_id` and `assignee_email` |
| 400 | `invalid_assignee` | No active team member who can manage tickets matches |
| 400 | `invalid_category` | Not one of the workspace's ticket categories |
| 404 | `ticket_not_found` | Not a ticket of this workspace |
| 409 | `error_code: "CONTACT_ANONYMISED"` | The ticket's contact was anonymised |

---

## Customer emails

Ticket emails go to the customer **from the workspace's own verified sender only**, and count against the workspace's monthly email allowance. When an email a call triggers will not go out, the answer says why in `customer_email_skipped`:

| Value | Meaning |
|---|---|
| `no_verified_sender` | The workspace has no verified sender to send from |
| `over_quota` | The workspace's monthly email allowance is used up |
| `capped` | A daily limit on ticket emails (per ticket, or per customer address) drops it |

A skipped email is still recorded: `GET /v1/tickets/:id` shows it in `last_customer_email` with `status: "failed"` and the same `reason`. That field also reports emails that left but did not land — `bounced`, `complained`, `skipped_suppressed` (the address is on a suppression list, `reason: "suppressed"`) and other failures (`reason: "send_failed"`).

The ticket's other rules still apply: the customer is emailed a "team replied" message once per stretch of unread replies, and a "resolved" message only when the workspace has those emails switched on.

## Automations this fires

A ticket handled here is handled like any other: opening one fires the ticket-created automations (then the ticket-assigned ones when it lands on someone), assigning someone through PATCH fires the ticket-assigned automations, and a resolve fires the ticket-resolved ones. Every change also emits the matching [`ticket.*` webhook](webhooks.md#ticket-events).

## Related

- [Contacts](contacts.md) — the identity resolution the inline `contact` uses
- [Webhooks](webhooks.md#ticket-events) — `ticket.created`, `ticket.message_created`, `ticket.status_changed`, `ticket.assigned`
