=== oToK for WooCommerce ===
Contributors: otok
Tags: woocommerce, marketing, consent, abandoned cart, automation
Requires at least: 6.6
Tested up to: 7.0
Requires PHP: 8.1
WC requires at least: 9.6
Stable tag: 0.1.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Connect your WooCommerce store to oToK: marketing consent at checkout, plus cart and order events for your automation flows.

== Description ==

oToK for WooCommerce connects a WooCommerce store to [oToK](https://otok.io), a multichannel marketing communication platform. Once connected, the plugin:

* Adds a marketing-consent checkbox to checkout (both the Checkout Block and the classic shortcode checkout), always unchecked by default, and relays the shopper's explicit decision to oToK with a real consent source.
* Relays cart created/updated events so oToK can run abandoned-cart automations (abandonment itself is decided in oToK — the plugin sends raw cart snapshots only).
* Relays order lifecycle events (created, status changes, refunds) into oToK automation flows.

The plugin only communicates with the oToK service that the store owner explicitly connects via a one-time connect code. There is no telemetry, no tracking, and no other external calls.

This 0.1.0 release includes the integration skeleton (pairing-code connect, secure credential storage, admin settings and health panel), the marketing-consent checkbox — shoppers see it in both checkout experiences (the order information step of the Checkout block; after the email field on the classic checkout) with their choice recorded on the order — the reliable delivery pipeline (a local event queue with signed HTTPS delivery, automatic retries with backoff, and a health panel showing queue depth and recent delivery problems; a temporary oToK outage never loses events), and the full event capture: consent, cart created/updated snapshots (debounced, flushed immediately when the shopper reaches checkout), and order created/updated events covering status changes, cancellations and refunds — all on both checkout stacks, HPOS-compatible.

= Languages =

English and Hebrew (he_IL). As a self-distributed plugin there are no wordpress.org language packs — the translation files ship inside the plugin (`languages/`, .po/.mo plus the WordPress 6.5+ .l10n.php format). The admin screens are RTL-ready.

= Guest email capture =

So abandoned-cart automations can reach a shopper before an order exists, the plugin can capture the email address a guest types at checkout (on by default, WooCommerce → oToK → Cart tracking). The address is kept only in the shopper's WooCommerce session and attached to cart events — it is never logged or stored anywhere else. An optional strict mode holds the captured address back until the shopper ticks the marketing-consent checkbox.

= Bundled libraries =

* Action Scheduler 3.9.3 (https://actionscheduler.org/, GPL-3.0-or-later) — background delivery queue. As a combined work, the distributed plugin zip is effectively distributable under GPL-3.0-or-later terms.

= Requirements =

* WordPress 6.6 or newer (WooCommerce 9.6 itself requires 6.6)
* WooCommerce 9.6 or newer
* PHP 8.1 or newer
* An oToK workspace with the e-commerce integration enabled

Multisite network activation is not supported; activate per site.

= Support =

Email us at we@otok.io. The plugin's health panel includes a copy-diagnostics button that produces a support-ready status block (versions and connection state only — no secrets, no customer data).

== Installation ==

1. Upload the plugin zip via Plugins → Add New → Upload Plugin, or unzip it into `wp-content/plugins/`.
2. Activate **oToK for WooCommerce** (WooCommerce must be active).
3. In your oToK workspace, open the WooCommerce connect screen and generate a one-time connect code.
4. In wp-admin, go to WooCommerce → oToK, paste the code, and click Connect.

== Frequently Asked Questions ==

= Where does my data go? =

Only to the oToK workspace you explicitly connect. The plugin makes no other external calls and collects no telemetry.

= Does the consent checkbox default to checked? =

No, and there is deliberately no setting to change that. Express opt-in laws (e.g. Israel's Communications Law §30A, GDPR) effectively outlaw pre-checked marketing consent boxes.

= Does it work on multisite? =

Network activation is refused. Activating on individual sites of a multisite network is untested and unsupported in v1. Uninstalling from the network admin still cleans up every site.

= What happens if my oToK plan lapses? =

Event delivery pauses and the health panel shows a distinct "Paused — oToK plan lapsed" state. Nothing is lost: events keep queueing locally and delivery resumes automatically once the plan is active again.

= What happens to my data when I uninstall? =

Deleting the plugin drops its local event queue (any still-undelivered events are lost), removes all of its options, transients and scheduled actions, and leaves nothing else behind — with one deliberate exception: the marketing-consent record captured on each order is kept (plus a few inert per-order bookkeeping stamps the plugin wrote as order meta). It is the store's legal opt-in evidence, stored as regular WooCommerce order meta and covered by WooCommerce's own privacy/erasure tooling. Data already sent to oToK is managed from your oToK workspace.

= How do I get support? =

Email we@otok.io and paste the diagnostics block from WooCommerce → oToK → Health.

== Changelog ==

= 0.1.0 =
* Initial release skeleton: pairing-code connect with encrypted credential storage, admin settings page under the WooCommerce menu, health panel with copy-diagnostics, HPOS and cart/checkout-blocks compatibility declarations, uninstall cleanup.
* Marketing-consent checkbox at checkout (Checkout block and classic checkout), always unchecked by default, with a store-owner-editable label; the shopper's choice is recorded on the order as consent evidence.
* Reliable event delivery: durable local queue, HMAC-signed HTTPS delivery to the connected oToK workspace, automatic retries with backoff, distinct paused state when the oToK plan lapses (nothing is lost), automatic protection against a cloned/staging site sending data into the live connection, live health panel (queue depth, last delivery, recent failures) and enriched copy-diagnostics. Bundles Action Scheduler 3.9.3.
* Event capture: consent events from the checkout checkbox; cart created/updated snapshots (debounced ~45s, flushed immediately on checkout entry, session-bound cart token rotated after purchase) for abandoned-cart automations decided in oToK; order created/updated events for checkout orders, status changes, cancellations and refunds (partial refunds included) — both checkout stacks, HPOS-compatible.
* Guest email capture (on by default, with an optional consent-strict mode) so cart events can carry a guest shopper's identity; the address lives only in the WooCommerce session and is never logged.
* Release polish: bundled Hebrew (he_IL) translation (.po/.mo/.l10n.php — full admin UI), RTL-ready admin styles, complete uninstall cleanup (multisite-aware; consent evidence on orders deliberately retained), and integration documentation.
