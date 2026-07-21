# Newsletters

Smart newsletters are **sequences of email issues with per-subscriber catch-up**: caught-up subscribers receive each new issue when it is published, while new or behind subscribers drip through the back-issues at the newsletter's cadence until they are current. The API lets you list and create newsletters, author their issues (through the same [content contract](email-campaigns.md#the-content-contract) as email campaigns), and publish, schedule, or delete issues. Enrollment policy, catch-up cadence, tag auto-subscribe, header/footer chrome, and the public archive are managed in-app.

All endpoints require [authentication](getting-started.md#authentication). Issue creation is an **idempotent upsert** via `external_reference` — safe to retry blindly. Newsletters themselves cannot be deleted via the API; issues can, **but only while never published**.

> **Plan feature required:** every newsletters route requires the **Newsletters** feature (`newsletters`) on the workspace's plan, in addition to API access. Without it, all calls return `403` with `error_code: "FEATURE_NOT_INCLUDED_IN_PLAN"` — see [feature-gated resource groups](getting-started.md#feature-gated-resource-groups). Newsletter creation is additionally subject to the plan's newsletter cap (403 `error_code: "PLAN_LIMIT_EXCEEDED"` when reached).

Business-rule failures on these endpoints use the structured envelope `{"error": {"code", "message"}}` — key on `error.code` (see [error responses](getting-started.md#error-responses)). The full code vocabulary is [at the bottom of this page](#error-codes).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/newsletters` | List newsletters |
| POST | `/api/v1/newsletters` | Create a newsletter |
| GET | `/api/v1/newsletters/:id` | Get one newsletter |
| GET | `/api/v1/newsletters/:id/issues` | List a newsletter's issues |
| POST | `/api/v1/newsletters/:id/issues` | Create a draft issue (idempotent upsert) |
| GET | `/api/v1/newsletter-issues/:id` | Get one issue |
| PATCH | `/api/v1/newsletter-issues/:id` | Update an issue |
| DELETE | `/api/v1/newsletter-issues/:id` | Delete a never-published issue |
| POST | `/api/v1/newsletter-issues/:id/publish` | Publish an issue now |
| POST | `/api/v1/newsletter-issues/:id/schedule` | Schedule (or reschedule) a future publish |
| POST | `/api/v1/newsletter-issues/:id/unschedule` | Cancel a scheduled publish (back to draft) |

## Using the SDKs

The examples below show curl plus the official SDKs — [`@otok/node`](https://github.com/slikkdev/otok-api/tree/main/sdk/node) and the [`otok` Python package](https://github.com/slikkdev/otok-api/tree/main/sdk/python). Both expose the surface as `newsletters` (issue methods live on the same namespace):

```ts
import { OtokClient } from "@otok/node";

const otok = new OtokClient({ apiKey: process.env.OTOK_API_KEY! });
```

```python
import os

from otok import OtokClient

client = OtokClient(api_key=os.environ["OTOK_API_KEY"])
```

Non-2xx responses throw `OtokApiError` (Node) / raise `OtokAPIError` (Python) with `status`, `code` (from `error.code` or `error_code`), and the parsed `body`.

## The newsletter object

List rows and single reads both carry: `id`, `name`, `description`, `status` (`active` / `paused` / `archived`), `sender_profile_id` (`null` = the workspace default profile is used at send time), the computed **`active_subscriber_count`** (subscriptions currently in `active` status), `created_at`, `updated_at`.

`GET /v1/newsletters/:id` additionally returns the full stored configuration — enrollment policy (`start_policy`, `start_issue_number`, `first_send_mode`, `remember_window_days`), catch-up cadence (`catchup_interval_days`, `catchup_send_time`), tag auto-subscribe, header/footer snippet assignments, and public-archive settings (`archive_enabled`, `slug`, `archive_mode`). These are managed in-app and not exhaustively documented here.

## The issue object

Full issues include: `id`, `newsletter_id`, `issue_number`, `subject`, `preheader`, `status` (`draft` / `scheduled` / `published`), `design_json`, `compiled_html`, `compiled_styles`, `plain_text`, `scheduled_at`, `published_at`, `include_in_archive`, `external_reference`, `created_at`, `updated_at`.

- **`issue_number` is assigned at publish** (per-newsletter, monotonic) and stays `null` on drafts and scheduled issues — issue #N always means the Nth *published* issue. This is also why published issues can never be deleted: deleting one would free its number and corrupt subscriber catch-up cursors.
- **List rows omit the content columns** (`design_json`, `compiled_html`, `compiled_styles`, `plain_text`) — fetch a single issue to read them.
- `subject` and `preheader` may embed [`[[…]]` variable tokens](email-campaigns.md#variables), resolved per recipient.
- `include_in_archive` controls whether the issue appears in the newsletter's public archive (when the archive is enabled).

## Issue content

The `content` field on issue create/PATCH uses the **same shared contract as email campaigns** — an optional `direction` (`ltr` default / `rtl`) plus **exactly one** of:

- **`markdown`** — a CommonMark subset with the `::button[Label](https://url)` and `::snippet[name-or-uuid]` directive lines and `[[…]]` personalization tokens (with `: fallback` and `| modifier(arg)` support);
- **`blocks`** — a typed block array (`heading`, `paragraph`, `button`, `bullets`, `spacer`, `image`, `divider`, `snippet`);
- **`design_json`** — a raw editor document, for replaying content exported from the app.

Content compiles immediately; every write response carries a `compile: {ok, errors, warnings}` envelope. Total content is capped at 512,000 characters. Zero or two-plus sources → `400 invalid_content`; an unresolvable snippet reference → `400 unknown_snippet`.

See [the content contract](email-campaigns.md#the-content-contract) for the full grammar — including the markdown degradation rules, the block-kind field table, snippet resolution, compile errors vs warnings, and the `::button` URL-with-parenthesis limitation.

## GET /api/v1/newsletters

Newest first. Uses the stricter [deals/payments-style pagination](getting-started.md#where-deals-and-payments-differ): `limit` default 25, cap 100; malformed `limit`/`offset` → 400 (`"Invalid limit: must be a non-negative integer"`). No `filter`/`sort`/`search` parameters.

```bash
curl "https://app.otok.io/api/v1/newsletters?limit=25" \
  -H "Authorization: Bearer otok_live_abc123..."
```

```ts
const page = await otok.newsletters.list();

// Or iterate the whole collection (auto-pagination):
for await (const newsletter of otok.newsletters.iter()) {
  console.log(newsletter.name, newsletter.active_subscriber_count);
}
```

```python
page = client.newsletters.list()

# Or iterate the whole collection (auto-pagination):
for newsletter in client.newsletters.iter():
    print(newsletter["name"], newsletter["active_subscriber_count"])
```

Response `200` — `{ data, total, limit, offset }`; each row carries its computed `active_subscriber_count`.

## POST /api/v1/newsletters

A `name` alone suffices — cadence, enrollment policy, and archive settings take their in-app defaults (adjust them in the app).

### Request body

| Field | Type | Required | Constraints |
|---|---|---|---|
| `name` | string | yes | 1–120 chars; unique per workspace, case-insensitive (409 `duplicate_name`) |
| `description` | string | no | ≤2000 |
| `sender_profile_id` | UUID | no | Omit to fall back to the workspace default profile at send time. Unknown → 400 `sender_profile_not_found` |

```bash
curl -X POST "https://app.otok.io/api/v1/newsletters" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{ "name": "Product weekly", "description": "One product story a week." }'
```

```ts
const newsletter = await otok.newsletters.create({
  name: "Product weekly",
  description: "One product story a week.",
});
```

```python
newsletter = client.newsletters.create(
    {"name": "Product weekly", "description": "One product story a week."}
)
```

Response `201` — the created newsletter (`active_subscriber_count: 0`).

| Status | Meaning |
|---|---|
| 400 | Request-shape violations (standard body) or `error.code: sender_profile_not_found` |
| 403 | `error_code: "FEATURE_NOT_INCLUDED_IN_PLAN"` — plan lacks the Newsletters feature — or `error_code: "PLAN_LIMIT_EXCEEDED"` — the plan's newsletter cap is reached (`"Plan limit reached for max_newsletters (<n>). Please upgrade your plan to continue."`) |
| 409 | `error.code: duplicate_name` — `"A newsletter with this name already exists"` (case-insensitive) |

## GET /api/v1/newsletters/:id

```bash
curl "https://app.otok.io/api/v1/newsletters/6b5a4c3d-2e1f-4a09-b8c7-d6e5f4a3b2c1" \
  -H "Authorization: Bearer otok_live_abc123..."
```

```ts
const newsletter = await otok.newsletters.get("6b5a4c3d-2e1f-4a09-b8c7-d6e5f4a3b2c1");
```

```python
newsletter = client.newsletters.get("6b5a4c3d-2e1f-4a09-b8c7-d6e5f4a3b2c1")
```

Response `200` — the full stored newsletter plus its computed `active_subscriber_count`. `404 newsletter_not_found` for an unknown id; a non-UUID id → 400.

## GET /api/v1/newsletters/:id/issues

Newest first, same pagination as the newsletter list (default 25, cap 100, malformed → 400).

| Param | Notes |
|---|---|
| `status` | Exact status filter — `draft`, `scheduled`, or `published`. An unknown value returns 400 (`"Invalid status: must be draft, scheduled or published"`); an empty value (`?status=`) is treated as absent. |
| `limit` / `offset` | Default 25 / 0; `limit` cap 100. Malformed values → 400. |

```bash
curl -G "https://app.otok.io/api/v1/newsletters/6b5a4c3d-2e1f-4a09-b8c7-d6e5f4a3b2c1/issues" \
  -H "Authorization: Bearer otok_live_abc123..." \
  --data-urlencode 'status=published'
```

```ts
const page = await otok.newsletters.listIssues(newsletterId, { status: "published" });

for await (const issue of otok.newsletters.iterIssues(newsletterId)) {
  console.log(issue.issue_number, issue.subject);
}
```

```python
page = client.newsletters.list_issues(newsletter_id, {"status": "published"})

for issue in client.newsletters.iter_issues(newsletter_id):
    print(issue["issue_number"], issue["subject"])
```

Response `200` — `{ data, total, limit, offset }`. Rows omit the content columns (see [the issue object](#the-issue-object)). `404 newsletter_not_found` for an unknown newsletter id.

## POST /api/v1/newsletters/:id/issues

Creates a **draft** issue. All fields are optional — an issue can start as an empty placeholder (`{}` is a valid body) — but publishing or scheduling later requires a subject and compiled content.

### Request body

| Field | Type | Required | Constraints |
|---|---|---|---|
| `subject` | string | no | ≤400; may embed `[[…]]` variable tokens |
| `preheader` | string | no | ≤400 |
| `include_in_archive` | boolean | no | Default `true` |
| `external_reference` | string | no | ≤255 — [idempotency key](#issue-idempotency) |
| `content` | object | no | See [issue content](#issue-content); compiles immediately |

```bash
curl -X POST "https://app.otok.io/api/v1/newsletters/6b5a4c3d-2e1f-4a09-b8c7-d6e5f4a3b2c1/issues" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{
    "subject": "Issue: the July roadmap",
    "preheader": "Where we are headed next quarter",
    "external_reference": "blog-export-2026-07-20",
    "content": {
      "markdown": "# The July roadmap\n\nHi [[first_name : there]] — here is what we are building next.\n\n::button[Read online](https://example.com/roadmap)\n\n::snippet[Footer]"
    }
  }'
```

```ts
const result = await otok.newsletters.createIssue(newsletterId, {
  subject: "Issue: the July roadmap",
  preheader: "Where we are headed next quarter",
  external_reference: "blog-export-2026-07-20",
  content: {
    markdown:
      "# The July roadmap\n\nHi [[first_name : there]] — here is what we are building next.\n\n::button[Read online](https://example.com/roadmap)\n\n::snippet[Footer]",
  },
});
// result.duplicate — false on a fresh create, true on an external_reference match
// result.compile  — { ok, errors, warnings }
// result.issue_number — null until publish

// An empty placeholder draft:
const placeholder = await otok.newsletters.createIssue(newsletterId);
```

```python
result = client.newsletters.create_issue(
    newsletter_id,
    {
        "subject": "Issue: the July roadmap",
        "preheader": "Where we are headed next quarter",
        "external_reference": "blog-export-2026-07-20",
        "content": {
            "markdown": "# The July roadmap\n\n"
            "Hi [[first_name : there]] — here is what we are building next.\n\n"
            "::button[Read online](https://example.com/roadmap)\n\n"
            "::snippet[Footer]",
        },
    },
)
# result["duplicate"], result["compile"], result["issue_number"] (None until publish)

# An empty placeholder draft:
placeholder = client.newsletters.create_issue(newsletter_id)
```

Response `201` — the full issue (content columns included) plus `duplicate` and `compile`. `issue_number` is `null` until publish.

### Issue idempotency

When `external_reference` matches an existing issue in the workspace, the call **updates** that issue's content/fields instead of creating a new one and answers `duplicate: true` — a replay **never touches `status`, `scheduled_at`, or `issue_number`**, so re-running an export pipeline can refresh a draft's (or even a published issue's) content without re-publishing anything.

- The response is **201 in both cases**, and `duplicate` is always present on POST responses.
- One reference maps to one issue per workspace; a reference that already belongs to an issue of a **different** newsletter answers `409 external_reference_in_use`.
- This makes issue create safe to retry blindly on network failures — both SDKs auto-retry it.

### Errors

| Status | Meaning |
|---|---|
| 400 | Request-shape violations (standard body), `error.code: invalid_content`, or `error.code: unknown_snippet` (message lists the available snippet names) |
| 404 | `newsletter_not_found` |
| 409 | `external_reference_in_use` — `"external_reference already belongs to an issue of a different newsletter"` |

## GET /api/v1/newsletter-issues/:id

```bash
curl "https://app.otok.io/api/v1/newsletter-issues/8d7c6b5a-4e3f-4a21-9b0c-1d2e3f4a5b6c" \
  -H "Authorization: Bearer otok_live_abc123..."
```

```ts
const issue = await otok.newsletters.getIssue("8d7c6b5a-4e3f-4a21-9b0c-1d2e3f4a5b6c");
```

```python
issue = client.newsletters.get_issue("8d7c6b5a-4e3f-4a21-9b0c-1d2e3f4a5b6c")
```

Response `200` — the full issue, including `design_json`, `compiled_html`, `compiled_styles`, and `plain_text`. Plain reads carry no `compile` envelope. `404 issue_not_found` for an unknown id.

## PATCH /api/v1/newsletter-issues/:id

Only present fields are touched. `subject`/`preheader` clear on an explicit `null`; `include_in_archive` and `content` do not accept `null`.

- A `content` change **recompiles** (fresh `compile` envelope in the response).
- **Published issues stay editable** — a typo fix recompiles for future catch-up deliveries; already-delivered copies are naturally immutable.
- Content cannot be *cleared* through the API (`content: null` fails validation) — replace it with new content, or manage that in-app.

```bash
curl -X PATCH "https://app.otok.io/api/v1/newsletter-issues/8d7c6b5a-4e3f-4a21-9b0c-1d2e3f4a5b6c" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{ "subject": "Issue #12: the July roadmap", "include_in_archive": false }'
```

```ts
const result = await otok.newsletters.updateIssue(issueId, {
  subject: "Issue #12: the July roadmap",
  include_in_archive: false,
});
```

```python
result = client.newsletters.update_issue(
    issue_id, {"subject": "Issue #12: the July roadmap", "include_in_archive": False}
)
```

Response `200` — the updated issue with the `compile` envelope (`ok: true`, empty arrays when `content` was not part of the patch). No `duplicate` field on PATCH.

| Status | Meaning |
|---|---|
| 400 | Shape violations, `invalid_content`, or `unknown_snippet` |
| 404 | `issue_not_found` |

## DELETE /api/v1/newsletter-issues/:id

Deletes a **draft or scheduled** issue. Published issues can never be deleted — deleting one would free its issue number and corrupt subscriber catch-up cursors. Hide a published issue from the public archive with `include_in_archive: false` instead.

```bash
curl -X DELETE "https://app.otok.io/api/v1/newsletter-issues/8d7c6b5a-4e3f-4a21-9b0c-1d2e3f4a5b6c" \
  -H "Authorization: Bearer otok_live_abc123..."
```

```ts
await otok.newsletters.deleteIssue(issueId); // { success: true }
```

```python
client.newsletters.delete_issue(issue_id)  # {"success": True}
```

Response `200` — `{ "success": true }` (not 204).

| Status | `error.code` | Meaning |
|---|---|---|
| 400 | `issue_published` | `"Published issues cannot be deleted"` |
| 404 | `issue_not_found` | Unknown id |

## POST /api/v1/newsletter-issues/:id/publish

Publishes the issue **now**. No request body. Assigns the next `issue_number` (per-newsletter, monotonic) and wakes caught-up subscribers — delivery behaves exactly like an in-app publish: caught-up subscribers receive the issue on the next delivery sweep, while new or behind subscribers reach it through their catch-up drip.

Requires a subject and compiled content (`409 issue_missing_content` otherwise). **Idempotent** — publishing an already-published issue returns it as-is with a 200.

```bash
curl -X POST "https://app.otok.io/api/v1/newsletter-issues/8d7c6b5a-4e3f-4a21-9b0c-1d2e3f4a5b6c/publish" \
  -H "Authorization: Bearer otok_live_abc123..."
```

```ts
const issue = await otok.newsletters.publishIssue(issueId);
// issue.issue_number and issue.published_at are now set
```

```python
issue = client.newsletters.publish_issue(issue_id)
# issue["issue_number"] and issue["published_at"] are now set
```

Response `200` — the published issue, with its assigned `issue_number` and `published_at`.

| Status | `error.code` | Meaning |
|---|---|---|
| 404 | `issue_not_found` | Unknown id |
| 409 | `issue_missing_content` | `"An issue needs a subject and content before it can be published"` |

## POST /api/v1/newsletter-issues/:id/schedule

Schedules (or reschedules) a future publish. `scheduled_at` is an ISO 8601 UTC instant **in the future**; the every-minute sweep publishes the issue when due (same effects as `…/publish`). The subject + compiled-content requirement is asserted **up front**, so the sweep can't hit a content check failure later. Calling it again while still scheduled moves the publish time.

```bash
curl -X POST "https://app.otok.io/api/v1/newsletter-issues/8d7c6b5a-4e3f-4a21-9b0c-1d2e3f4a5b6c/schedule" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{ "scheduled_at": "2026-08-01T09:00:00Z" }'
```

```ts
const issue = await otok.newsletters.scheduleIssue(issueId, "2026-08-01T09:00:00Z");
```

```python
issue = client.newsletters.schedule_issue(issue_id, "2026-08-01T09:00:00Z")
```

Response `200` — the issue with `status: "scheduled"` and `scheduled_at` set.

| Status | `error.code` | Meaning |
|---|---|---|
| 400 | `invalid_scheduled_at` | `scheduled_at` parses but is not a future instant (a non-ISO-8601 value fails request validation with the standard body) |
| 404 | `issue_not_found` | Unknown id |
| 409 | `issue_already_published` | `"Issue is already published — published issues cannot be scheduled"` |
| 409 | `issue_missing_content` | No subject or no compiled content |

## POST /api/v1/newsletter-issues/:id/unschedule

Cancels a scheduled publish and returns the issue to `draft` (with `scheduled_at` cleared). No request body. Only currently scheduled issues can be unscheduled.

```bash
curl -X POST "https://app.otok.io/api/v1/newsletter-issues/8d7c6b5a-4e3f-4a21-9b0c-1d2e3f4a5b6c/unschedule" \
  -H "Authorization: Bearer otok_live_abc123..."
```

```ts
const issue = await otok.newsletters.unscheduleIssue(issueId);
```

```python
issue = client.newsletters.unschedule_issue(issue_id)
```

Response `200` — the issue, back in `draft`.

| Status | `error.code` | Meaning |
|---|---|---|
| 404 | `issue_not_found` | Unknown id |
| 409 | `issue_not_scheduled` | `"Issue status is 'draft' — only scheduled issues can be unscheduled"` |

## Lifecycle at a glance

```
draft ──publish──────────────▶ published  (issue_number assigned here)
  │ ▲                            ▲
  │ └──unschedule──┐             │  (sweep at scheduled_at)
  └──schedule──▶ scheduled ──────┘
```

- Publishing assigns the issue number and wakes caught-up subscribers; new/behind subscribers reach the issue through their catch-up drip.
- Published issues stay **editable** (PATCH recompiles for future deliveries) but can never be deleted, unscheduled, or re-scheduled.
- Typical export pipeline: **create issue (with `external_reference`) → check `compile` → publish** (or **schedule**). Re-running the pipeline refreshes content idempotently without re-publishing.

## Error codes

| Status | `error.code` | Returned by |
|---|---|---|
| 400 | `invalid_content` | issue create, issue PATCH — zero/two-plus content sources, malformed source, invalid `direction`, oversized content |
| 400 | `unknown_snippet` | issue create, issue PATCH — snippet reference matched nothing (message lists available names) |
| 400 | `sender_profile_not_found` | newsletter create |
| 400 | `invalid_scheduled_at` | issue schedule — parses but not a future instant |
| 400 | `issue_published` | issue DELETE — published issues cannot be deleted |
| 404 | `newsletter_not_found` | newsletter get, issue list/create |
| 404 | `issue_not_found` | every `/v1/newsletter-issues/:id` route |
| 409 | `duplicate_name` | newsletter create — name already exists (case-insensitive) |
| 409 | `external_reference_in_use` | issue create — reference belongs to an issue of a different newsletter |
| 409 | `issue_missing_content` | issue publish, issue schedule — no subject or no compiled content |
| 409 | `issue_already_published` | issue schedule |
| 409 | `issue_not_scheduled` | issue unschedule |

Framework-shape errors: the plan-gate 403 `error_code: "FEATURE_NOT_INCLUDED_IN_PLAN"` and the newsletter-cap 403 `error_code: "PLAN_LIMIT_EXCEEDED"`.

## Related

- [Email Campaigns](email-campaigns.md) — one-off broadcasts through the same content contract; the full [content-contract reference](email-campaigns.md#the-content-contract) lives there
- [Consent & Suppressions](consent-and-suppressions.md) — the per-channel consent + suppression layers issue delivery respects
