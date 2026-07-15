<?php
/**
 * Uninstall cleanup.
 *
 * Runs when the plugin is DELETED from wp-admin (not on deactivation), with
 * neither the plugin nor WooCommerce guaranteed to be loaded. It drops the
 * outbox table (stated plainly: any still-pending events are lost), removes
 * the plugin's options and transients, and unschedules its Action Scheduler
 * actions when another AS copy (e.g. WooCommerce's) is still around to ask.
 *
 * Complete inventory of everything the plugin creates, and its fate here:
 *
 * REMOVED
 * - Options: `otok_wc_connection`, `otok_wc_signing_secret`,
 *   `otok_wc_consent_label`, `otok_wc_outbox_schema`,
 *   `otok_wc_delivery_state`, `otok_wc_guest_email_capture`,
 *   `otok_wc_guest_email_strict` (the explicit list below).
 * - Table: `{$wpdb->prefix}otok_wc_outbox`.
 * - Transients (all `otok_wc_`-prefixed, swept by LIKE): admin flash notices
 *   `otok_wc_notice_{user}`, cart debounce state `otok_wc_cart_snap_/seen_/
 *   hash_{token}`, guest-email rate-limit buckets `otok_wc_geml_*`.
 * - Action Scheduler actions: hooks `otok_wc_dispatch_outbox`,
 *   `otok_wc_purge_outbox`, `otok_wc_flush_cart` (group
 *   `otok-for-woocommerce`) — best-effort, see below.
 *
 * RETAINED (deliberate)
 * - Consent order meta `_otok_wc_consent`, `_otok_wc_consent_source`,
 *   `_otok_wc_consent_label`, `_otok_wc_consent_captured_at`, plus the raw
 *   blocks-checkout field value WooCommerce stores at
 *   `_wc_other/otok-wc/marketing-consent`: this is the store's legal opt-in
 *   record, attached to Woo orders and covered by Woo's own privacy tooling.
 *   Deleting consent evidence on uninstall would be a compliance bug, not a
 *   cleanup.
 * - Bookkeeping order meta `_otok_wc_order_created_emitted`,
 *   `_otok_wc_order_seq`, `_otok_wc_cart_token`: inert per-order stamps.
 *   Removing them would require direct writes to WooCommerce's order storage
 *   (postmeta or the HPOS orders-meta table, depending on the store) without
 *   WooCommerce's CRUD loaded — unsafe at uninstall time and pointless for a
 *   handful of bytes per order.
 * - WooCommerce SESSION keys `otok_wc_cart_token`, `otok_wc_guest_email`,
 *   `otok_wc_consent_hint`: they live inside WooCommerce's own session rows
 *   and expire with them (Woo prunes sessions itself); nothing to remove
 *   without unserializing every live session.
 * - Action Scheduler's own persistence: the `{$wpdb->prefix}actionscheduler_*`
 *   tables and its options (`schema-ActionScheduler_*`,
 *   `action_scheduler_hybrid_store_demarkation`, `action_scheduler_lock_*`).
 *   When the copy bundled here is the newest registered on the site, OUR code
 *   is what created/migrated them — but they are shared cross-plugin
 *   infrastructure used by WooCommerce and any other AS consumer, so they are
 *   never touched (dropping them would destroy the site's whole background
 *   queue). The cancelled action/log rows left by the unschedule calls below
 *   are purged by AS's own retention sweep.
 *
 * MULTISITE: network ACTIVATION is refused (see otok_wc_activate()), but the
 * plugin can be activated per site of a network, and deleting it from the
 * network admin runs this file exactly once — so on multisite the cleanup
 * below iterates every site. Sites where the plugin never ran are no-ops
 * (option deletes miss, DROP TABLE IF EXISTS misses).
 *
 * @package OtokWC
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

/**
 * Remove this plugin's data for the CURRENT site (options, transient rows,
 * outbox table, scheduled actions).
 *
 * @return void
 */
function otok_wc_uninstall_site() {
	global $wpdb;

	// Options created by the plugin. Keep this list explicit and in sync with
	// the code (the OPTION_* constants across includes/).
	$options = array(
		'otok_wc_connection',
		'otok_wc_signing_secret',
		'otok_wc_consent_label',
		'otok_wc_outbox_schema',
		'otok_wc_delivery_state',
		'otok_wc_guest_email_capture',
		'otok_wc_guest_email_strict',
	);

	foreach ( $options as $option ) {
		delete_option( $option );
	}

	// Unschedule this plugin's Action Scheduler actions. The bundled AS copy
	// is being deleted with the plugin, so this only works when another copy
	// is loaded (WooCommerce bundles one) — hence the function_exists guard;
	// best-effort on secondary multisite blogs. Leftover actions are harmless:
	// their hooks no longer exist, so AS simply completes them as no-ops. Hook
	// names are string literals because the plugin's classes are not loaded at
	// uninstall; they mirror Otok_WC_Delivery::HOOK_DISPATCH / HOOK_PURGE and
	// Otok_WC_Cart_Events::HOOK_FLUSH.
	if ( function_exists( 'as_unschedule_all_actions' ) ) {
		as_unschedule_all_actions( 'otok_wc_dispatch_outbox' );
		as_unschedule_all_actions( 'otok_wc_purge_outbox' );
		as_unschedule_all_actions( 'otok_wc_flush_cart' );
	}

	// phpcs:disable WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.SchemaChange -- uninstall-time removal of this plugin's own table and transient rows; no WP API covers either.

	// Drop the outbox table (mirrors Otok_WC_Outbox::table_name()).
	$wpdb->query( "DROP TABLE IF EXISTS {$wpdb->prefix}otok_wc_outbox" );

	// Sweep the plugin's transients (`otok_wc_*`: flash notices, cart
	// debounce state, rate-limit buckets). Per-user/per-token names cannot be
	// enumerated via the Transients API, so remove the rows directly; on
	// sites with an external object cache the remaining cache entries expire
	// on their own TTLs (7 days at most).
	$wpdb->query(
		$wpdb->prepare(
			"DELETE FROM {$wpdb->options} WHERE option_name LIKE %s OR option_name LIKE %s",
			$wpdb->esc_like( '_transient_otok_wc_' ) . '%',
			$wpdb->esc_like( '_transient_timeout_otok_wc_' ) . '%'
		)
	);
	// phpcs:enable WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.DirectDatabaseQuery.SchemaChange
}

if ( is_multisite() ) {
	$otok_wc_site_ids = get_sites(
		array(
			'fields' => 'ids',
			'number' => 0, // All sites: per-site activation leaves per-site data.
		)
	);

	foreach ( $otok_wc_site_ids as $otok_wc_site_id ) {
		switch_to_blog( $otok_wc_site_id );
		otok_wc_uninstall_site();
		restore_current_blog();
	}
} else {
	otok_wc_uninstall_site();
}
