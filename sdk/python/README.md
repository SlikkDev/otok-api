# otok (Python)

Official Python SDK for the [oToK](https://github.com/SlikkDev/otok-api) marketing platform public API (`/v1`).

Gives bespoke websites and e-commerce stores out-of-the-box integration with oToK: contact upserts, sales deals, transactional email, WhatsApp templates, campaigns, payments, bookings — plus signed-webhook verification and a high-level e-commerce layer that is safe to retry by design.

- **Python 3.9+**, zero runtime dependencies (stdlib `urllib` behind an injectable transport)
- Full type hints (`py.typed`) derived from the real API contract
- Automatic retries with exponential backoff + jitter on `429`/`5xx` (honors `Retry-After`), plus transient network errors for requests that are safe to replay
- Auto-paginating generators (`for contact in client.contacts.iter(): ...`)
- Constant-time webhook signature verification

## Install

```bash
pip install otok
```

## Quickstart

Create an API key in **Settings → Developers → API keys** in your oToK workspace (keys look like `otok_live_…` and are shown once). All requests go to the oToK API at `https://app.otok.io/api`.

```python
import os

from otok import OtokClient

client = OtokClient(api_key=os.environ["OTOK_API_KEY"])
```

### Upsert a contact

`POST /v1/contacts` upserts by phone (canonicalized to E.164), falling back to email. `tags` and `groups` are **names** — missing ones are created automatically, and on upsert they are *added* (never removed).

```python
contact = client.contacts.upsert(
    {
        "email": "jane@example.com",
        "phone": "+12025551234",
        "first_name": "Jane",
        "last_name": "Doe",
        "tags": ["VIP", "Newsletter"],
        "custom_fields": {"plan": "gold"},
    }
)
# contact["duplicate"]: True when an existing contact was matched and
# updated, False on a fresh create (the status is 201 either way).
```

### Iterate a whole collection (auto-pagination)

Every paginated list endpoint has a matching `iter()` that returns a generator: it accepts the same filter/sort/search params as `list()` and fetches pages lazily until the collection is exhausted.

```python
for contact in client.contacts.iter({"filter": {"lifecycle_stage": "customer"}}):
    print(contact["email"])
```

Pages are requested at each endpoint's **documented `limit` cap** — 500 for the standard lists (contacts, tags, contact groups, campaigns, templates, meeting types, bookings), 100 for deals and payments, which paginate differently. Pass a smaller `limit` to override the page size (a larger one is clamped to the cap); `offset` sets the starting position:

```python
for deal in client.deals.iter({"status": "open", "limit": 50}):
    ...  # pages of 50 through GET /v1/deals
```

### Contact notes

Plain-text annotations on a contact (API note payloads are text only — rich text and mentions are in-app features). `list_notes` returns a bare list (the endpoint is unpaginated), pinned notes first, then newest-first.

```python
note = client.contacts.create_note(contact["id"], "Asked for a demo next week", pinned=True)
client.contacts.update_note(note["id"], body="Demo booked for Tuesday", pinned=False)
notes = client.contacts.list_notes(contact["id"])
client.contacts.delete_note(note["id"])  # -> {"success": True}
```

### Create a deal from an order (idempotent)

`external_reference` maps one order to one deal — a repeat `POST` with the same reference updates that deal instead of creating a duplicate, so retries are always safe. The response's `duplicate` field tells you which happened (`True` = an existing deal was matched; the status is 201 either way).

```python
pipelines = client.pipelines.list()  # map stage ids once

deal = client.deals.create(
    {
        "email": "jane@example.com",           # contact matched or created
        "title": "Order A-1001",
        "amount": 249.9,
        "currency": "USD",
        "external_reference": "order:A-1001",  # <- idempotency key
    }
)

# Later: mark it won when the order is fulfilled
client.deals.set_status(deal["id"], {"status": "won"})
```

Or use the high-level e-commerce layer, which does the contact upsert + idempotent deal (+ optional receipt email) in one call:

```python
result = client.commerce.track_order(
    {
        "order_id": "A-1001",
        "customer": {"email": "jane@example.com", "name": "Jane Doe", "tags": ["Customer"]},
        "total": 249.9,
        "currency": "USD",
        "receipt": {"subject": "Your order A-1001", "html": "<p>Thanks for your order!</p>"},
    }
)
result.contact, result.deal, result.receipt
```

`track_order` is safe to call from at-least-once webhook handlers (e.g. a store's `order.created` event): replays converge on the same contact, deal (`order:<id>`), and receipt (`order:<id>:receipt` email idempotency key).

### Send a transactional email

Content passes through verbatim — no footer, tracking, or `List-Unsubscribe` injection unless you opt in. The `idempotency_key` is required; a repeat call returns the original send (`duplicate: true`) and never sends twice.

```python
result = client.emails.send(
    {
        "to": "jane@example.com",
        "subject": "Your password reset link",
        "html": '<p>Click <a href="https://shop.example.com/reset">here</a>.</p>',
        "idempotency_key": "pwreset:user-42:2026-07-14",
        "tracking": {"opens": True, "clicks": True},  # optional, default off
        "metadata": {"user_id": "42"},                # echoed in webhook events
    }
)
# result["status"]: "sent" | "suppressed"; result["duplicate"]: bool
```

### Receive delivery webhooks

Register an endpoint (max 3 per workspace). The `whsec_…` signing secret is returned **once** — store it.

```python
endpoint = client.webhook_endpoints.create(
    {
        "url": "https://shop.example.com/api/otok-events",
        # Defaults to the three delivery events; engagement events are opt-in:
        "events": [
            "email.delivered",
            "email.bounced",
            "email.complained",
            "email.opened",
            "email.clicked",
        ],
    }
)
print(endpoint["secret"])  # whsec_… — shown only now
```

> `email.failed` is **deprecated**: it is still accepted at registration (existing integrations keep working), but it never fires — a failing `POST /v1/emails` fails synchronously on the request itself, so handle send failures from that response.

Events are POSTed with an `X-Otok-Signature: t=<unix>,v1=<hex>` header (HMAC-SHA256 of `"{t}.{body}"` with your secret). Failed deliveries retry for ≈16 hours. **Always verify against the raw request body** — parsing and re-serializing changes the bytes.

#### Flask

```python
import os

from flask import Flask, request

from otok import OtokWebhookVerificationError, construct_event

app = Flask(__name__)

@app.post("/api/otok-events")
def otok_events():
    try:
        event = construct_event(
            request.get_data(),  # raw body — keep the exact bytes!
            request.headers.get("X-Otok-Signature"),
            os.environ["OTOK_WEBHOOK_SECRET"],
        )
    except OtokWebhookVerificationError:
        return "bad signature", 400
    if event["type"] == "email.bounced":
        print("bounced:", event["data"]["to"], event["data"].get("bounce_type"))
    elif event["type"] == "email.clicked":
        print("clicked:", event["data"]["url"])
    return "ok", 200  # 2xx stops retries; dedupe on event["id"]
```

#### FastAPI

```python
import os

from fastapi import FastAPI, Request, Response

from otok import OtokWebhookVerificationError, construct_event

app = FastAPI()

@app.post("/api/otok-events")
async def otok_events(request: Request) -> Response:
    raw_body = await request.body()  # raw bytes — do not parse first
    try:
        event = construct_event(
            raw_body,
            request.headers.get("x-otok-signature"),
            os.environ["OTOK_WEBHOOK_SECRET"],
        )
    except OtokWebhookVerificationError:
        return Response(content="bad signature", status_code=400)
    # ...handle event...
    return Response(content="ok", status_code=200)
```

#### Django

```python
import os

from django.http import HttpResponse
from django.views.decorators.csrf import csrf_exempt

from otok import OtokWebhookVerificationError, construct_event

@csrf_exempt  # webhooks carry no CSRF token — the HMAC signature authenticates
def otok_events(request):
    try:
        event = construct_event(
            request.body,  # raw bytes — do not parse first
            request.headers.get("X-Otok-Signature"),
            os.environ["OTOK_WEBHOOK_SECRET"],
        )
    except OtokWebhookVerificationError:
        return HttpResponse("bad signature", status=400)
    # ...handle event...
    return HttpResponse("ok", status=200)
```

You can also call `verify_webhook_signature(payload, header, secret, tolerance_seconds=300)` directly when you only need a boolean (default timestamp tolerance: 5 minutes).

## API coverage

| Namespace | Endpoints |
|---|---|
| `client.contacts` | `GET/POST /v1/contacts`, `GET/PATCH /v1/contacts/:id` (POST = upsert by phone/email); notes: `GET/POST /v1/contacts/:id/notes`, `PATCH/DELETE /v1/notes/:id` |
| `client.tags` | `GET/POST /v1/tags`, `GET/PATCH /v1/tags/:id` |
| `client.contact_groups` | `GET/POST /v1/contact-groups`, `GET/PATCH /v1/contact-groups/:id` |
| `client.pipelines` | `GET /v1/pipelines` (with ordered stages) |
| `client.deals` | `GET/POST /v1/deals`, `GET/PATCH /v1/deals/:id`, `POST /v1/deals/:id/stage`, `POST /v1/deals/:id/status` |
| `client.emails` | `POST /v1/emails` (transactional, idempotent) |
| `client.campaigns` | `GET/POST /v1/campaigns`, `GET/PATCH /v1/campaigns/:id`, `POST /v1/campaigns/:id/execute` |
| `client.templates` | `GET /v1/templates`, `GET /v1/templates/:id`, `POST /v1/templates/:id/send` (WhatsApp) |
| `client.payments` | `GET/POST /v1/payments`, `GET/PATCH /v1/payments/:id`, `POST …/cancel`, `POST …/entries/:entryId/mark`, `POST …/refund` |
| `client.meeting_types` | `GET /v1/meeting-types`, `GET /v1/meeting-types/:id`, `GET /v1/meeting-types/:id/slots` |
| `client.bookings` | `GET/POST /v1/bookings`, `GET /v1/bookings/:id`, `POST …/cancel`, `POST …/reschedule`, `POST …/reassign` |
| `client.webhook_endpoints` | `GET/POST /v1/webhook-endpoints`, `DELETE /v1/webhook-endpoints/:id` |
| `client.commerce` | High-level: `identify_customer(customer)`, `track_order(order)` |

Request/response field names match the wire contract (snake_case) exactly, so the interactive API reference at `https://app.otok.io/api/v1/docs` applies 1:1. The `commerce` layer accepts friendlier flat dicts and maps them for you.

Every namespace with a paginated `list()` (contacts, tags, contact groups, deals, campaigns, templates, payments, meeting types, bookings) also has an auto-paginating `iter()` — see [Iterate a whole collection](#iterate-a-whole-collection-auto-pagination).

## Errors, timeouts, retries

- Non-2xx responses raise **`OtokAPIError`** with `status`, `code` (machine-readable, when present), and the parsed `body`. `code` comes from the `{"error": {"code", "message"}}` envelope (e.g. `endpoint_not_found`, `SLOT_TAKEN`, `campaign_not_found`, `campaign_not_scheduled`) or from a top-level `error_code` field (e.g. `FEATURE_NOT_INCLUDED_IN_PLAN`, `CONTACT_MERGE_REQUIRED`). Key your handling on `status` + `code`, never on the message text.
- **Plan-feature gating (403):** the endpoint groups that mirror plan-gated product areas — deals + pipelines (Deals), payments (Payments), campaigns (Campaigns), bookings + meeting types (Booking) — answer every call with a `403` with `err.code == "FEATURE_NOT_INCLUDED_IN_PLAN"` when the workspace's plan lacks the feature. Contacts, tags, contact groups, templates, notes, emails, and webhook endpoints are not feature-gated.
- **Invalid `filter` values (400):** list-endpoint `filter` values are type-checked against the target field — a mistyped date/UUID/enum/number/boolean returns a `400` with a descriptive message (e.g. `Invalid filter value for "created_at": "not-a-date" is not a date`) instead of a server error.
- **Duplicate names (409):** creating or renaming a tag / contact group to a name that already exists in the workspace (case-insensitive) returns a `409` (`A tag with this name already exists`).
- **Contact identity conflicts (409):** `PATCH /v1/contacts/:id` now behaves like `POST /v1/contacts` when a `phone`/`email` change collides with an identifier another contact holds (or previously held): the write is **not** applied — a merge request is parked for review in oToK and the `409` raises with `err.code == "CONTACT_MERGE_REQUIRED"`; its `merge_request_id` is on `err.body`. Non-identity fields sent in the same PATCH are held on the merge request and applied when it is resolved.
- **Campaign execute uses real status codes:** `POST /v1/campaigns/:id/execute` answers `200` with `{"success": true, …}` when queued, and raises `OtokAPIError` otherwise — `404` (`code == "campaign_not_found"`) or `409` (`code == "campaign_not_scheduled"`; campaigns created without an explicit `status` default to `draft`, so set `status: "scheduled"` before executing). It no longer answers 201 with `success: false` in the body.
- Slow requests raise **`OtokTimeoutError`** — with the default urllib transport the `timeout` option (default 30 s) bounds each socket operation (connect, each read) rather than a whole attempt's wall-clock time.
- Redirects are never followed: a 3xx comes back as an `OtokAPIError`, so the bearer API key is never re-sent to a redirect target.
- `429` and `5xx` responses are retried up to `max_retries` times (default 2) with exponential backoff + full jitter, honoring the `Retry-After` header (both delta-seconds and HTTP-date forms). This applies to **all** requests: the server answered, so the retry semantics are unchanged from v0.1.
- **Transient network errors are retried too — but only when replaying is safe.** Connection resets/refusals (`ConnectionError`), DNS failures (`socket.gaierror`), socket timeouts (`TimeoutError`, and the SDK's own `OtokTimeoutError`) — raised directly or wrapped in a `urllib.error.URLError` — share the same bounded backoff schedule (`max_retries`, exponential + full jitter) **if and only if** the request is:
  - a **safe method** (`GET`/`HEAD`), or
  - a **write carrying its own idempotency key**: a body with a non-empty `idempotency_key` (`client.emails.send`) or `external_reference` (`client.deals.create`, `client.payments.create`).

  Any other write (contact upserts, tag/group/campaign writes, bookings, stage moves, ...) is **never** network-retried — a network error is ambiguous (the request may have reached the server), so the error is raised for you to handle. To make such flows retry-safe, use the idempotent surfaces (`external_reference`, `idempotency_key`, `client.commerce.track_order`) or retry at the call site.
- Rate limits are enforced per API key (default 100 requests/min; `POST /v1/emails` allows 300/min).

```python
from otok import OtokAPIError

try:
    client.bookings.create({...})
except OtokAPIError as err:
    if err.code == "SLOT_TAKEN":
        ...  # offer another slot
    elif err.code == "FEATURE_NOT_INCLUDED_IN_PLAN":
        ...  # the workspace's plan lacks the Booking feature
    else:
        raise
```

## Examples

Runnable scripts live in [`examples/`](./examples):

- [`track_order.py`](./examples/track_order.py) — contact upsert + idempotent deal + receipt for a store order
- [`export_contacts.py`](./examples/export_contacts.py) — stream every contact to CSV with the auto-paginating iterator
- [`flask_webhook_receiver.py`](./examples/flask_webhook_receiver.py) — verified webhook receiver (Flask)
- [`fastapi_webhook_receiver.py`](./examples/fastapi_webhook_receiver.py) — verified webhook receiver (FastAPI)
- [`django_webhook_receiver.py`](./examples/django_webhook_receiver.py) — verified webhook receiver (Django, single file)

## Development

```bash
pip install -e ".[dev]"
pytest
ruff check .
mypy
```

## Versioning & scope (v0.2)

Covered: the e-commerce path end to end (contacts + notes, tags/groups, pipelines/deals, transactional email + webhooks, payments), plus campaigns, WhatsApp templates, bookings, auto-paginating iterators on every list endpoint, and bounded retries for transient network errors on safe/idempotency-keyed requests. Sync client only; not covered yet: an async client and list-endpoint `$where` advanced filter helpers — planned for a later release.

New in v0.2.0:

- `iter()` generators on all paginated list endpoints, honoring each resource's documented page-size cap (500 standard; 100 for deals/payments)
- Transient network errors (connection reset/refused, DNS failure, socket timeout) now retry with the existing bounded backoff — GET/HEAD and idempotency-keyed writes only; other writes still surface the error immediately
