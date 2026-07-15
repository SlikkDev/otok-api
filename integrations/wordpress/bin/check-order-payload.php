<?php
/**
 * Order-payload shape check — executable check for the wire-contract
 * additions (oToK e-commerce contract addendum 2026-07-14): `updated_at` and
 * `refunds[]` on order payloads, and the frozen confirmation that order
 * contacts carry NO consent fields (consent authority on the plugin path is
 * exclusively otok/consent_updated).
 *
 * Shims the minimal WP surface Otok_WC_Payloads touches, same pattern as
 * check-phone-matrix.php.
 *
 * Run: php bin/check-order-payload.php   (exits non-zero on any failure)
 *
 * Dev tooling — not shipped with the plugin (lives outside
 * otok-for-woocommerce/, like build-zip.sh).
 */

define( 'ABSPATH', '/tmp/' );

// --- Minimal WP shims ---------------------------------------------------------

function apply_filters( $tag, $value, ...$args ) {
	return $value;
}

function site_url() {
	return 'https://example.test';
}

require __DIR__ . '/../otok-for-woocommerce/includes/class-otok-wc-payloads.php';

// --- Checks -------------------------------------------------------------------

$fails = 0;
$count = 0;

function check( $label, $ok ) {
	global $fails, $count;
	$count++;
	if ( ! $ok ) {
		$fails++;
		printf( "FAIL  %s\n", $label );
	}
}

$base = array(
	'external_order_id' => '42',
	'order_number'      => '42',
	'sequence'          => 3,
	'contact'           => array(
		'email'      => 'shopper@example.test',
		'first_name' => 'Ada',
	),
	'items'             => array(
		array(
			'product_id' => 7,
			'sku'        => 'SKU-7',
			'title'      => 'Widget',
			'qty'        => 2,
			'unit_price' => 5.0,
		),
	),
	'totals'            => array(
		'subtotal' => 10,
		'discount' => 0,
		'shipping' => 0,
		'tax'      => 0,
		'total'    => 10,
	),
	'currency'          => 'USD',
	'financial_status'  => 'paid',
	'platform_status'   => 'processing',
	'created_at'        => '2026-07-14T10:00:00+00:00',
	'updated_at'        => '2026-07-14T10:05:00+00:00',
);

$iso8601_utc = '/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?\+00:00$/';

// updated_at: always present, carried verbatim, ISO-8601 UTC shaped.
$payload = Otok_WC_Payloads::order( $base );
check( 'updated_at present', array_key_exists( 'updated_at', $payload ) );
check( 'updated_at carried verbatim', '2026-07-14T10:05:00+00:00' === $payload['updated_at'] );
check( 'updated_at ISO-8601 UTC shape', 1 === preg_match( $iso8601_utc, (string) $payload['updated_at'] ) );
check( 'created_at ISO-8601 UTC shape (regression)', 1 === preg_match( $iso8601_utc, (string) $payload['created_at'] ) );

// refunds: key always present; empty array when the order has none.
check( 'refunds key present without refunds', array_key_exists( 'refunds', $payload ) && array() === $payload['refunds'] );

// refunds: rows carry a stringified stable refund_id, a POSITIVE decimal-string
// amount, and an ISO-8601 UTC created_at.
$with_refunds            = $base;
$with_refunds['refunds'] = array(
	array(
		'refund_id'  => 91,
		'amount'     => 4.5,
		'created_at' => '2026-07-14T11:00:00+00:00',
	),
	array(
		'refund_id'  => '92',
		// Producer defensiveness: Woo stores refund totals negative in some
		// seams — the serializer must normalize the sign, never flip it.
		'amount'     => -5.5,
		'created_at' => '2026-07-14T12:00:00+00:00',
	),
);

$payload = Otok_WC_Payloads::order( $with_refunds );
check( 'two refund rows serialized', isset( $payload['refunds'] ) && 2 === count( $payload['refunds'] ) );
check( 'refund_id stringified', '91' === $payload['refunds'][0]['refund_id'] );
check( 'refund amount is a decimal string', '4.50' === $payload['refunds'][0]['amount'] );
check( 'refund amount normalized positive', '5.50' === $payload['refunds'][1]['amount'] );
check( 'refund created_at carried verbatim', '2026-07-14T11:00:00+00:00' === $payload['refunds'][0]['created_at'] );
check( 'refund created_at ISO-8601 UTC shape', 1 === preg_match( $iso8601_utc, (string) $payload['refunds'][0]['created_at'] ) );

// Frozen confirmation: the order contact carries NO consent fields (or null) —
// consent authority on the plugin path is exclusively otok/consent_updated, so
// an order payload never pre-empts a shown-but-unchecked checkbox.
$contact        = (array) $payload['contact'];
$consent_fields = array( 'consent', 'email_consent', 'consent_source', 'consented_at' );
foreach ( $consent_fields as $field ) {
	check( "order contact carries no {$field}", ! array_key_exists( $field, $contact ) );
}
check( 'order contact fields are identity-only', array() === array_diff( array_keys( $contact ), array( 'email', 'phone', 'first_name', 'last_name' ) ) );

printf( "%d checks, %d failures\n", $count, $fails );
exit( $fails > 0 ? 1 : 0 );
