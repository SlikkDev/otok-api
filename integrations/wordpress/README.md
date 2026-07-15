# oToK for WooCommerce — developer docs

WordPress plugin connecting a WooCommerce store to oToK: marketing consent at checkout, cart + order event relay, reliable delivery. Support contact: **we@otok.io**.

## Layout

```
integrations/wordpress/
├── otok-for-woocommerce/     # The shippable plugin (this exact folder name = the plugin slug)
│   ├── otok-for-woocommerce.php   # Main file: headers, guards, WC feature declarations, AS require, bootstrap
│   ├── includes/
│   │   ├── class-otok-wc-plugin.php        # Bootstrap singleton
│   │   ├── class-otok-wc-credentials.php   # Connection record + encrypted signing secret + site-URL snapshot
│   │   ├── class-otok-wc-connect.php       # Pairing-code exchange client (endpoint path PROVISIONAL)
│   │   ├── class-otok-wc-consent.php       # Consent checkbox (both checkouts) + order-meta capture
│   │   ├── class-otok-wc-payloads.php      # ALL wire payload serializers (envelope + data shapes, PROVISIONAL)
│   │   ├── class-otok-wc-outbox.php        # Durable event queue table (frozen payloads, retention purges)
│   │   ├── class-otok-wc-delivery.php      # Action Scheduler dispatcher: signing, retry/revocation policy
│   │   ├── class-otok-wc-guest-email.php   # Guest email capture (AJAX + Store API) + strict-mode setting
│   │   ├── class-otok-wc-cart-events.php   # Cart token lifecycle + debounced raw cart snapshots
│   │   ├── class-otok-wc-order-events.php  # Consent + order created/updated producers (HPOS-safe)
│   │   └── admin/
│   │       ├── class-otok-wc-admin.php     # Settings page under the WooCommerce menu + delivery-state notices
│   │       └── views/settings-page.php
│   ├── assets/                # Admin CSS (logical properties — RTL-correct, no -rtl sibling) and JS
│   ├── lib/action-scheduler/  # Bundled Action Scheduler 3.9.3 (verbatim, GPL-3.0 — never modify, PHPCS-excluded)
│   ├── languages/             # Shipped translations: POT + he_IL (.po/.mo/.l10n.php — see "Translations")
│   ├── readme.txt             # wp.org-format readme
│   ├── uninstall.php
│   └── LICENSE                # GPL-2.0 (the GPL scope is this plugin subtree ONLY — the
│                              #  rest of the otok-api repository is MIT-licensed)
├── bin/build-zip.sh           # Deterministic release-zip build (output in dist/, gitignored)
├── composer.json              # Dev tooling only (PHPCS), never shipped
├── phpcs.xml.dist
└── README.md                  # This file
```

## Licensing boundary

Everything under `otok-for-woocommerce/` is GPL-2.0-or-later (see its `LICENSE`). The rest of this repository is MIT-licensed (see the root `LICENSE`). The plugin talks to the oToK service exclusively over HTTPS — no oToK server code is linked into the GPL artifact.

## Tooling

Requires PHP 8.1+ and Composer.

```bash
cd integrations/wordpress
composer install

# Syntax lint
find otok-for-woocommerce -name "*.php" -print0 | xargs -0 -n1 php -l

# Coding standards (WordPress standard, see phpcs.xml.dist)
composer phpcs

# Auto-fix what phpcbf can
composer phpcs:fix
```

CI runs the same two checks (`.github/workflows/wordpress-plugin-ci.yml`) on any change under `integrations/wordpress/`.

## Building a release zip

```bash
cd integrations/wordpress
bin/build-zip.sh   # → dist/otok-for-woocommerce-<version>.zip
```

The script stages the plugin tree, normalizes mtimes/permissions and zips entries in sorted order (`zip -X`), so the same tree always produces a **byte-identical** zip (the script prints the SHA-256). The version is parsed from the plugin header; the top-level folder inside the zip stays `otok-for-woocommerce` (it is the slug). Everything in the plugin directory ships — Action Scheduler (`lib/action-scheduler/`) and the translation files (`languages/`) included; only editor/OS droppings are excluded. Output lands in `dist/` and is gitignored — never commit a release zip.

## Translations

Self-distributed plugin ⇒ no translate.wordpress.org language packs; translations ship in `languages/` and load via `load_plugin_textdomain()` on `init`. Shipped per locale: `.po` (source), `.mo` (compiled), and the WP 6.5+ `.l10n.php` (preferred by core when present — faster, OPcache-able). Currently: Hebrew (`he_IL`), full coverage.

Updating after string changes (WP-CLI with the i18n commands):

```bash
cd integrations/wordpress
wp i18n make-pot otok-for-woocommerce otok-for-woocommerce/languages/otok-for-woocommerce.pot \
  --slug=otok-for-woocommerce --domain=otok-for-woocommerce --exclude=lib
wp i18n update-po otok-for-woocommerce/languages/otok-for-woocommerce.pot   # merges into the .po files
# …translate the new entries in otok-for-woocommerce-he_IL.po, then:
wp i18n make-mo otok-for-woocommerce/languages otok-for-woocommerce/languages
wp i18n make-php otok-for-woocommerce/languages otok-for-woocommerce/languages
```

Hebrew style: infinitive imperatives (להתחבר, יש להזין — never gendered slash forms); translate Latin words with a natural Hebrew rendering; keep brand/technical terms (WooCommerce, WordPress, oToK, API, HTTPS) in Latin inside Hebrew strings. The admin stylesheet uses CSS logical properties throughout, so there is no `-rtl.css` sibling — keep new rules logical (`margin-inline-*`, `text-align: start`) rather than physical.

## Verification expectations (per PR)

Every PR body states what was verified: `php -l` on all files, PHPCS clean against `phpcs.xml.dist`, and — where the environment allows — a local WP/Woo smoke test (wp-env/Docker: connect flow, checkbox on both checkouts, delivery against a mock receiver). Anything not verifiable (e.g. no live oToK ingest endpoint yet) is stated explicitly.

## Contract notes for contributors

- The pairing-exchange endpoint path is **PROVISIONAL** — it lives behind the `OTOK_WC_PAIRING_PATH` constant + `otok_wc_pairing_path` filter in `class-otok-wc-connect.php`; when the oToK e-commerce contract freezes the path, updating it is a one-line change.
- **All wire payloads are built in `class-otok-wc-payloads.php` and nowhere else.** The topic vocabulary is FROZEN; the envelope field names and `data` shapes are PROVISIONAL until the oToK e-commerce contract freezes the envelope — keeping every serializer in that one file makes the freeze a one-file diff.
- **Event producers enqueue via `Otok_WC_Plugin::instance()->delivery()->enqueue_event( $topic, $data )`** (topic = an `Otok_WC_Payloads::TOPIC_*` constant, data = the matching serializer's output). Enqueue mints `event_id` + `occurred_at` and FREEZES the payload — coalescing/debounce must happen strictly pre-enqueue; a newer snapshot after enqueue is a new event with a new `event_id`.
- The delivery policy (backoff ladder, Retry-After, entitlement pause via 429 + `{"code":"entitlement_paused"}`, 3-consecutive-401/404 revocation, single clock-skew retry off the response Date header) is implemented in `class-otok-wc-delivery.php` and documented in its class docblock — it mirrors the frozen wire contract; do not "simplify" it.
- One oToK connection per site; `site_url` is snapshotted at connect time and checked before EVERY dispatch run — a cloned/moved site suspends delivery until the admin explicitly reconnects or accepts the new URL.
- Bundled Action Scheduler stays on the 3.9.x line until the WC 11.0 compatibility pass (AS 4.0 requires WP 6.8+ and newest-copy-wins would force-upgrade the whole site). Never modify files under `lib/`.
- The signing secret is encrypted at rest (libsodium secretbox, key derived from the wp-config salts) — read the honest blast-radius docblock in `class-otok-wc-credentials.php` before touching it.
- Consent capture writes normalized order meta (`_otok_wc_consent` = `granted`|`not_granted`, `_otok_wc_consent_source`, `_otok_wc_consent_label`, `_otok_wc_consent_captured_at`) at order-processed time on both checkout stacks — the stable seam the `otok/consent_updated` event producer reads. Capture runs whether or not the store is connected; the meta is retained on uninstall (legal opt-in evidence). The checkbox is ALWAYS shown and ALWAYS default-unchecked — a hard legal rule, never add a setting for either. The blocks field uses location `order` (not `contact` — contact fields sync to the customer account and pre-fill for returning shoppers, which would break default-unchecked). If the field was not registered/offered at submit time, NO meta is written (no fabricated signal); for headless Store API checkouts a registered field is part of the published checkout schema and counts as offered — schema-registered-but-unrendered is treated as shown-but-unchecked by design.
- **Event producers:** `otok/consent_updated` + `otok/order_created` fire at checkout-order-processed on both stacks (producer priority 20, AFTER consent capture at 10); Store-API `checkout-draft` orders are never emitted, and a payment-retry re-fire of the processed hook emits `otok/order_updated` (order-meta stamp `_otok_wc_order_created_emitted`). `otok/order_updated` also fires on every status change (checkout-draft transitions suppressed) and on refund creation — the only chokepoint that can surface `partially_refunded`. The financial_status mapping and ALL money formatting (decimal strings, tax-exclusive `unit_price`, grand-total `total`) live in `Otok_WC_Payloads`.
- **Carts:** RAW snapshots only — NO local abandonment timer (the oToK server decides abandonment). The cart token is a plugin-minted uuid4 in the WC session (minted on first non-empty cart activity, re-saved on `wp_login`, rotated after order completion). Debounce is strictly pre-enqueue: each mutation stores the latest snapshot in a per-token transient and re-schedules a dated AS single action (`otok_wc_flush_cart`, ~45s quiet window); checkout entry flushes immediately. First flushed snapshot for a token = `cart_created`, later ones `cart_updated`.
- **Guest email capture** (setting, default ON): classic checkout posts the billing email on blur to a hardened admin-ajax endpoint (nonce, session-bound, non-empty cart, `is_email`, per-session rate limit); the blocks checkout is captured server-side via `woocommerce_store_api_cart_update_customer_from_request`. The address lives in the WC session ONLY and reaches oToK only inside cart-event contacts — never logs, never options. Strict mode withholds it until the consent checkbox is ticked (classic-checkout hint; on blocks that means until the order is placed).
- Producers enqueue only while connected; consent META capture stays unconditional.
- Prefix everything global with `otok_wc_` / `Otok_WC_` / `OTOK_WC_`; all user-facing strings use text domain `otok-for-woocommerce`.
