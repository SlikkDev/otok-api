# otok-api

Developer resources for integrating with **oToK** — public REST API reference, webhook contract, and integration guides.

oToK is a multichannel marketing communication platform (WhatsApp, email, web). Its REST API lets you sync contacts, run WhatsApp campaigns, send template messages and transactional email, manage deals and payments, and drive bookings from your own systems.

## Documentation

**[API Reference →](docs/api/README.md)**

Quick links:

- [Getting Started](docs/api/getting-started.md) — API keys, authentication, base URL, errors, rate limits
- [Contacts](docs/api/contacts.md) — upsert contacts, manage notes
- [Campaigns](docs/api/campaigns.md) & [Templates](docs/api/templates.md) — WhatsApp messaging
- [Deals & Pipelines](docs/api/deals.md) and [Payments](docs/api/payments.md)
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
