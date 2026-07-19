# Payment Requests

Hosted **pay-by-link** requests collected through the workspace's own connected payment provider (Cardcom or Sumit). Minting a request returns a shareable `pay_url`; the payer completes checkout on the hosted page, the payment is verified with the provider, recorded on the contact's [payments](payments.md) ledger, and an Israeli tax document is auto-issued (configurable). Lifecycle changes fire the opt-in [`payment_request.*` webhooks](webhooks.md#payment-request-events).

All endpoints require [authentication](getting-started.md#authentication). Payment requests cannot be deleted, and there is no PATCH — a mistaken link is [cancelled](#post-apiv1payment-requestsidcancel) and a new one minted.

> **Plan feature required:** every route on this page requires the **Workspace payments** feature (`workspace_payments`) on the workspace's plan, in addition to API access. This is a **different feature** from the `payments` ledger gate on `/v1/payments*` — a workspace can hold either without the other. Without it, all calls return `403` with `error_code: "FEATURE_NOT_INCLUDED_IN_PLAN"` (the message embeds `workspace_payments`) — see [feature-gated resource groups](getting-started.md#feature-gated-resource-groups). Minting additionally requires a **connected provider** (Cardcom or Sumit in Settings → Integrations) — otherwise 400 `NO_PAYMENT_PROVIDER`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/payment-requests` | List payment requests (filterable, paginated) |
| GET | `/api/v1/payment-requests/:id` | Get one payment request |
| POST | `/api/v1/payment-requests` | Create a payment request (mint a pay-link) — **NOT idempotent** |
| POST | `/api/v1/payment-requests/:id/cancel` | Cancel a pending payment request |

> **No idempotency key.** Unlike deals, payments, and orders, `POST /v1/payment-requests` has **no idempotency reference of any kind**: a repeat POST — including a blind retry after a network failure — mints a **second, independently payable link**. Both links can be paid. If a create's outcome is uncertain, check `GET /v1/payment-requests` (filter by `contact_id`/`deal_id`) before minting again, and cancel extras via the cancel endpoint.

## The payment request object

Status lifecycle: **`pending` → `paid` | `expired` | `cancelled`**. Money serializes as JSON numbers.

Main fields:

| Field | Type | Notes |
|---|---|---|
| `id` | UUID | |
| `workspace_id` | UUID | |
| `contact_id` | UUID or `null` | The payer contact (`null` only after the contact was deleted) |
| `deal_id` | UUID or `null` | The [deal](deals.md) the request is bound to, when minted for one |
| `provider` | enum | `cardcom` / `sumit` — the connected provider the money moves through |
| `status` | enum | `pending`, `paid`, `expired`, `cancelled` |
| `charge_kind` | enum | `checkout` = hosted pay-link (what this API mints). `token` rows are direct saved-card charge anchors created by the system — they appear in list/get with `pay_url: null`, cannot be cancelled, and never emit webhooks |
| `amount` / `currency` | number / enum | Amount to collect; `ILS`, `USD`, `EUR`, `GBP` |
| `title` / `note` | string or `null` | Payer-facing title; internal note |
| `max_installments` | integer or `null` | Max card installments offered on the hosted page |
| `auto_issue_document` / `document_kind` | boolean / enum or `null` | Tax-document auto-issue on successful charge; kind `null` = provider default |
| `public_token` | string | The high-entropy `pr_…` token — the last segment of `pay_url`. Treat it as the payer's secret |
| `provider_checkout_ref` / `provider_payment_ref` / `provider_customer_ref` | string or `null` | Provider-side correlation references |
| `test_mode` | boolean | Authorise-only test run — never records real money; expires within 1 hour |
| `vat_mode` / `vat_rate` | enum / number, or `null`s | The resolved VAT posture stamped at mint (request override → workspace default); checkout, document, and any refund credit-document all price with it |
| `reminders_enabled` / `reminder_count` / `last_reminder_at` | | Pre-expiry reminder emails |
| `expires_at` | ISO 8601 or `null` | Link deadline (clamped at mint — see below) |
| `paid_at` / `cancelled_at` | ISO 8601 or `null` | |
| `contact_payment_id` | UUID or `null` | The [`/v1/payments`](payments.md) ledger row a verified payment landed on — set once paid |
| `metadata` | object or `null` | System-managed (issued `document` pointer, checkout diagnostics) — **not writable** via this API |
| `created_by` | UUID or `null` | `null` for API mints |
| `created_at` / `updated_at` | ISO 8601 | |

Computed fields:

- **`pay_url`** — the shareable hosted pay-page URL (`https://app.otok.io/pay/<public_token>`). Present on create/get/list; `null` on `token` rows; the **cancel** response is the bare row without computed fields.
- **`document`** — the issued tax-document pointer `{ provider, id, number, type, url }` once paid (get/list); `null` while unpaid.
- **Create only:** `checkout_url` / `checkout_error` — see [create](#post-apiv1payment-requests).
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

Mints a hosted-checkout pay-link and returns the row with its shareable `pay_url`. **Not idempotent** — see the warning at the top of this page.

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
| 403 | `FEATURE_NOT_INCLUDED_IN_PLAN` | Plan lacks the `workspace_payments` feature (body has no `statusCode` field) |
| 404 | not found | Unknown `contact_id` or `deal_id` in this workspace |
| 409 | `CONTACT_MERGE_REQUIRED` | Phone and email resolve to two different contacts |

### After the mint

- The payer opens `pay_url`, pays on the hosted page, and the payment is **verified with the provider** before anything is recorded.
- A verified payment stamps `paid_at`, links `contact_payment_id` (a payment on the contact's [ledger](payments.md)), auto-issues the tax document (per `auto_issue_document`/`document_kind`), emails the payer a receipt, and fires [`payment_request.paid`](webhooks.md#payment-request-events).
- Pending links get pre-expiry **reminder emails** (unless disabled); a link that passes `expires_at` unpaid flips to `expired` and fires `payment_request.expired`.

## POST /api/v1/payment-requests/:id/cancel

Withdraws the pay-link — the hosted page stops accepting payment. No request body. **Pending requests only**: the cancel is a compare-and-set on `status`, so already paid/expired/cancelled rows answer 409.

Response `201` — the cancelled row (`status: "cancelled"`, `cancelled_at` stamped). Unlike the other reads, the cancel response is the **bare row** — no computed `pay_url`/`document` fields.

| Status | Code / message | Meaning |
|---|---|---|
| 404 | `"Payment request not found"` | Unknown in this workspace; non-UUID id → 400 |
| 409 | `"Only pending payment requests can be cancelled"` | The row is already paid, expired, or cancelled |
| 409 | `error_code: "TOKEN_REQUEST_NOT_CANCELLABLE"` | The row is a direct saved-card charge (`charge_kind: "token"`) — resolved by the charge orchestration, never operator-cancellable |

> **Late completions.** Cancelling does not revoke an already-open checkout session: a payer who was on the hosted page when you cancelled can still complete. Such payments are **verified and recorded** rather than dropped — the row resurrects to `paid` and fires `payment_request.paid`. Treat `payment_request.paid` as authoritative even after a cancel.

## Webhooks

The four lifecycle events — `payment_request.created` / `paid` / `expired` / `cancelled` — are **opt-in by listing** at [`POST /v1/webhook-endpoints`](webhooks.md): an endpoint registered without an explicit `events` list receives none of them. Payloads follow the order-event conventions (full field set, explicit `null`s, `test_mode` always present) — see [payment-request event `data`](webhooks.md#payment-request-event-data).
