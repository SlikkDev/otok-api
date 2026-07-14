# Templates (WhatsApp)

Read your workspace's WhatsApp message templates and send a template message to a phone number. Template creation, editing, and deletion are managed in the oToK app — the API surface is deliberately read-and-send only.

All endpoints require [authentication](getting-started.md#authentication). Standard [list conventions](getting-started.md#list-conventions) apply to the list route.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/templates` | List templates |
| GET | `/api/v1/templates/:id` | Get one template |
| POST | `/api/v1/templates/:id/send` | Send a template message |

## The template object

Template rows include: `id`, `name`, `display_name`, `category`, `language`, `status`, `header_type`, `header_text`, `body_text`, `body_variables_examples`, `footer_text`, `buttons`, `meta_template_id`, `rejection_reason`, `created_at`, `updated_at`. Only templates with an approved `status` can be delivered by WhatsApp.

## GET /api/v1/templates

```bash
curl -G "https://app.otok.io/api/v1/templates" \
  -H "Authorization: Bearer otok_live_abc123..." \
  --data-urlencode 'filter={"status":"approved"}'
```

Response `200` — `{ data, total, limit, offset }` with full template rows.

| Status | Meaning |
|---|---|
| 400 | Invalid `filter` / `limit` / `offset` |

## GET /api/v1/templates/:id

Response `200` — a full template row. `404` — `"messageTemplates with ID <id> not found"`. Non-UUID id → 400.

## POST /api/v1/templates/:id/send

Sends the template to a phone number. The template must belong to your workspace (`404` otherwise). The recipient contact is matched by normalized phone — **created automatically if it doesn't exist** — and the sent message is recorded in the Inbox conversation.

### Request body

| Field | Type | Required | Constraints |
|---|---|---|---|
| `to` | string | yes | Recipient phone, international format (e.g. `+972501234567`) |
| `body_variables` | array | no | Values for the template's body placeholders. Shape: `[{ "type": "text", "text": "...", "param_name": "..." }]` — `param_name` matches named placeholders; otherwise values apply by position |
| `header_config` | object | no | `{ "type": "text", "variables": ["..."] }` for text headers, or `{ "type": "media", "media_type": "image"|"video"|"document", "media_link": "https://..." }` for media headers |
| `button_configs` | array | no | `[{ "type": "...", "index": 0, "parameters": ["..."] }]` — values for dynamic buttons (e.g. dynamic-URL suffixes) |

The nested shapes of `body_variables` / `header_config` / `button_configs` are validated when the message is built — malformed inner content surfaces as a 400 with a descriptive message (or a 502 if it is only rejected by the WhatsApp provider).

### Example

```bash
curl -X POST "https://app.otok.io/api/v1/templates/1f2e3d4c-5b6a-7980-a1b2-c3d4e5f60718/send" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{
    "to": "+972501234567",
    "body_variables": [
      { "type": "text", "text": "Dana", "param_name": "name" },
      { "type": "text", "text": "July 20" }
    ],
    "header_config": { "type": "media", "media_type": "image", "media_link": "https://example.com/banner.jpg" }
  }'
```

Response `201`:

```json
{
  "success": true,
  "wamid": "wamid.HBgLOTcyNTAxMjM0NTY3FQIAERgSNzdBRjA1RkYxMkI0QzhGOUEA",
  "message_id": "8a7b6c5d-4e3f-2a1b-0c9d-8e7f6a5b4c3d",
  "conversation_id": "0d9c8b7a-6f5e-4d3c-2b1a-09f8e7d6c5b4"
}
```

- `wamid` — WhatsApp's message id.
- `message_id` / `conversation_id` — the persisted oToK inbox records for the sent message and its conversation.

### Errors

| Status | Message | Meaning |
|---|---|---|
| 400 | `"Cannot send WhatsApp template — missing required field(s): …"` | The template requires variables/config you didn't supply |
| 400 | `Invalid header media_type "<x>". Must be one of: image, video, document` | Bad `header_config.media_type` |
| 403 | `"This contact is blocked"` | The resolved contact is blocked in this workspace |
| 403 | `"This phone number is on the blacklist and cannot be messaged"` | Blacklist rule matches the recipient number |
| 404 | `"messageTemplates with ID <id> not found"` | Template not in this workspace |
| 404 | `"No connected WhatsApp instance found"` | No active WhatsApp connection to send from |
| 502 | `{ "message": "<provider error>", "message_id": "...", "conversation_id": "..." }` | WhatsApp/Meta refused the send. **The failed message row is persisted** — `message_id`/`conversation_id` are included so you can retry or inspect it in the Inbox |

### Side effects

A successful send writes the message and conversation to the Inbox (status progresses pending → sent → delivered/read via WhatsApp receipts), counts toward the workspace's monthly message usage, and — when workspace link tracking is enabled — decorates links in the message with tracking parameters.
