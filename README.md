# otok-api

Developer resources for integrating with **oToK** — public REST API reference, webhook contract, and integration guides.

oToK is a multichannel marketing communication platform (WhatsApp, email, web). Its REST API lets you sync contacts, run WhatsApp campaigns, send template messages and transactional email, manage deals, payments, and e-commerce orders, and drive bookings from your own systems.

## Documentation

- **[Hosted docs site →](https://slikkdev.github.io/otok-api/)** — browsable guides + API reference
- **[API Reference (Redoc) →](https://slikkdev.github.io/otok-api/reference/)** — rendered from the OpenAPI spec
- **[OpenAPI 3.1 spec](docs/openapi.yaml)** — machine-readable API description (`docs/openapi.yaml`)

**[API Reference (markdown) →](docs/api/README.md)**

Quick links:

- [Getting Started](docs/api/getting-started.md) — API keys, authentication, base URL, errors, rate limits
- [Contacts](docs/api/contacts.md) — upsert contacts, manage notes
- [Campaigns](docs/api/campaigns.md) & [Templates](docs/api/templates.md) — WhatsApp messaging
- [Deals & Pipelines](docs/api/deals.md) and [Payments](docs/api/payments.md)
- [Orders](docs/api/orders.md) — e-commerce orders: line items, refunds, mark-paid/cancel
- [Transactional Emails](docs/api/emails.md) and [Webhooks](docs/api/webhooks.md)
- [Bookings & Meeting Types](docs/api/bookings.md)

## At a glance

```bash
curl "https://app.otok.io/api/v1/contacts?limit=5" \
  -H "Authorization: Bearer otok_live_..."
```

- Base URL: `https://app.otok.io/api/v1/`
- Auth: workspace API keys (`otok_live_…`), created in **Settings → Developers**
- Interactive Swagger docs: `https://app.otok.io/api/v1/docs`
- Requires a plan with API access (Growth or higher)

## WordPress / WooCommerce plugin

**oToK for WooCommerce** — a self-contained WordPress plugin that connects a WooCommerce store to oToK: marketing consent at checkout, plus cart and order events delivered over signed webhooks with durable queuing and retries.

- Lives in [`integrations/wordpress/`](integrations/wordpress/)
- Developer docs: [`integrations/wordpress/README.md`](integrations/wordpress/README.md)
- CI: lint, PHPCS, and a wp-env runtime smoke test run on any change under `integrations/wordpress/`

## License

MIT — see [LICENSE](LICENSE), with one exception: the `integrations/wordpress/` subtree is GPL-2.0-or-later (it is a WordPress plugin and bundles Action Scheduler) — see [its LICENSE](integrations/wordpress/otok-for-woocommerce/LICENSE).
