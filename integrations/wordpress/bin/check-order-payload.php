<?php
/**
 * Payload shape checks against the frozen wire contract
 * (docs/integrations/otok-wc-plugin-contract.md in the oToK repo):
 * `updated_at` + `refunds[]` on order payloads, the confirmation that order
 * contacts carry NO consent fields (consent authority on the plugin path is
 * exclusively otok/consent_updated), the `cart_token` completion join key
 * (present when the order concluded a tracked cart, omitted entirely when
 * unknown), the consent payload's optional `billing.country` enrichment,
 * the cart payload's normative top-level `total` + `currency`, and the
 * shared line-item `external_id`.
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

// cart_token (contract §6): the completion join key — present verbatim when
// the order concluded a tracked cart, OMITTED ENTIRELY when unknown
// (admin-created orders, untracked carts). Never null, never ''.
$payload = Otok_WC_Payloads::order( $base );
check( 'cart_token omitted when unknown', ! array_key_exists( 'cart_token', $payload ) );

$with_token               = $base;
$with_token['cart_token'] = '11111111-1111-4111-8111-111111111111';

$payload = Otok_WC_Payloads::order( $with_token );
check( 'cart_token carried verbatim', '11111111-1111-4111-8111-111111111111' === ( isset( $payload['cart_token'] ) ? $payload['cart_token'] : null ) );

$with_empty_token               = $base;
$with_empty_token['cart_token'] = '';

$payload = Otok_WC_Payloads::order( $with_empty_token );
check( 'empty cart_token omitted, not sent blank', ! array_key_exists( 'cart_token', $payload ) );

// Line items (contract §5/§6 shared shape): `external_id` = the stable
// line-item id, carried when the producer supplies one.
check( 'item external_id absent when producer has none', ! array_key_exists( 'external_id', $payload['items'][0] ) );

$with_item_id                            = $base;
$with_item_id['items'][0]['external_id'] = 88;

$payload = Otok_WC_Payloads::order( $with_item_id );
check( 'item external_id stringified', '88' === ( isset( $payload['items'][0]['external_id'] ) ? $payload['items'][0]['external_id'] : null ) );
check( 'item external_product_id preserved alongside', '7' === $payload['items'][0]['external_product_id'] );

// Consent payload (contract §4/§7): the billing country rides the optional
// `billing` enrichment object as `billing.country` (server-side
// belt-and-suspenders for phone canonicalization); omitted entirely when the
// country is unknown or not alpha-2. E.164-or-omit for `phone` is unchanged.
$consent_base = array(
	'email'          => 'shopper@example.test',
	'phone'          => '+972501234567',
	'consent'        => 'granted',
	'consent_source' => 'checkout_checkbox',
	'consented_at'   => '2026-07-14T10:00:00+00:00',
);

$consent = Otok_WC_Payloads::consent_updated( $consent_base );
check( 'consent billing omitted without country', ! array_key_exists( 'billing', $consent ) );
check( 'consent E.164 phone kept without country', '+972501234567' === ( isset( $consent['phone'] ) ? $consent['phone'] : null ) );

$consent = Otok_WC_Payloads::consent_updated( array_merge( $consent_base, array( 'country' => 'IL' ) ) );
check( 'consent billing.country emitted', array( 'country' => 'IL' ) === ( isset( $consent['billing'] ) ? $consent['billing'] : null ) );

$consent = Otok_WC_Payloads::consent_updated( array_merge( $consent_base, array( 'country' => 'il' ) ) );
check( 'consent billing.country uppercased', array( 'country' => 'IL' ) === ( isset( $consent['billing'] ) ? $consent['billing'] : null ) );

$consent = Otok_WC_Payloads::consent_updated( array_merge( $consent_base, array( 'country' => 'ISR' ) ) );
check( 'consent billing omitted for non-alpha-2 country', ! array_key_exists( 'billing', $consent ) );

// Cart payload (contract §5): normative top-level `total` + `currency`
// (decimal string / upper-case ISO 4217); the `totals` breakdown rides along
// as a tolerated extra and must agree with the top-level values.
$cart = Otok_WC_Payloads::cart(
	array(
		'cart_token'   => '22222222-2222-4222-8222-222222222222',
		'contact'      => array( 'email' => 'shopper@example.test' ),
		'items'        => array(
			array(
				'external_id' => 'ci_key_1',
				'product_id'  => 7,
				'sku'         => 'SKU-7',
				'title'       => 'Widget',
				'qty'         => 2,
				'unit_price'  => 5.0,
			),
		),
		'totals'       => array(
			'subtotal' => 10,
			'discount' => 0,
			'shipping' => 0,
			'tax'      => 1.7,
			'total'    => 11.7,
		),
		'currency'     => 'ILS',
		'recovery_url' => 'https://example.test/checkout/',
		'updated_at'   => '2026-07-14T10:00:00+00:00',
	)
);
check( 'cart top-level total is a decimal string', '11.70' === ( isset( $cart['total'] ) ? $cart['total'] : null ) );
check( 'cart top-level currency present', 'ILS' === ( isset( $cart['currency'] ) ? $cart['currency'] : null ) );
check( 'cart totals breakdown agrees with top-level', isset( $cart['totals']['total'], $cart['totals']['currency'] ) && $cart['totals']['total'] === $cart['total'] && $cart['totals']['currency'] === $cart['currency'] );
check( 'cart item external_id carried', 'ci_key_1' === ( isset( $cart['items'][0]['external_id'] ) ? $cart['items'][0]['external_id'] : null ) );
check( 'cart_token required field carried', '22222222-2222-4222-8222-222222222222' === $cart['cart_token'] );

printf( "%d checks, %d failures\n", $count, $fails );
exit( $fails > 0 ? 1 : 0 );
