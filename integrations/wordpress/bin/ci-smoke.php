<?php
/**
 * Runtime smoke assertions — executed INSIDE wp-env by the CI smoke job via
 * `wp eval-file` (the bin/ directory is mapped into the container as
 * wp-content/otok-ci by .wp-env.json). Requires WordPress + WooCommerce
 * loaded with the plugin active; exits non-zero (WP_CLI::error) on any
 * failed assertion.
 *
 * Asserted here: the outbox table exists (activation install ran), the
 * blocks-checkout consent field is registered, and HPOS +
 * cart/checkout-blocks compatibility are declared. Plugin
 * activation/deactivation without fatals is asserted by the workflow's own
 * wp-cli steps around this file.
 *
 * Dev tooling — not shipped with the plugin (lives outside
 * otok-for-woocommerce/, like check-phone-matrix.php).
 */

if ( ! defined( 'WP_CLI' ) || ! WP_CLI ) {
	fwrite( STDERR, "This script must run via `wp eval-file` inside wp-env.\n" );
	exit( 1 );
}

$failures = array();

// (b) The outbox table exists — the activation hook's Otok_WC_Outbox::install() ran.
global $wpdb;
$otok_ci_table = $wpdb->prefix . 'otok_wc_outbox';
if ( $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $otok_ci_table ) ) !== $otok_ci_table ) {
	$failures[] = "outbox table {$otok_ci_table} does not exist (activation install did not run)";
}

// (c) The blocks-checkout consent field is registered with the Additional
// Checkout Fields API (init 20 has fired by the time eval-file runs).
$otok_ci_field_id = 'otok-wc/marketing-consent';
try {
	$otok_ci_fields = Automattic\WooCommerce\Blocks\Package::container()
		->get( Automattic\WooCommerce\Blocks\Domain\Services\CheckoutFields::class )
		->get_additional_fields();

	if ( ! is_array( $otok_ci_fields ) || ! array_key_exists( $otok_ci_field_id, $otok_ci_fields ) ) {
		$failures[] = "blocks checkout field {$otok_ci_field_id} is not registered";
	}
} catch ( Throwable $e ) {
	$failures[] = 'CheckoutFields service unavailable: ' . $e->getMessage();
}

// (d) HPOS + cart/checkout blocks compatibility declared via FeaturesUtil.
$otok_ci_basename = 'otok-for-woocommerce/otok-for-woocommerce.php';
foreach ( array( 'custom_order_tables', 'cart_checkout_blocks' ) as $otok_ci_feature ) {
	$otok_ci_compat = Automattic\WooCommerce\Utilities\FeaturesUtil::get_compatible_plugins_for_feature( $otok_ci_feature );
	$otok_ci_list   = isset( $otok_ci_compat['compatible'] ) ? (array) $otok_ci_compat['compatible'] : array();

	if ( ! in_array( $otok_ci_basename, $otok_ci_list, true ) ) {
		$failures[] = "compatibility with {$otok_ci_feature} is not declared";
	}
}

if ( count( $failures ) > 0 ) {
	foreach ( $failures as $otok_ci_failure ) {
		WP_CLI::warning( $otok_ci_failure );
	}
	WP_CLI::error( count( $failures ) . ' smoke assertion(s) failed.' );
}

WP_CLI::success( 'Runtime smoke assertions passed: outbox table, blocks consent field, HPOS + checkout-blocks compatibility.' );
