# Email Campaigns

Author, target, estimate, launch, and schedule **broadcast email campaigns**. Content is written through a shared authoring contract (markdown, typed blocks, or a raw editor document — see [the content contract](#the-content-contract)) and **compiles at write time**: every write response carries a `compile: {ok, errors, warnings}` envelope, so rendering problems surface when you create the campaign, not when it launches. Launch and schedule ride the exact in-app launch gates (sender readiness, content compile, content lint).

All endpoints require [authentication](getting-started.md#authentication). Campaign creation is an **idempotent upsert** via `external_reference` — safe to retry blindly. Campaigns cannot be deleted via the API.

> **Plan feature required:** every email-campaigns route requires the **Email marketing** feature (`email_marketing`) on the workspace's plan, in addition to API access. Without it, all calls return `403` with `error_code: "FEATURE_NOT_INCLUDED_IN_PLAN"` — see [feature-gated resource groups](getting-started.md#feature-gated-resource-groups).

Business-rule failures on these endpoints use the structured envelope `{"error": {"code", "message"}}` — key on `error.code` (see [error responses](getting-started.md#error-responses)). The full code vocabulary is [at the bottom of this page](#error-codes).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/email-campaigns` | List campaigns |
| POST | `/api/v1/email-campaigns` | Create a draft campaign (idempotent upsert) |
| GET | `/api/v1/email-campaigns/:id` | Get one campaign |
| PATCH | `/api/v1/email-campaigns/:id` | Update a draft/scheduled campaign |
| GET | `/api/v1/email-campaigns/:id/estimate` | Estimate the audience size |
| POST | `/api/v1/email-campaigns/:id/send` | Launch now |
| POST | `/api/v1/email-campaigns/:id/schedule` | Schedule (or reschedule) a future launch |
| POST | `/api/v1/email-campaigns/:id/unschedule` | Cancel a scheduled launch (back to draft) |

A/B testing is deliberately not exposed on the public API — create A/B campaigns in-app.

## Using the SDKs

The examples below show curl plus the official SDKs — [`@otok/node`](https://github.com/slikkdev/otok-api/tree/main/sdk/node) and the [`otok` Python package](https://github.com/slikkdev/otok-api/tree/main/sdk/python). Both expose the surface as `emailCampaigns` / `email_campaigns`:

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

## The campaign object

Full campaigns include: `id`, `name`, `status`, `sender_profile_id`, `subject`, `preheader`, `direction`, `topic_key`, `contact_group_ids`, `audience_id`, `audience_filters`, `template_id`, `design_json`, `compiled_html`, `compiled_styles`, `plain_text`, `scheduled_at`, `timezone`, `started_at`, `completed_at`, the delivery counters (`total_recipients`, `sent_count`, `delivered_count`, `open_count`, `click_count`, `bounce_count`, `complaint_count`, `unsubscribe_count`, `failed_count`, `skipped_count`, `pending_retry_count`), `external_reference`, `created_at`, `updated_at`.

- **Status** is one of `draft`, `scheduled`, `sending`, `paused`, `sent`, `failed`, `cancelled`. The API mutates only `draft`/`scheduled` campaigns; everything from the launch claim onward is system-managed.
- **`subject` / `preheader`** are read and written under exactly those names — a GET → tweak → PATCH round-trip echoes cleanly. Both may embed [`[[…]]` variable tokens](#variables), resolved per recipient.
- **List rows omit the content columns** (`template_id`, `design_json`, `compiled_html`, `compiled_styles`, `plain_text`) — fetch a single campaign to read them. Delivery counters *are* included on list rows.
- `skipped_count` counts terminal-but-not-failed recipients (suppression/eligibility skips).
- In-app-only fields (A/B configuration and results, warming state) may appear on single reads but are not part of the documented contract.

## The content contract

The `content` field on create/PATCH is the shared authoring contract used by both email campaigns and [newsletter issues](newsletters.md): an optional `direction` plus **exactly one** of `markdown`, `blocks`, or `design_json`.

```json
{ "direction": "ltr", "markdown": "# Hello [[first_name : there]]!\n\nWelcome to our July update.\n\n::button[Read the full story](https://example.com/blog/july)" }
```

- **Exactly one source.** Zero or two-plus of `markdown`/`blocks`/`design_json` returns `400 invalid_content`.
- **`direction`** — `ltr` (default) or `rtl` (right-to-left languages). Any other value returns `400 invalid_content`.
- Whichever source you send is converted to the same internal email document the in-app editor produces and **compiled immediately** — the write response's [`compile` envelope](#compile-feedback) reports errors and warnings up front, not at send time.
- **Size cap:** total content is capped at **512,000 characters** (measured on the source and again on the built document). An oversized body returns `400 invalid_content`.

### Markdown

`markdown` accepts a CommonMark subset, converted block-by-block:

- **Headings** `#`–`###` (deeper levels clamp to level 3 with a warning).
- **Paragraphs** with `**bold**`, `*italic*`, `~~strikethrough~~`, `` `code` ``, and `[links](https://example.com)`. Link and button URLs must be absolute `http(s)` — anything else is replaced with a safe placeholder.
- **Bullet and numbered lists** (nesting supported), `> blockquotes`, and `---` horizontal dividers.
- **Images** on their own line: `![alt](https://…)` — the URL must be absolute `https` (otherwise the image is dropped with a warning). An image inside a paragraph degrades to its alt text with a warning.
- **Raw HTML is never passed through** — tags are stripped to their text content with a warning. Fenced code blocks degrade to a code-styled paragraph.

Two **directive lines** (each on its own line) extend the grammar:

- `::button[Label](https://url)` — a real call-to-action button block, themed with the workspace's primary color. A directive without a label is dropped with a warning.
- `::snippet[name-or-uuid]` — splices a workspace [snippet](#snippets). An unknown reference returns `400 unknown_snippet`.

Any other `::directive` is kept as literal paragraph text with a warning (fail-visible, never silent).

> **Known limitation — `)` in a `::button` URL.** Directives are matched line-wise and the URL part of `::button[…](…)` cannot contain a literal closing parenthesis. A line like `::button[Read](https://en.wikipedia.org/wiki/API_(disambiguation))` does not parse as a button — the whole line degrades to literal paragraph text with an `Unsupported directive "::button" was kept as literal text` warning in the compile envelope. Percent-encode parentheses (`%28`/`%29`) or author that button via the [`blocks`](#blocks) source, which has no such restriction.

### Variables

Any `[[…]]` token in text becomes a personalization pill resolved per recipient at send time. The grammar:

```
[[path]]
[[path : fallback]]
[[path | modifier(arg) : fallback]]
```

- **`path`** is a contact field — `first_name`, `email`, custom field keys, or the explicit `contact.` prefix.
- The optional **`fallback`** renders when the value is empty: `Hi [[first_name : there]]!`.
- The optional **modifier** formats the value — text (`upper`, `lower`, `capitalize`, `title`, `first_word`, `truncate(n)`), formatting (`number(decimals)`, `date(format)`), math (`plus(n)`, `minus(n)`, `times(n)`, `divided_by(n)`, `round(decimals)`).

Tokens work in all three content sources, and also inside the campaign `subject` and `preheader`.

### Blocks

`blocks` is a typed block array for callers that prefer structure over text — each item is one block, rendered in order. `kind` selects the shape; the other fields apply per kind. An unknown `kind` or a mistyped field returns `400 invalid_content`. Text fields (`text`, `items` entries, button `label`) may embed `[[…]]` variable tokens.

| `kind` | Fields | Notes |
|---|---|---|
| `heading` | `text`, `level` | `level` 1–3 (out of range clamps; omitted → 2). Empty text drops the block. |
| `paragraph` | `text` | Empty text drops the block. |
| `button` | `label`, `url` | Themed CTA button. A button without a label is dropped. Non-http(s) URLs are replaced with a safe placeholder. |
| `bullets` | `items` | Bullet list; empty items are skipped. |
| `spacer` | — | Fixed vertical spacing. |
| `image` | `url`, `alt` | `url` must be absolute `https` — otherwise `400 invalid_content`. |
| `divider` | — | Horizontal rule. |
| `snippet` | `id` **or** `name` | Splices a workspace snippet (`id` wins when both are sent). Neither → `400 invalid_content`; no match → `400 unknown_snippet`. |

```json
{
  "blocks": [
    { "kind": "heading", "text": "Big news, [[first_name : friend]]!", "level": 1 },
    { "kind": "paragraph", "text": "We just shipped **three** features you asked for." },
    { "kind": "button", "label": "See what's new", "url": "https://example.com/changelog" },
    { "kind": "snippet", "name": "Footer" }
  ]
}
```

### design_json (advanced)

`design_json` is a raw editor document — the native design JSON the in-app email editor submits — passed through as-is after a structural sanity check (it must be an object with a string `type` and an array `content`). Use it to replay a document exported from the app (e.g. the `design_json` returned by a GET of an issue or campaign that was authored in-app); authoring from scratch is easier with `markdown` or `blocks`.

### Snippets

Snippets are reusable content blocks from the workspace library (managed in the app under **Settings → Snippets**). Reference one by UUID or by **case-insensitive exact name** — via the `::snippet[…]` markdown directive or a `snippet` block. A reference that matches no workspace snippet returns `400 unknown_snippet`, with the available snippet names listed in the message.

The stored document keeps the *reference*, but the two surfaces resolve it at different moments: **email campaigns** re-expand snippet references at launch, so a snippet edited after the campaign was written still reaches the send; **newsletter issues** bake snippet content into the compiled document at save — re-save the issue (PATCH, or an `external_reference` create replay) to pick up later snippet edits.

### Compile feedback

Every campaign/issue **write** response (create, PATCH, and idempotent replays that updated the record — never plain GETs) carries:

```json
{ "compile": { "ok": true, "errors": [], "warnings": ["Headings deeper than level 3 were clamped to level 3"] } }
```

- **`errors`** are render problems you should fix before sending.
- **`warnings`** are lossy-but-accepted conversions — stripped raw HTML, a dropped non-https image, clamped heading levels, an unknown `::directive` kept as text, a label-less button dropped.
- `ok` is `true` when `errors` is empty. A write with no `content` in the payload reports `ok: true` with empty arrays.

The content compiles at write time through the same pipeline the send path uses, so a clean compile here means the launch gate's compile step will pass too.

## GET /api/v1/email-campaigns

Newest first. Uses dedicated query parameters (no `filter`/`sort`/`search`) and the stricter [deals/payments-style pagination](getting-started.md#where-deals-and-payments-differ): `limit` default 25, cap 100; malformed `limit`/`offset` → 400.

| Param | Notes |
|---|---|
| `status` | Exact status filter — one of `draft`, `scheduled`, `sending`, `paused`, `sent`, `failed`, `cancelled`. An unknown value returns 400 (`"Invalid status: must be one of draft, scheduled, sending, paused, sent, failed, cancelled"`); an empty value (`?status=`) is treated as absent. |
| `limit` / `offset` | Default 25 / 0; `limit` cap 100. Malformed values → 400 `"Invalid limit: must be a non-negative integer"`. |

```bash
curl -G "https://app.otok.io/api/v1/email-campaigns" \
  -H "Authorization: Bearer otok_live_abc123..." \
  --data-urlencode 'status=scheduled'
```

```ts
const page = await otok.emailCampaigns.list({ status: "scheduled" });

// Or iterate the whole collection (auto-pagination):
for await (const campaign of otok.emailCampaigns.iter()) {
  console.log(campaign.name, campaign.status);
}
```

```python
page = client.email_campaigns.list({"status": "scheduled"})

# Or iterate the whole collection (auto-pagination):
for campaign in client.email_campaigns.iter():
    print(campaign["name"], campaign["status"])
```

Response `200` — `{ data, total, limit, offset }`. Rows omit the content columns (see [the campaign object](#the-campaign-object)).

## POST /api/v1/email-campaigns

Creates a **draft** campaign. It does not send until you call [`…/send`](#post-apiv1email-campaignsidsend) or [`…/schedule`](#post-apiv1email-campaignsidschedule).

### Request body

| Field | Type | Required | Constraints |
|---|---|---|---|
| `name` | string | yes | 1–200 chars |
| `subject` | string | yes | 1–400; may embed `[[…]]` variable tokens |
| `sender_profile_id` | UUID | yes | A sender profile in this workspace (unknown → 400 `sender_profile_not_found`). Send-readiness — verified domain + legal footer fields — is asserted at launch, not here |
| `content` | object | yes | See [the content contract](#the-content-contract) |
| `preheader` | string | no | ≤400 — the inbox preview line rendered after the subject |
| `external_reference` | string | no | ≤255 — [idempotency key](#idempotency) |
| `audience_id` | UUID | no | A saved audience; wins over `audience_filters`. Must belong to your workspace (404 `"Audience not found"` otherwise) |
| `audience_filters` | object | no | An ad-hoc `$where` condition tree (same grammar as the contacts `filter` `$where`); validated structurally and test-compiled at write time. Ignored when `audience_id` is set |
| `contact_group_ids` | UUID[] | no | Additional contact-group targeting (OR semantics among the groups), narrowing the audience |
| `topic_key` | string | no | ≤200 — preference-center topic key; contacts who opted out of it are excluded |

Targeting is optional. At send time the audience can only **narrow** the built-in email send-eligibility baseline (opted in, not suppressed) — never widen it. **With no targeting at all, the campaign goes to every eligible contact** — check [`…/estimate`](#get-apiv1email-campaignsidestimate) before sending.

### Example

```bash
curl -X POST "https://app.otok.io/api/v1/email-campaigns" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{
    "name": "July product update",
    "subject": "Big news, [[first_name : there]]!",
    "preheader": "Three features you asked for",
    "sender_profile_id": "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9",
    "external_reference": "july-2026-update",
    "audience_id": "9c2f1a4e-3b7d-4e2a-9f0c-1d2e3f4a5b6c",
    "content": {
      "direction": "ltr",
      "markdown": "# Hello [[first_name : there]]!\n\nWe just shipped **three** features you asked for.\n\n::button[See what'\''s new](https://example.com/changelog)\n\n::snippet[Footer]"
    }
  }'
```

```ts
const result = await otok.emailCampaigns.create({
  name: "July product update",
  subject: "Big news, [[first_name : there]]!",
  preheader: "Three features you asked for",
  sender_profile_id: "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9",
  external_reference: "july-2026-update",
  audience_id: "9c2f1a4e-3b7d-4e2a-9f0c-1d2e3f4a5b6c",
  content: {
    direction: "ltr",
    markdown:
      "# Hello [[first_name : there]]!\n\nWe just shipped **three** features you asked for.\n\n::button[See what's new](https://example.com/changelog)\n\n::snippet[Footer]",
  },
});
// result.duplicate — false on a fresh create, true on an external_reference match
// result.compile  — { ok, errors, warnings }
```

```python
result = client.email_campaigns.create(
    {
        "name": "July product update",
        "subject": "Big news, [[first_name : there]]!",
        "preheader": "Three features you asked for",
        "sender_profile_id": "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9",
        "external_reference": "july-2026-update",
        "audience_id": "9c2f1a4e-3b7d-4e2a-9f0c-1d2e3f4a5b6c",
        "content": {
            "direction": "ltr",
            "markdown": "# Hello [[first_name : there]]!\n\n"
            "We just shipped **three** features you asked for.\n\n"
            "::button[See what's new](https://example.com/changelog)\n\n"
            "::snippet[Footer]",
        },
    }
)
# result["duplicate"], result["compile"]
```

Response `201` — the full campaign object plus `duplicate` and (except on a post-launch replay) `compile`:

```json
{
  "id": "3f9a1e2b-7c4d-4e5f-8a9b-0c1d2e3f4a5b",
  "name": "July product update",
  "status": "draft",
  "subject": "Big news, [[first_name : there]]!",
  "preheader": "Three features you asked for",
  "sender_profile_id": "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9",
  "audience_id": "9c2f1a4e-3b7d-4e2a-9f0c-1d2e3f4a5b6c",
  "scheduled_at": null,
  "external_reference": "july-2026-update",
  "duplicate": false,
  "compile": { "ok": true, "errors": [], "warnings": [] }
}
```

(Trimmed — the real response carries every [campaign field](#the-campaign-object), including `design_json` and the compiled content columns.)

### Idempotency

When `external_reference` matches an existing campaign in the workspace, the response carries `duplicate: true` and:

- **While the campaign is still `draft`/`scheduled`**, the call **updates** its fields exactly as a PATCH would — never `status` or `scheduled_at` — and returns a fresh `compile` envelope.
- **Once the launch has claimed it** (`sending`/`sent`/`failed`/…), the campaign is returned **verbatim** — nothing is mutated, nothing is recompiled, and the response carries **no `compile` envelope**.

The response is **201 in both cases**, and `duplicate` is always present on POST responses. One reference maps to one campaign per workspace. This makes create safe to retry blindly on network failures — both SDKs auto-retry it.

### Errors

| Status | Shape | Meaning |
|---|---|---|
| 400 | standard validation body | Request-shape violations: unknown fields, bad types, over-length values |
| 400 | standard, with `errors` array | `"Invalid audience_filters definition"` — the condition tree failed validation/test-compile |
| 400 | `error.code: invalid_content` | Zero or two-plus content sources, malformed markdown/blocks/design_json, an invalid `direction`, or oversized content |
| 400 | `error.code: unknown_snippet` | A `::snippet[…]` reference or `snippet` block matched no workspace snippet — the message lists the available names |
| 400 | `error.code: sender_profile_not_found` | `sender_profile_id` not found in this workspace |
| 403 | `error_code: FEATURE_NOT_INCLUDED_IN_PLAN` | Plan lacks the `email_marketing` feature |
| 404 | standard body | `"Audience not found"` — `audience_id` not in this workspace |

## GET /api/v1/email-campaigns/:id

```bash
curl "https://app.otok.io/api/v1/email-campaigns/3f9a1e2b-7c4d-4e5f-8a9b-0c1d2e3f4a5b" \
  -H "Authorization: Bearer otok_live_abc123..."
```

```ts
const campaign = await otok.emailCampaigns.get("3f9a1e2b-7c4d-4e5f-8a9b-0c1d2e3f4a5b");
```

```python
campaign = client.email_campaigns.get("3f9a1e2b-7c4d-4e5f-8a9b-0c1d2e3f4a5b")
```

Response `200` — the full campaign, including `design_json`, the compiled content columns, and the delivery counters. Plain reads carry no `compile` envelope. `404 campaign_not_found` for an unknown id; a non-UUID id → 400.

## PATCH /api/v1/email-campaigns/:id

Draft/scheduled campaigns only. Same field set as create **minus `external_reference`**, all optional — only present fields are touched.

- The nullable fields (`subject`, `preheader`, `audience_id`, `audience_filters`, `contact_group_ids`, `topic_key`) clear on an explicit `null`; `name`, `sender_profile_id`, and `content` do not accept `null`.
- A `content` change **recompiles** (the response carries a fresh `compile` envelope) and **detaches any in-app template** the campaign referenced (`template_id` → `null`) — the patched content is what sends.
- PATCH never touches `status` or `scheduled_at` — a scheduled campaign stays scheduled; use [`…/schedule`](#post-apiv1email-campaignsidschedule) to move the launch time.

```bash
curl -X PATCH "https://app.otok.io/api/v1/email-campaigns/3f9a1e2b-7c4d-4e5f-8a9b-0c1d2e3f4a5b" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{ "subject": "One more thing, [[first_name : there]]…", "topic_key": null }'
```

```ts
const result = await otok.emailCampaigns.update(campaignId, {
  subject: "One more thing, [[first_name : there]]…",
  topic_key: null,
});
```

```python
result = client.email_campaigns.update(
    campaign_id, {"subject": "One more thing, [[first_name : there]]…", "topic_key": None}
)
```

Response `200` — the updated campaign with the `compile` envelope (`ok: true`, empty arrays when `content` was not part of the patch). No `duplicate` field on PATCH.

| Status | Meaning |
|---|---|
| 400 | As in create (`invalid_content`, `unknown_snippet`, `sender_profile_not_found`, `"Invalid audience_filters definition"`, shape violations) |
| 404 | `campaign_not_found` — or `"Audience not found"` (standard shape) for a patched `audience_id` not in this workspace |
| 409 | `campaign_not_editable` — the campaign is no longer draft/scheduled (`"Campaign status is 'sent' — only draft or scheduled campaigns can be edited"`) |

## GET /api/v1/email-campaigns/:id/estimate

Runs the campaign's **stored** targeting through the same resolver pipeline the send path uses — the email consent + suppression baseline, then the saved audience or ad-hoc filters, contact-group narrowing, and `topic_key` opt-outs — so the estimate always matches send-time resolution (minus recipients already claimed mid-flight). Update targeting first (PATCH), then re-estimate.

```bash
curl "https://app.otok.io/api/v1/email-campaigns/3f9a1e2b-7c4d-4e5f-8a9b-0c1d2e3f4a5b/estimate" \
  -H "Authorization: Bearer otok_live_abc123..."
```

```ts
const { estimated_recipients } = await otok.emailCampaigns.estimate(campaignId);
```

```python
estimate = client.email_campaigns.estimate(campaign_id)
# estimate["estimated_recipients"]
```

Response `200`:

```json
{ "estimated_recipients": 1284 }
```

`404 campaign_not_found` for an unknown id.

## POST /api/v1/email-campaigns/:id/send

Launches the campaign **now**. Draft/scheduled campaigns only; no request body. The launch runs **synchronously through the exact in-app launch gates** — sender readiness (verified domain + legal footer fields), inline content compile, and the content lint.

```bash
curl -X POST "https://app.otok.io/api/v1/email-campaigns/3f9a1e2b-7c4d-4e5f-8a9b-0c1d2e3f4a5b/send" \
  -H "Authorization: Bearer otok_live_abc123..."
```

```ts
const campaign = await otok.emailCampaigns.send(campaignId);
// campaign.status — typically "sending"; poll get() for counter progress
```

```python
campaign = client.email_campaigns.send(campaign_id)
# campaign["status"] — typically "sending"; poll get() for counter progress
```

Response `200` — the campaign with its post-launch status (typically `sending`; poll `GET /v1/email-campaigns/:id` for counter progress).

| Status | `error.code` | Meaning |
|---|---|---|
| 404 | `campaign_not_found` | Unknown id |
| 409 | `campaign_not_sendable` | `"Campaign status is '<status>' — only draft or scheduled campaigns can be sent"` |
| 422 | `launch_failed` | A launch gate rejected the campaign — see below |

### 422 `launch_failed`

A gate failure answers **422** with the gate's message, and the error object additionally carries **`campaign_status`** — the campaign's final status after the gate ran (the gate marks the campaign `failed` as a side effect, so this tells you where it landed):

```json
{
  "error": {
    "code": "launch_failed",
    "message": "Sender profile's domain is not verified",
    "campaign_status": "failed"
  }
}
```

```ts
import { OtokApiError } from "@otok/node";

try {
  await otok.emailCampaigns.send(campaignId);
} catch (err) {
  if (err instanceof OtokApiError && err.code === "launch_failed") {
    const { message, campaign_status } = (err.body as any).error;
    console.error(`Launch failed (${campaign_status}): ${message}`);
  }
}
```

```python
from otok import OtokAPIError

try:
    client.email_campaigns.send(campaign_id)
except OtokAPIError as err:
    if err.code == "launch_failed":
        detail = err.body["error"]
        print(f"Launch failed ({detail['campaign_status']}): {detail['message']}")
```

Note that a campaign the gate marked `failed` is **no longer draft/scheduled**, so API PATCH/send are closed on it (`campaign_not_editable` / `campaign_not_sendable`), and a create replayed with its `external_reference` returns it verbatim. Fix the underlying workspace problem (verify the sending domain, complete the sender profile's footer fields in the app), then create a fresh campaign under a **new** `external_reference` — or manage the failed row in-app.

## POST /api/v1/email-campaigns/:id/schedule

Schedules (or reschedules) a future launch. Draft/scheduled campaigns only. `scheduled_at` is an ISO 8601 UTC instant **in the future**; the every-minute sweep launches the campaign when due, running the same launch gates as `…/send`. Calling it again while still scheduled moves the launch time.

```bash
curl -X POST "https://app.otok.io/api/v1/email-campaigns/3f9a1e2b-7c4d-4e5f-8a9b-0c1d2e3f4a5b/schedule" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{ "scheduled_at": "2026-08-01T09:00:00Z" }'
```

```ts
const campaign = await otok.emailCampaigns.schedule(campaignId, "2026-08-01T09:00:00Z");
```

```python
campaign = client.email_campaigns.schedule(campaign_id, "2026-08-01T09:00:00Z")
```

Response `200` — the campaign with `status: "scheduled"` and `scheduled_at` set.

| Status | Meaning |
|---|---|
| 400 | `invalid_scheduled_at` (domain envelope) — `scheduled_at` parses but is not a future instant; a value that is not ISO 8601 at all fails request validation with the standard body |
| 404 | `campaign_not_found` |
| 409 | `campaign_not_schedulable` — the campaign is not draft/scheduled |

## POST /api/v1/email-campaigns/:id/unschedule

Cancels a scheduled launch and returns the campaign to `draft` (with `scheduled_at` cleared). No request body. Conditional on status `scheduled` — when the minute sweep has already claimed the campaign for sending, the call answers `409 already_sending` rather than silently no-opping, so you know the sends are going out.

```bash
curl -X POST "https://app.otok.io/api/v1/email-campaigns/3f9a1e2b-7c4d-4e5f-8a9b-0c1d2e3f4a5b/unschedule" \
  -H "Authorization: Bearer otok_live_abc123..."
```

```ts
const campaign = await otok.emailCampaigns.unschedule(campaignId);
```

```python
campaign = client.email_campaigns.unschedule(campaign_id)
```

Response `200` — the campaign, back in `draft`.

| Status | `error.code` | Meaning |
|---|---|---|
| 404 | `campaign_not_found` | Unknown id |
| 409 | `already_sending` | The send sweep already claimed this campaign — it is sending |
| 409 | `campaign_not_scheduled` | `"Campaign status is 'draft' — only scheduled campaigns can be unscheduled"` |

## Lifecycle at a glance

```
draft ──send──────────────▶ sending ──▶ sent
  │ ▲                          ▲
  │ └──unschedule──┐           │  (sweep at scheduled_at, gates pass)
  └──schedule──▶ scheduled ────┘
                                  (a gate failure marks the campaign failed)
```

- The API mutates `draft` and `scheduled` campaigns only. `sending`, `paused`, `sent`, `failed`, and `cancelled` are system-managed.
- Both `send` and the scheduled sweep run the same launch gates; a clean write-time `compile` means the gate's compile step will pass, but sender readiness and the content lint are only asserted at launch.
- Typical flow: **create → estimate → send** (or **schedule**), then poll `GET /v1/email-campaigns/:id` for the delivery counters.

## Error codes

| Status | `error.code` | Returned by |
|---|---|---|
| 400 | `invalid_content` | create, PATCH — zero/two-plus content sources, malformed source, invalid `direction`, oversized content |
| 400 | `unknown_snippet` | create, PATCH — snippet reference matched nothing (message lists available names) |
| 400 | `sender_profile_not_found` | create, PATCH |
| 400 | `invalid_scheduled_at` | schedule — parses but not a future instant |
| 404 | `campaign_not_found` | every `/:id` route |
| 409 | `campaign_not_editable` | PATCH — no longer draft/scheduled |
| 409 | `campaign_not_sendable` | send — no longer draft/scheduled |
| 409 | `campaign_not_schedulable` | schedule — no longer draft/scheduled |
| 409 | `campaign_not_scheduled` | unschedule — not currently scheduled |
| 409 | `already_sending` | unschedule — the send sweep already claimed the campaign |
| 422 | `launch_failed` | send — a launch gate rejected the campaign; carries `error.campaign_status` |

Framework-shape errors: 400 `"Invalid audience_filters definition"` (with an `errors` array), 404 `"Audience not found"`, and the plan-gate 403 `error_code: "FEATURE_NOT_INCLUDED_IN_PLAN"`.

## Related

- [Newsletters](newsletters.md) — sequenced issues authored through the same content contract
- [Consent & Suppressions](consent-and-suppressions.md) — the per-channel consent + suppression layers the send baseline enforces
- [Transactional Emails](emails.md) — single raw sends (`POST /v1/emails`)
