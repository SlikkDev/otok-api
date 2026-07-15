<?php
/**
 * Plugin Name:          oToK for WooCommerce
 * Plugin URI:           https://otok.io/woocommerce
 * Description:          Connects your WooCommerce store to oToK — marketing consent at checkout plus cart and order events for automation flows. Talks only to the oToK service you explicitly connect.
 * Version:              1.0.0
 * Requires at least:    6.6
 * Requires PHP:         8.1
 * Requires Plugins:     woocommerce
 * Author:               oToK
 * Author URI:           https://otok.io
 * License:              GPL-2.0-or-later
 * License URI:          https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:          otok-for-woocommerce
 * Domain Path:          /languages
 * Update URI:           https://updates.otok.io/otok-for-woocommerce
 * WC requires at least: 9.6
 * WC tested up to:      10.9
 *
 * @package OtokWC
 */

defined( 'ABSPATH' ) || exit;

define( 'OTOK_WC_VERSION', '1.0.0' );
define( 'OTOK_WC_PLUGIN_FILE', __FILE__ );
define( 'OTOK_WC_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );
define( 'OTOK_WC_PLUGIN_URL', plugin_dir_url( __FILE__ ) );
define( 'OTOK_WC_MIN_WC_VERSION', '9.6' );

/*
 * Bundled Action Scheduler (3.9.x) — the outbox dispatcher's job engine.
 * Loaded unconditionally at file include time, BEFORE `plugins_loaded`
 * priority 0, per the AS embedding docs. Version conflicts are handled by
 * AS itself: every copy registers its version and the newest registered
 * copy on the site wins, so this coexists safely with WooCommerce's own
 * bundled copy. Deliberately 3.9.x, not 4.0: AS 4.0 requires WP 6.8+ and —
 * newest-copy-wins — bundling it would force-upgrade the site-wide AS ahead
 * of WC 11.0 (the 4.0 bump is planned for the WC 11.0 compatibility pass).
 */
require_once __DIR__ . '/lib/action-scheduler/action-scheduler.php';

/**
 * Activation guard + install.
 *
 * Multisite network activation is out of scope for v1 (per-site credentials,
 * options, and outbox tables would orphan on uninstall), so it is politely
 * refused. wp_die() here aborts before WordPress persists the plugin to the
 * network-active list. Single-site activation creates the outbox table.
 *
 * @param bool $network_wide Whether the plugin is being activated network-wide.
 * @return void
 */
function otok_wc_activate( $network_wide ) {
	if ( is_multisite() && $network_wide ) {
		wp_die(
			esc_html__( 'oToK for WooCommerce does not support network activation. Please activate it individually on each site that runs WooCommerce.', 'otok-for-woocommerce' ),
			esc_html__( 'Plugin activation error', 'otok-for-woocommerce' ),
			array( 'back_link' => true )
		);
	}

	require_once __DIR__ . '/includes/class-otok-wc-payloads.php';
	require_once __DIR__ . '/includes/class-otok-wc-outbox.php';
	Otok_WC_Outbox::install();
}
register_activation_hook( __FILE__, 'otok_wc_activate' );

/**
 * Deactivation: best-effort `otok/disconnected` signal + unschedule our
 * Action Scheduler actions.
 *
 * Credentials and queued outbox rows are deliberately KEPT — deactivation is
 * not uninstall, and reactivating resumes delivery where it left off. The
 * disconnected signal (fired BEFORE anything else, once, no retry, failures
 * ignored) lets oToK surface the silent connection; the server tolerates
 * never receiving it.
 *
 * @return void
 */
function otok_wc_deactivate() {
	require_once __DIR__ . '/includes/class-otok-wc-credentials.php';
	require_once __DIR__ . '/includes/class-otok-wc-payloads.php';
	require_once __DIR__ . '/includes/class-otok-wc-outbox.php';
	require_once __DIR__ . '/includes/class-otok-wc-delivery.php';
	require_once __DIR__ . '/includes/class-otok-wc-cart-events.php';

	$credentials = new Otok_WC_Credentials();

	if ( $credentials->is_connected() && $credentials->site_url_matches() ) {
		$delivery = new Otok_WC_Delivery( $credentials, new Otok_WC_Outbox() );
		$delivery->send_disconnected( 'deactivated' );
	}

	// A deactivated plugin's action callbacks are gone, so pending actions
	// would only pile up as no-ops in whatever AS copy keeps running (e.g.
	// WooCommerce's). Reactivation re-schedules everything it needs.
	if ( function_exists( 'as_unschedule_all_actions' ) ) {
		as_unschedule_all_actions( Otok_WC_Delivery::HOOK_DISPATCH );
		as_unschedule_all_actions( Otok_WC_Delivery::HOOK_PURGE );
		as_unschedule_all_actions( Otok_WC_Cart_Events::HOOK_FLUSH );
	}
}
register_deactivation_hook( __FILE__, 'otok_wc_deactivate' );

/**
 * Declare WooCommerce feature compatibility (HPOS + cart/checkout blocks).
 *
 * @return void
 */
function otok_wc_declare_wc_compatibility() {
	if ( ! class_exists( \Automattic\WooCommerce\Utilities\FeaturesUtil::class ) ) {
		return;
	}
	\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', OTOK_WC_PLUGIN_FILE, true );
	\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'cart_checkout_blocks', OTOK_WC_PLUGIN_FILE, true );
}
add_action( 'before_woocommerce_init', 'otok_wc_declare_wc_compatibility' );

/**
 * Load the plugin text domain.
 *
 * Self-distributed plugins get no translate.wordpress.org language packs, so
 * translations ship in /languages and are loaded explicitly. Hooked on `init`
 * because WordPress 6.7+ warns on translation loading before `init`; nothing
 * in this plugin translates earlier than that.
 *
 * @return void
 */
function otok_wc_load_textdomain() {
	load_plugin_textdomain( 'otok-for-woocommerce', false, dirname( plugin_basename( OTOK_WC_PLUGIN_FILE ) ) . '/languages' );
}
add_action( 'init', 'otok_wc_load_textdomain' );

/**
 * Whether the runtime requirements (WooCommerce present and recent enough) are met.
 *
 * @return bool
 */
function otok_wc_requirements_met() {
	return class_exists( 'WooCommerce' )
		&& defined( 'WC_VERSION' )
		&& version_compare( WC_VERSION, OTOK_WC_MIN_WC_VERSION, '>=' );
}

/**
 * Admin notice shown when requirements are not met (the plugin then no-ops, never fatals).
 *
 * @return void
 */
function otok_wc_requirements_notice() {
	if ( ! current_user_can( 'activate_plugins' ) ) {
		return;
	}
	if ( class_exists( 'WooCommerce' ) ) {
		$message = sprintf(
			/* translators: 1: required WooCommerce version, 2: detected WooCommerce version. */
			__( 'oToK for WooCommerce requires WooCommerce %1$s or newer (version %2$s detected). The plugin will not do anything until WooCommerce is updated.', 'otok-for-woocommerce' ),
			OTOK_WC_MIN_WC_VERSION,
			defined( 'WC_VERSION' ) ? WC_VERSION : _x( 'unknown', 'detected WooCommerce version fallback', 'otok-for-woocommerce' )
		);
	} else {
		$message = sprintf(
			/* translators: %s: required WooCommerce version. */
			__( 'oToK for WooCommerce requires WooCommerce (%s or newer) to be installed and active. The plugin will not do anything until then.', 'otok-for-woocommerce' ),
			OTOK_WC_MIN_WC_VERSION
		);
	}
	printf( '<div class="notice notice-warning"><p>%s</p></div>', esc_html( $message ) );
}

/**
 * Bootstrap the plugin once all plugins are loaded.
 *
 * @return void
 */
function otok_wc_bootstrap() {
	if ( ! otok_wc_requirements_met() ) {
		add_action( 'admin_notices', 'otok_wc_requirements_notice' );
		return;
	}

	require_once OTOK_WC_PLUGIN_DIR . 'includes/class-otok-wc-plugin.php';

	Otok_WC_Plugin::instance();
}
add_action( 'plugins_loaded', 'otok_wc_bootstrap' );
