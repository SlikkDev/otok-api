# Payment Requests

Hosted **pay-by-link** requests collected through the workspace's own connected payment provider (Cardcom or Sumit). Minting a request returns a shareable `pay_url`; the payer completes checkout on the hosted page, the payment is verified with the provider, recorded on the contact's [payments](payments.md) ledger, and an Israeli tax document is auto-issued (configurable). Lifecycle changes fire the opt-in [`payment_request.*` webhooks](webhooks.md#payment-request-events).

All endpoints require [authentication](getting-started.md#authentication). Payment requests cannot be deleted, and there is no PATCH — a mistaken link is [cancelled](#post-apiv1payment-requestsidcancel) and a new one minted.

To charge a contact's **saved card** directly (no pay-link), see [saved cards and charges](contacts.md#saved-cards-and-charges).

> **Plan feature required:** every route on this page requires the **Workspace payments** feature (`workspace_payments`) on the workspace's plan, in addition to API access. This is a **different feature** from the `payments` ledger gate on `/v1/payments*` — a workspace can hold either without the other. Without it, all calls return `403` with `error_code: "FEATURE_NOT_INCLUDED_IN_PLAN"` (the message embeds `workspace_payments`) — see [feature-gated resource groups](getting-started.md#feature-gated-resource-groups). Minting additionally requires a **connected provider** (Cardcom or Sumit in Settings → Integrations) — otherwise 400 `NO_PAYMENT_PROVIDER`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/payment-requests` | List payment requests (filterable, paginated) |
| GET | `/api/v1/payment-requests/:id` | Get one payment request |
| POST | `/api/v1/payment-requests` | Create a payment request (mint a pay-link) — idempotent only with `idempotency_key` |
| POST | `/api/v1/payment-requests/:id/cancel` | Cancel a pending payment request |
| POST | `/api/v1/payment-requests/:id/send-link` | Send the pay-link to the contact by email, WhatsApp or SMS |
| POST | `/api/v1/payment-requests/:id/document` | Issue the tax document for a paid request |
| POST | `/api/v1/payment-requests/:id/refund` | Refund a paid request (full or partial) |

> **Send `idempotency_key` on every create.** Idempotency on `POST /v1/payment-requests` is **opt-in**: with an `idempotency_key`, a repeat POST — including a blind retry after a network failure — returns the original link with `duplicate: true` and mints nothing. **Without one**, a repeat POST mints a **second, independently payable link**, and both links can be paid; if a keyless create's outcome is uncertain, check `GET /v1/payment-requests` (filter by `contact_id`/`deal_id`) before minting again, and cancel extras via the cancel endpoint.

## The payment request object

Status lifecycle: **`pending` → `paid` | `expired` | `cancelled`**. Money serializes as JSON numbers.

Main fields:

| Field | Type | Notes |
|---|---|---|
| `id` | UUID | |
| `workspace_id` | UUID | |
| `contact_id` | UUID or `null` | The payer contact (`null` only after the contact was deleted) |
| `deal_id` | UUID or `null` | The [deal](deals.md) the request is bound to, when minted for one |
| `sale_id` | UUID or `null` | The [sale](sales.md) this link collects for — the one named at mint, or the sale recorded when a product link is paid |
| `provider` | enum | `cardcom` / `sumit` — the connected provider the money moves through |
| `status` | enum | `pending`, `paid`, `expired`, `cancelled` |
| `charge_kind` | enum | `checkout` = hosted pay-link (what this route mints). `token` rows are direct saved-card charges — made [through the API](contacts.md#post-apiv1contactsidcharges), in the app, or by recurring-plan charging — they appear in list/get with `pay_url: null`, cannot be cancelled or sent, and never emit webhooks. (Save-card-only links sent from the app carry no amount and never appear on `/v1` at all — list, get and every action answer as if they did not exist) |
| `amount` / `currency` | number / enum | Amount to collect; `ILS`, `USD`, `EUR`, `GBP` |
| `title` / `note` | string or `null` | Payer-facing title; internal note |
| `max_installments` | integer or `null` | Max card installments offered on the hosted page |
| `auto_issue_document` / `document_kind` | boolean / enum or `null` | Tax-document auto-issue on successful charge; kind `null` = provider default |
| `public_token` | string | The high-entropy `pr_…` token — the last segment of `pay_url`. Treat it as the payer's secret |
| `provider_checkout_ref` / `provider_payment_ref` / `provider_customer_ref` | string or `null` | Provider-side correlation references |
| `test_mode` | boolean | Authorise-only test run — never records real money; expires within 1 hour |
| `vat_mode` / `vat_rate` | enum / number, or `null`s | The resolved VAT posture stamped at mint (request override → workspace default); checkout, document, and any refund credit-document all price with it |
| `reminders_enabled` / `reminder_count` / `last_reminder_at` | | Pre-expiry reminders |
| `channel` | enum or `null` | The **first** channel the link was delivered on by oToK — `email`, `whatsapp` or `sms`; `null` when it was never sent (e.g. you shared `pay_url` yourself) |
| `link_emailed_at` / `link_whatsapp_sent_at` / `link_sms_sent_at` | ISO 8601 or `null` | When the link was first sent on each channel |
| `payment_method_id` | UUID or `null` | On `token` rows: the [saved card](contacts.md#get-apiv1contactsidpayment-methods) that was charged |
| `expires_at` | ISO 8601 or `null` | Link deadline (clamped at mint — see below) |
| `paid_at` / `cancelled_at` | ISO 8601 or `null` | |
| `contact_payment_id` | UUID or `null` | The [`/v1/payments`](payments.md) ledger row a verified payment landed on — set once paid |
| `metadata` | object or `null` | System-managed (issued `document` pointer, checkout diagnostics) — **not writable** via this API |
| `created_by` | UUID or `null` | `null` for API mints |
| `created_at` / `updated_at` | ISO 8601 | |

Computed fields:

- **`pay_url`** — the shareable hosted pay-page URL (`https://app.otok.io/pay/<public_token>`). Present on create/get/list; `null` on `token` rows; the **cancel** response is the bare row without computed fields.
- **`document`** — the issued tax-document pointer `{ provider, id, number, type, url }` once paid (get/list); `null` while unpaid.
- **Create only:** `checkout_url` / `checkout_error` — see [create](#post-apiv1payment-requests) — and `duplicate`.
- **List rows only:** joined `contact_name` / `contact_phone` / `contact_email`, plus `refunded_total` (total already refunded against this request's settled charge).

## GET /api/v1/payment-requests

Dedicated query parameters with the deals/payments pagination family — see [where deals and payments differ](getting-started.md#where-deals-and-payments-differ). Ordered by `created_at` descending.

| Param | Type | Notes |
|---|---|---|
| `status` | enum | `pending`, `paid`, `expired`, `cancelled` — **unknown values return 400** (`"Invalid status: must be one of pending, paid, expired, cancelled"`), unlike deals/payments where they are ignored |
| `contact_id` | UUID | Malformed → 400 `"Invalid contact_id: must be a UUID"`; empty treated as absent |
| `deal_id` | UUID | Same validation |
| `limit` | integer | Default **25**, cap 100. Absent or empty defaults; malformed → 400 `"Invalid limit: must be a non-negative integer"` |
| `offset` | integer | Default 0, min 0. Malformed → 400 |

```bash
curl -G "https://app.otok.io/api/v1/payment-requests" \
  -H "Authorization: Bearer otok_live_abc123..." \
  --data-urlencode 'status=pending'
```

Response `200` — `{ data, total, limit, offset }`.

## GET /api/v1/payment-requests/:id

Response `200` — the request with `pay_url` and (once paid) `document`. `404` — `"Payment request not found"`. Non-UUID id → 400.

## POST /api/v1/payment-requests

Mints a hosted-checkout pay-link and returns the row with its shareable `pay_url`. Idempotent only with `idempotency_key` — see the note at the top of this page.

### Request body

| Field | Type | Required | Constraints |
|---|---|---|---|
| `contact_id` | UUID | one of `contact_id` OR `phone`/`email` OR `deal_id` | Existing contact — the payer |
| `phone` | string | ″ | ≤32 chars; a matching contact is used, or created |
| `email` | string | ″ | Valid email; a matching contact is used, or created |
| `name` | string | no | ≤200 — used only for a newly created contact |
| `deal_id` | UUID | ″ | Deal to bind the request to. With no contact given, the deal's contact pays |
| `amount` | number | **yes** | 0.01 – 9,999,999,999.99, ≤2 decimals — major units |
| `currency` | enum | no | `ILS`, `USD`, `EUR`, `GBP`. Omitted → the workspace payment currency |
| `title` | string | no | ≤200 — payer-facing charge title |
| `note` | string | no | ≤2000 |
| `max_installments` | integer | no | 1 – 36 — max card installments offered on the hosted page |
| `document_kind` | enum | no | Tax-document kind to auto-issue: `tax_invoice`, `tax_invoice_receipt`, `receipt`, `receipt_for_invoice`, `proforma_invoice`, `donation_receipt`, `credit_invoice`, `credit_invoice_receipt`, `credit_receipt`, `credit_donation_receipt`, `order`, `price_quote`, `delivery_note`, `payment_demand`. Omitted → the provider/account default |
| `auto_issue_document` | boolean | no | Auto-issue an Israeli tax document on successful charge (default `true`) |
| `expires_at` | string | no | ISO 8601. **Clamped server-side** to at most 72 hours from now (1 hour for test-mode requests); omitted → the maximum |
| `test_mode` | boolean | no | Authorise-only test run — rejected (400) when the connected provider has no test mode. Test requests never record real money |
| `reminders_enabled` | boolean | no | Pre-expiry reminder emails for this request; omitted → the workspace default |
| `offer_card_save` | boolean | no | Offer the payer a save-my-card checkbox on the pay page — honored only when the connected provider supports card capture at checkout |
| `vat_mode` | enum | no | `inclusive`, `exclusive` — per-request VAT override, always **together** with `vat_rate` (a lone leg → 400). Omitted → the workspace payments default. VAT-exempt = `exclusive` + rate 0 |
| `vat_rate` | number | no | 0 – 100, ≤2 decimals — always together with `vat_mode` |
| `terminal_number` | integer | no | Cardcom only — see [choosing a payment terminal](#choosing-a-payment-terminal) |
| `product_id` | UUID | no | Catalog [product](products.md) this link sells. The payer-facing title derives from the product name, and paying the link records a [sale](sales.md) for the product (when the workspace records sales). Must be an active product (400 `INVALID_PRODUCT` / `PRODUCT_INACTIVE`) |
| `sale_id` | UUID | no | Collect for an **existing** [sale](sales.md) of the same contact: the charge this link settles is allocated to that sale, capped at what it can still take (any remainder stays unallocated) |
| `idempotency_key` | string | no | ≤200, unique per workspace — see [idempotency](#idempotency) |

### Idempotency

With `idempotency_key`, the first POST mints the link and every replay of the **same charge** returns that original row with `duplicate: true` — no second link is minted and the provider is not contacted again. "The same charge" means the same payer contact, `amount`, `currency`, `sale_id` and `product_id`; reusing a key for anything else answers 409 `IDEMPOTENCY_KEY_MISMATCH`. Two concurrent requests with the same key: one wins, the other may briefly answer 409 `IDEMPOTENCY_CLAIM_IN_FLIGHT` — retry it after a moment and it replays. A replay's `checkout_url` / `checkout_error` are `null`; share `pay_url`.

Without a key, `duplicate` is always `false`.

### Contact resolution

Like [payments](payments.md#contact-and-product-resolution): `contact_id` wins; otherwise `phone`/`email` are upserted like `POST /v1/contacts` (with the same **409 `CONTACT_MERGE_REQUIRED`** behavior); a `deal_id` **alone** is also valid — the deal's contact pays. None of the four → 400 `"Provide contact_id, a phone/email to resolve the payer contact, or a deal_id"`.

### Example

```bash
curl -X POST "https://app.otok.io/api/v1/payment-requests" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{
    "phone": "+972501234567",
    "name": "Dana Levi",
    "amount": 250,
    "currency": "ILS",
    "title": "Onboarding session",
    "expires_at": "2026-07-18T09:00:00Z"
  }'
```

Response `201` (abridged):

```json
{
  "id": "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0",
  "contact_id": "9c2f1a4e-3b7d-4e2a-9f0c-1d2e3f4a5b6c",
  "deal_id": null,
  "provider": "sumit",
  "status": "pending",
  "charge_kind": "checkout",
  "amount": 250,
  "currency": "ILS",
  "title": "Onboarding session",
  "vat_mode": "inclusive",
  "vat_rate": 18,
  "test_mode": false,
  "expires_at": "2026-07-18T09:00:00.000Z",
  "public_token": "pr_k3J9…",
  "pay_url": "https://app.otok.io/pay/pr_k3J9…",
  "checkout_url": "https://…provider-checkout…",
  "checkout_error": null,
  "duplicate": false,
  "created_at": "2026-07-15T09:00:00.000Z",
  "updated_at": "2026-07-15T09:00:00.000Z"
}
```

`checkout_url`/`checkout_error` report the provider checkout-session mint: on a provider failure the row is still created (`pending`) with `checkout_error` set and **the link still works** — the hosted pay page lazily (re)creates the provider session when the payer opens it. The URL to share is always `pay_url`.

### Errors

| Status | Code / message | Meaning |
|---|---|---|
| 400 | `error_code: "NO_PAYMENT_PROVIDER"` | No payment provider is connected — connect Cardcom or Sumit in Settings → Integrations first |
| 400 | validation messages | Bad `amount`/`currency`/`expires_at`, unknown fields |
| 400 | `"vat_mode and vat_rate must be provided together"` | A lone VAT leg |
| 400 | test-mode not supported | `test_mode: true` with a provider that has no test mode |
| 400 | `"Provide contact_id, a phone/email to resolve the payer contact, or a deal_id"` | No payer reference |
| 400 | `INVALID_PRODUCT` / `PRODUCT_INACTIVE` | `product_id` unknown or inactive |
| 400 | `CURRENCY_MISMATCH` | `sale_id` names a sale in another currency |
| 400 | `"idempotency_key must be at most 200 characters"` | Oversized key |
| 403 | `FEATURE_NOT_INCLUDED_IN_PLAN` | Plan lacks the `workspace_payments` feature (body has no `statusCode` field) |
| 404 | not found | Unknown `contact_id`, `deal_id` or `sale_id` in this workspace |
| 409 | `CONTACT_MERGE_REQUIRED` | Phone and email resolve to two different contacts |
| 409 | `IDEMPOTENCY_KEY_MISMATCH` | The `idempotency_key` was already used for a different charge |
| 409 | `IDEMPOTENCY_CLAIM_IN_FLIGHT` | A concurrent request with the same key is still being processed — retry shortly |
| 409 | `PLAN_FEATURE_REQUIRED` | `sale_id` sent while the plan has no Sales feature |
| 409 | `SALE_CONTACT_MISMATCH` / `SALE_ALREADY_CANCELLED` | `sale_id` belongs to another contact, or is cancelled |

### After the mint

- The payer opens `pay_url`, pays on the hosted page, and the payment is **verified with the provider** before anything is recorded.
- A verified payment stamps `paid_at`, links `contact_payment_id` (a payment on the contact's [ledger](payments.md)), auto-issues the tax document (per `auto_issue_document`/`document_kind`), emails the payer a receipt, and fires [`payment_request.paid`](webhooks.md#payment-request-events).
- With `product_id` (and no `sale_id`), the payment records a [sale](sales.md) for the product and the request's `sale_id` is set; with `sale_id`, the payment is allocated to that sale.
- Pending links get pre-expiry **reminders** (unless disabled); a link that passes `expires_at` unpaid flips to `expired` and fires `payment_request.expired`.
- Minting does **not** send the link anywhere — share `pay_url` yourself or use [send-link](#post-apiv1payment-requestsidsend-link).

## POST /api/v1/payment-requests/:id/cancel

Withdraws the pay-link — the hosted page stops accepting payment. No request body. **Pending requests only**: the cancel is a compare-and-set on `status`, so already paid/expired/cancelled rows answer 409.

Response `201` — the cancelled row (`status: "cancelled"`, `cancelled_at` stamped). Unlike the other reads, the cancel response is the **bare row** — no computed `pay_url`/`document` fields.

| Status | Code / message | Meaning |
|---|---|---|
| 404 | `"Payment request not found"` | Unknown in this workspace; non-UUID id → 400 |
| 409 | `"Only pending payment requests can be cancelled"` | The row is already paid, expired, or cancelled |
| 409 | `error_code: "TOKEN_REQUEST_NOT_CANCELLABLE"` | The row is a direct saved-card charge (`charge_kind: "token"`) — it settles on its own and can never be cancelled |

> **Late completions.** Cancelling does not revoke an already-open checkout session: a payer who was on the hosted page when you cancelled can still complete. Such payments are **verified and recorded** rather than dropped — the row resurrects to `paid` and fires `payment_request.paid`. Treat `payment_request.paid` as authoritative even after a cancel.

## POST /api/v1/payment-requests/:id/send-link

Sends a **pending** request's pay-link to its contact — the same delivery as the in-app Send button.

| Field | Type | Required | Constraints |
|---|---|---|---|
| `channel` | enum | **yes** | `email`, `whatsapp` or `sms` |
| `resend` | boolean | no | Send again on a channel the link was already sent on (see below) |
| `conversation_id` | UUID | no | A conversation of the request's contact to associate with the request (the first one recorded wins). 400 `CONVERSATION_MISMATCH` when it belongs to someone else |

```bash
curl -X POST "https://app.otok.io/api/v1/payment-requests/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0/send-link" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{ "channel": "whatsapp" }'
```

Response `201`:

```json
{ "sent": true, "channel": "whatsapp", "to": "0501234567", "message_id": "wamid.HBgM…" }
```

`to` is the address or phone number the link went to; `message_id` is the WhatsApp / SMS message id when the channel reports one (`null` for email).

- **Once per channel.** An API send goes out once per channel: a second send on a channel the link was already sent on (by you, the app, or a reminder) answers 409 `LINK_ALREADY_SENT` with the first `sent_at` — unless you send `resend: true`. Sending on a different channel is always allowed.
- **Email** leaves only from the workspace's verified sender address. **WhatsApp** inside the contact's 24-hour window sends a plain message; outside it, oToK uses its payment-link message template, which must be approved by Meta first. **SMS** needs the SMS channel enabled for the workspace.
- The first successful send sets the request's `channel` and the matching `link_*_sent_at` stamp.

| Status | Code / message | Meaning |
|---|---|---|
| 400 | `INVALID_CHANNEL` / validation array | Unknown `channel` or unknown fields |
| 400 | `CONTACT_NO_EMAIL` / `PAYLINK_WA_NO_PHONE` | The contact has no email address / phone number |
| 400 | `PAYLINK_WA_NO_INSTANCE` / `PAYLINK_WA_PHONE_BLACKLISTED` | No connected WhatsApp number, or the contact's number is blocked |
| 400 | `PAYLINK_WA_TEMPLATE_NOT_APPROVED` | Outside the 24-hour window and the payment template is not approved yet (`template_status` in the body) |
| 400 | `CONVERSATION_MISMATCH` | `conversation_id` does not belong to the request's contact |
| 404 | `"Payment request not found"` | Unknown in this workspace |
| 409 | `REQUEST_NOT_PENDING` | The request is already paid, expired or cancelled |
| 409 | `REQUEST_HAS_NO_PAY_LINK` | A direct saved-card charge (`charge_kind: "token"`) has no pay-link |
| 409 | `LINK_ALREADY_SENT` | Already sent on this channel — the body carries `sent_at`; send `resend: true` to send again |
| 409 | `EMAIL_NOT_SENT` | The email could not leave — `reason` is one of `no_verified_sender`, `over_quota`, `suppressed`, `sending_paused` |
| 409 | `PAYLINK_SMS_NOT_SENT` | The SMS could not be sent — see `reason` in the body |
| 502 | `PAY_LINK_DELIVERY_FAILED` | The WhatsApp / SMS provider refused the message |

## POST /api/v1/payment-requests/:id/document

Issues the tax document for a **paid** request — use it when the automatic issue was switched off (`auto_issue_document: false`) or failed. No request body. The document kind is the request's `document_kind` (or the provider/account default).

```bash
curl -X POST "https://app.otok.io/api/v1/payment-requests/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0/document" \
  -H "Authorization: Bearer otok_live_abc123..."
```

Response `201` — the request, with `pay_url` and the issued `document` (`{ provider, id, number, type, url }`).

A **credit** document kind (`credit_invoice`, `credit_invoice_receipt`, `credit_receipt`, `credit_donation_receipt`) gives money back on paper, so it requires an API key with [refund access](payments.md#payments).

| Status | Code / message | Meaning |
|---|---|---|
| 403 | `API_KEY_MONEY_OUT_DISABLED` | Credit document kind with a key that lacks refund access |
| 404 | `"Payment request not found"` | Unknown in this workspace |
| 409 | `REQUEST_NOT_PAID` | The request is unpaid, or a test-mode request |
| 409 | `DOCUMENT_EXISTS` | The request already has a document |
| 409 | `PROVIDER_NOT_CONNECTED` | The payment provider is no longer connected |
| 502 | `DOCUMENT_ISSUE_FAILED` | The provider failed to issue the document |

## POST /api/v1/payment-requests/:id/refund

Refunds the payment a **paid** request settled — the same refund path as [`POST /v1/payments/:id/refund`](payments.md#post-apiv1paymentsidrefund), addressed by the request instead of the ledger payment. Requires an API key with [refund access](payments.md#payments).

| Field | Type | Required | Constraints |
|---|---|---|---|
| `reason` | enum | **yes** | One of the [refund reasons](payments.md#refund-reasons) |
| `mode` | enum | **yes** | `auto` — refund through the connected payment gateway; `recorded_outside` — book the refund only, the money was (or will be) returned outside oToK |
| `amount` | number | no | ≥ 0.01, in the request's currency. Omitted → the full remaining refundable balance |
| `note` | string | no | ≤1000 — stored on the refund entry |
| `idempotency_key` | string | no | ≤200, unique per workspace — a replay returns the original refund with `duplicate: true` |

```bash
curl -X POST "https://app.otok.io/api/v1/payment-requests/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0/refund" \
  -H "Authorization: Bearer otok_live_abc123..." \
  -H "Content-Type: application/json" \
  -d '{ "reason": "requested_by_customer", "mode": "auto", "idempotency_key": "pr-refund-1" }'
```

Response `201` — the [refund result](payments.md#response-201) (`{ payment, entry, outcome, duplicate }`, plus `incidentId` on a pending reversal) with **`payment_request_id`**. The request's list row shows the running `refunded_total`.

Errors are those of the [payments refund](payments.md#errors-1), plus:

| Status | Code / message | Meaning |
|---|---|---|
| 404 | `"Payment request not found"` | Unknown in this workspace |
| 409 | `REQUEST_NOT_REFUNDABLE` | The request is not paid, is a test-mode request, or its payment no longer has a single refundable charge |
| 409 | `REQUEST_NOT_LEDGERED` | The payment has not been recorded to the payments ledger yet — retry shortly |
| 409 | `NO_PROVIDER_PAYMENT_REF` | The request has no provider transaction reference to refund against |

## Webhooks

The four lifecycle events — `payment_request.created` / `paid` / `expired` / `cancelled` — are **opt-in by listing** at [`POST /v1/webhook-endpoints`](webhooks.md): an endpoint registered without an explicit `events` list receives none of them. Payloads follow the order-event conventions (full field set, explicit `null`s, `test_mode` always present) — see [payment-request event `data`](webhooks.md#payment-request-event-data). Refunds of a paid request fire the [`payment.refunded`](webhooks.md#payment-events) event of the payment it settled.

## Choosing a payment terminal

`POST /api/v1/payment-requests` accepts optional `terminal_number` (positive integer). With Cardcom, use a terminal configured in the workspace settings; omission uses the default terminal. An unknown terminal, or a provider without terminal selection, returns 400.
