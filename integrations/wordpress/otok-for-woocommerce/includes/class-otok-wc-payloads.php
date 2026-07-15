<?php
/**
 * Wire payload serializers — the ONE module that knows envelope + data shapes.
 *
 * @package OtokWC
 */

defined( 'ABSPATH' ) || exit;

/**
 * Builds every wire payload the plugin sends to oToK.
 *
 * FROZEN SHAPES — read before editing or depending on field names
 * -----------------------------------------------------------------------
 * The envelope, topic vocabulary and every `data` payload shape below
 * conform to the normative oToK e-commerce wire contract.
 * Changes require a coordinated version bump on both sides.
 * ALL serializers live in this single class so a contract change is a
 * one-file diff. Do not construct wire payloads anywhere else.
 *
 * Envelope contract (frozen):
 *   { "event_id":    uuid4 — minted at ENQUEUE, stable across retries
 *                    (it is the server's dedupe key; a new snapshot after
 *                    enqueue is a NEW event with a NEW event_id),
 *     "type":        one of the frozen topics below,
 *     "occurred_at": ISO-8601 UTC — stamped at enqueue, immutable across
 *                    retries (only the signature timestamp is re-minted
 *                    per delivery attempt),
 *     "data":        topic-specific payload }
 */
class Otok_WC_Payloads {

	/**
	 * Frozen topic vocabulary (the `type` discriminator on the shared
	 * WooCommerce ingest route — these exact strings are agreed as part of
	 * the oToK e-commerce contract and must not drift).
	 */
	const TOPIC_CONSENT_UPDATED = 'otok/consent_updated';
	const TOPIC_CART_CREATED    = 'otok/cart_created';
	const TOPIC_CART_UPDATED    = 'otok/cart_updated';
	const TOPIC_ORDER_CREATED   = 'otok/order_created';
	const TOPIC_ORDER_UPDATED   = 'otok/order_updated';
	const TOPIC_DISCONNECTED    = 'otok/disconnected';

	/**
	 * All frozen topics, for enqueue-time validation.
	 *
	 * @return string[]
	 */
	public static function topics() {
		return array(
			self::TOPIC_CONSENT_UPDATED,
			self::TOPIC_CART_CREATED,
			self::TOPIC_CART_UPDATED,
			self::TOPIC_ORDER_CREATED,
			self::TOPIC_ORDER_UPDATED,
			self::TOPIC_DISCONNECTED,
		);
	}

	/**
	 * Whether a topic belongs to the frozen vocabulary.
	 *
	 * @param string $topic Candidate topic string.
	 * @return bool
	 */
	public static function is_known_topic( $topic ) {
		return in_array( (string) $topic, self::topics(), true );
	}

	/**
	 * Microsecond-resolution ISO-8601 UTC timestamp for `occurred_at`.
	 *
	 * One-second gmdate('c') resolution cannot order two events enqueued for
	 * the same order in the same second (classic checkout enqueues
	 * order_created and the gateway's paid order_updated in one request), and
	 * the delivery worker can reorder rows on retry — sub-second occurred_at
	 * lets the server apply last-writer-wins deterministically.
	 *
	 * @return string e.g. "2026-07-14T10:00:00.123456+00:00".
	 */
	public static function now_iso8601() {
		$now   = microtime( true );
		$secs  = (int) floor( $now );
		$micro = (int) floor( ( $now - $secs ) * 1000000 );

		return gmdate( 'Y-m-d\TH:i:s', $secs ) . sprintf( '.%06d', $micro ) . '+00:00';
	}

	/**
	 * Build the delivery envelope around a data payload.
	 *
	 * @param string $event_id    UUID4 minted at enqueue time.
	 * @param string $topic       One of the TOPIC_* constants.
	 * @param string $occurred_at ISO-8601 UTC timestamp stamped at enqueue time.
	 * @param array  $data        Topic-specific payload.
	 * @return array Envelope ready for wp_json_encode().
	 */
	public static function envelope( $event_id, $topic, $occurred_at, $data ) {
		return array(
			'event_id'    => (string) $event_id,
			'type'        => (string) $topic,
			'occurred_at' => (string) $occurred_at,
			'data'        => (array) $data,
		);
	}

	/**
	 * Frozen financial_status vocabulary (wire contract). The plugin never
	 * emits `partially_paid` — it is unreachable from WooCommerce core.
	 */
	const FIN_PENDING            = 'pending';
	const FIN_PAID               = 'paid';
	const FIN_REFUNDED           = 'refunded';
	const FIN_PARTIALLY_REFUNDED = 'partially_refunded';
	const FIN_VOIDED             = 'voided';

	/**
	 * Format a money value as a decimal string (frozen money rule: ALL money
	 * values on the wire are decimal strings, plain dot, no thousands
	 * separators).
	 *
	 * The default precision is floored at 2: wc_get_price_decimals() is the
	 * store's DISPLAY setting, and a zero-decimal-base store (JPY/HUF/KRW)
	 * running a multicurrency plugin would otherwise truncate real cents off
	 * USD/EUR amounts (10.99 → "11"). Extra trailing zeros on genuinely
	 * zero-decimal currencies are merely nonstandard, never wrong.
	 *
	 * @param mixed    $value    Numeric amount.
	 * @param int|null $decimals Decimal places; null = max(2, the store's
	 *                           price decimals) (2 when WC is unavailable).
	 * @return string
	 */
	public static function money( $value, $decimals = null ) {
		if ( null === $decimals ) {
			$decimals = max( 2, function_exists( 'wc_get_price_decimals' ) ? (int) wc_get_price_decimals() : 2 );
		}

		return number_format( (float) $value, max( 0, (int) $decimals ), '.', '' );
	}

	/**
	 * Map a WooCommerce order status (+ refund totals) onto the frozen
	 * financial_status vocabulary.
	 *
	 * Frozen mapping: pending/on-hold → pending; processing/completed → paid;
	 * refunded → refunded; a recorded partial refund → partially_refunded;
	 * failed → voided; cancelled → voided (the producer adds `cancelled_at`).
	 * Unknown/custom statuses map to `pending` — the raw status always rides
	 * along as `platform_status`, so the server loses nothing.
	 *
	 * @param string $platform_status Woo order status (with or without the `wc-` prefix).
	 * @param float  $total           Order grand total.
	 * @param float  $total_refunded  Sum of recorded refunds.
	 * @return string One of the FIN_* constants.
	 */
	public static function map_financial_status( $platform_status, $total, $total_refunded ) {
		$status = (string) preg_replace( '/^wc-/', '', (string) $platform_status );

		if ( 'cancelled' === $status || 'failed' === $status ) {
			return self::FIN_VOIDED;
		}

		$total_refunded = (float) $total_refunded;
		if ( $total_refunded > 0 ) {
			// Remaining-total detection: a full refund may briefly precede the
			// automatic status flip to `refunded`, so derive from the money.
			return ( (float) $total - $total_refunded ) <= 0.005 ? self::FIN_REFUNDED : self::FIN_PARTIALLY_REFUNDED;
		}

		if ( 'refunded' === $status ) {
			return self::FIN_REFUNDED;
		}

		if ( 'processing' === $status || 'completed' === $status ) {
			return self::FIN_PAID;
		}

		// pending, on-hold, and any unknown/custom status.
		return self::FIN_PENDING;
	}

	/**
	 * Data payload for `otok/consent_updated` (wire contract §4).
	 *
	 * Emitted at order-processed time from the captured consent order meta.
	 * `consent_source` attaches ONLY when the consent is `granted` — the wire
	 * contract's seam note: a real source is what lets the server record
	 * basis express_opt_in.
	 *
	 * `phone` is E.164-canonicalized against `country` (billing country,
	 * alpha-2) and omitted when it cannot be canonicalized — see
	 * canonicalize_phone(). The country ALSO rides the optional Woo-style
	 * `billing` enrichment object as `billing.country` (contract §4/§7):
	 * belt-and-suspenders that lets the server canonicalize a national-format
	 * phone; the plugin's E.164-or-omit rule is unchanged.
	 *
	 * @param array $args {email, consent (granted|not_granted), consent_source,
	 *                    consented_at, phone?, country?, first_name?, last_name?}.
	 * @return array
	 */
	public static function consent_updated( $args ) {
		$data = array(
			'email' => (string) $args['email'],
		);

		$country = strtoupper( trim( isset( $args['country'] ) ? (string) $args['country'] : '' ) );

		$phone = self::canonicalize_phone(
			isset( $args['phone'] ) ? $args['phone'] : '',
			$country
		);
		if ( '' !== $phone ) {
			$data['phone'] = $phone;
		}

		if ( 1 === preg_match( '/^[A-Z]{2}$/', $country ) ) {
			$data['billing'] = array( 'country' => $country );
		}

		foreach ( array( 'first_name', 'last_name' ) as $optional ) {
			if ( ! empty( $args[ $optional ] ) ) {
				$data[ $optional ] = (string) $args[ $optional ];
			}
		}

		$data['email_consent'] = ( 'granted' === $args['consent'] ) ? 'granted' : 'not_granted';

		if ( 'granted' === $data['email_consent'] && ! empty( $args['consent_source'] ) ) {
			$data['consent_source'] = (string) $args['consent_source'];
		}

		$data['consented_at'] = (string) $args['consented_at'];

		return $data;
	}

	/**
	 * Data payload for `otok/cart_created` / `otok/cart_updated` (wire
	 * contract §5). Raw cart snapshots only — abandonment is decided
	 * server-side.
	 *
	 * The normative cart shape carries top-level `total` + `currency`. The
	 * `totals` breakdown sub-object rides along as a tolerated extra
	 * (contract §2: unknown extra fields are ignored, never an error): on
	 * tax-inclusive-price stores the items' tax-exclusive unit prices never
	 * sum to the tax-inclusive grand total, so the tax/discount/shipping
	 * breakdown is what lets the server reconcile (and render) the cart.
	 *
	 * `recovery_url` is the store's checkout URL (v1 limitation: WooCommerce
	 * carts are session-bound, so there is no per-cart restore link to send).
	 *
	 * @param array $args {cart_token, contact (email?/phone?/country? — see
	 *                    contact()), items (raw item
	 *                    tuples, see items()), totals (subtotal/discount/
	 *                    shipping/tax/total), currency, recovery_url,
	 *                    updated_at}.
	 * @return array
	 */
	public static function cart( $args ) {
		$totals = self::totals(
			isset( $args['totals'] ) ? (array) $args['totals'] : array(),
			isset( $args['currency'] ) ? $args['currency'] : ''
		);

		return array(
			'cart_token'   => (string) $args['cart_token'],
			'contact'      => self::contact( isset( $args['contact'] ) ? (array) $args['contact'] : array() ),
			'items'        => self::items( isset( $args['items'] ) ? (array) $args['items'] : array() ),
			'total'        => $totals['total'],
			'currency'     => $totals['currency'],
			'totals'       => $totals,
			'recovery_url' => (string) $args['recovery_url'],
			'updated_at'   => (string) $args['updated_at'],
		);
	}

	/**
	 * Data payload for `otok/order_created` / `otok/order_updated` (wire
	 * contract §6).
	 *
	 * Frozen money rules: `totals.subtotal` = sum of pre-discount
	 * tax-exclusive line subtotals; `totals.total` = the grand total
	 * including tax + shipping − discounts; every value a decimal string.
	 * NOTE (carried to the framework): the subtotal equation must be
	 * validated with a per-line tolerance, not exact equality — a derived
	 * unit_price (line subtotal / qty, e.g. 10.00 / 3) is not finitely
	 * representable at any fixed precision; the exact per-line amount rides
	 * `line_subtotal`.
	 *
	 * `sequence` is a per-order monotonic counter (order meta, incremented on
	 * every emission — a tolerated extra beyond the contract shape) so the
	 * server can apply last-writer-wins even when retries deliver events out
	 * of order. `cart_token` (when present) names the cart this order
	 * concluded (contract §6 — the completion join key), letting the server
	 * tombstone the purchased cart in the abandoned-cart pipeline — including
	 * carts stranded by failed payment retries; omitted entirely when unknown
	 * (admin-created orders, untracked carts).
	 *
	 * `updated_at` is the order's last-modified instant (ISO-8601 UTC) — the
	 * server's out-of-order/stale-webhook guard keys on it and it must be
	 * monotonic per order. `refunds` lists every recorded refund to date as
	 * {refund_id, amount, created_at}; `refund_id` is the stable WooCommerce
	 * refund id (stringified) the server's refund-idempotency claims key on,
	 * `amount` a POSITIVE decimal string. The `contact` sub-object carries NO
	 * consent fields — consent authority on the plugin path is exclusively
	 * `otok/consent_updated`, so an order payload never pre-empts a
	 * shown-but-unchecked checkbox.
	 *
	 * @param array $args {external_order_id, order_number, sequence, contact,
	 *                    items, totals (subtotal/discount/shipping/tax/total/
	 *                    total_refunded?), currency, coupon_codes, refunds?
	 *                    ({refund_id, amount, created_at} tuples),
	 *                    financial_status, platform_status, created_at,
	 *                    updated_at, cancelled_at?, cart_token?}.
	 * @return array
	 */
	public static function order( $args ) {
		$data = array(
			'external_order_id' => (string) $args['external_order_id'],
			'order_number'      => (string) $args['order_number'],
			'sequence'          => (int) ( isset( $args['sequence'] ) ? $args['sequence'] : 0 ),
			'contact'           => self::contact( isset( $args['contact'] ) ? (array) $args['contact'] : array() ),
			'items'             => self::items( isset( $args['items'] ) ? (array) $args['items'] : array() ),
			'totals'            => self::totals( (array) $args['totals'], $args['currency'] ),
			'coupon_codes'      => array_values( array_map( 'strval', isset( $args['coupon_codes'] ) ? (array) $args['coupon_codes'] : array() ) ),
			'refunds'           => self::refunds( isset( $args['refunds'] ) ? (array) $args['refunds'] : array() ),
			'financial_status'  => (string) $args['financial_status'],
			'platform_status'   => (string) $args['platform_status'],
			'created_at'        => (string) $args['created_at'],
			'updated_at'        => (string) $args['updated_at'],
		);

		if ( ! empty( $args['cart_token'] ) ) {
			$data['cart_token'] = (string) $args['cart_token'];
		}

		if ( ! empty( $args['cancelled_at'] ) ) {
			$data['cancelled_at'] = (string) $args['cancelled_at'];
		}

		return $data;
	}

	/**
	 * Shared totals sub-object (orders + carts): every value a decimal string.
	 * `total_refunded` attaches only when the producer supplies it (orders —
	 * so a partial-refund event carries HOW MUCH came back, not just that it
	 * did).
	 *
	 * @param array  $totals   Raw amounts {subtotal, discount, shipping, tax,
	 *                         total, total_refunded?}.
	 * @param string $currency ISO currency code.
	 * @return array
	 */
	private static function totals( $totals, $currency ) {
		$out = array(
			'subtotal' => self::money( isset( $totals['subtotal'] ) ? $totals['subtotal'] : 0 ),
			'discount' => self::money( isset( $totals['discount'] ) ? $totals['discount'] : 0 ),
			'shipping' => self::money( isset( $totals['shipping'] ) ? $totals['shipping'] : 0 ),
			'tax'      => self::money( isset( $totals['tax'] ) ? $totals['tax'] : 0 ),
			'total'    => self::money( isset( $totals['total'] ) ? $totals['total'] : 0 ),
			'currency' => (string) $currency,
		);

		if ( isset( $totals['total_refunded'] ) ) {
			$out['total_refunded'] = self::money( $totals['total_refunded'] );
		}

		return $out;
	}

	/**
	 * Refund list for the order payload (wire-contract addition, 2026-07-14
	 * contract addendum): one row per recorded refund —
	 * {refund_id, amount, created_at}. `refund_id` is the stable WooCommerce
	 * refund id (stringified) the server's refund-idempotency claims key on;
	 * `amount` is a POSITIVE decimal string (frozen money rule — normalized
	 * with abs() so a producer handing over Woo's negative refund totals can
	 * never flip the sign on the wire); `created_at` ISO-8601 UTC.
	 *
	 * @param array $refunds Raw tuples {refund_id, amount, created_at}.
	 * @return array[]
	 */
	private static function refunds( $refunds ) {
		$out = array();

		foreach ( (array) $refunds as $refund ) {
			$out[] = array(
				'refund_id'  => (string) $refund['refund_id'],
				'amount'     => self::money( abs( (float) $refund['amount'] ) ),
				'created_at' => (string) $refund['created_at'],
			);
		}

		return $out;
	}

	/**
	 * E.164 shape: "+", a non-zero first digit, 8–15 digits total.
	 */
	const E164_REGEX = '/^\+[1-9]\d{7,14}$/';

	/**
	 * Curated trunk-rule country tables (E.164 contract addition, 2026-07-14)
	 * — confidence over coverage: a country appears here
	 * only when its national→E.164 rule is unambiguous. Everything else
	 * OMITS the phone (email remains the primary identity, so omission is
	 * always safe; a wrong guess is not). Extend these lists as rules are
	 * verified — or rescue per-store via the `otok_wc_canonicalize_phone`
	 * filter.
	 *
	 * NANP (US/CA): a 10-digit national number matching the NANP structure
	 * (area code and exchange each start 2–9) — "+1" + digits. The common
	 * 11-digit "1" + 10 form (the country code typed without "+") is
	 * unambiguous and accepted by stripping the leading 1 first.
	 */
	const NANP_COUNTRIES = array( 'US', 'CA' );

	/**
	 * Countries whose national trunk prefix is a single leading "0" that is
	 * DROPPED in E.164 (then the country calling code is prepended).
	 */
	const TRUNK_ZERO_DROP_COUNTRIES = array( 'IL', 'GB', 'DE', 'FR', 'NL', 'AU', 'AT', 'BE', 'CH', 'SE', 'TR', 'ZA', 'NZ', 'IE', 'RO' );

	/**
	 * Countries whose national trunk prefix is "06" (both characters dropped
	 * in E.164): Hungary per the NMHH numbering plan — domestic dialing is
	 * 06 + area code + number. A single leading "0" NOT followed by 6 is
	 * malformed there and the phone is omitted.
	 */
	const TRUNK_ZERO_SIX_DROP_COUNTRIES = array( 'HU' );

	/**
	 * Countries with NO national trunk prefix at all (closed plans — ES/DK/NO,
	 * or the prefix was abolished/absorbed — PL/GR/CZ): the calling code is
	 * prepended to the national number as-is. A leading "0" can never be a
	 * trunk prefix here — it is a hard signal of malformed input, so the
	 * phone is omitted rather than "fixed" into a plausible-but-wrong number.
	 */
	const NO_TRUNK_PREFIX_COUNTRIES = array( 'ES', 'DK', 'NO', 'PL', 'GR', 'CZ' );

	/**
	 * Countries whose leading "0" is KEPT in E.164: Italian geographic
	 * numbers keep their leading 0 (mobiles have none) — the calling code is
	 * prepended to the national number as-is (see national_to_e164() for the
	 * length-gated own-calling-code handling this class needs).
	 */
	const TRUNK_ZERO_KEEP_COUNTRIES = array( 'IT' );

	/**
	 * Maximum digits of a plausible Italian national number WITHOUT a leading
	 * zero: mobiles are 9–10 digits starting "3" (ITU/AGCOM plan); geographic
	 * numbers keep their leading 0, so they never collide with this bound.
	 * Above it, a digit string starting with Italy's own calling code ("39")
	 * can only be the country code typed without "+".
	 */
	const IT_NATIONAL_MAX_DIGITS = 10;

	/**
	 * Canonicalize a raw phone into E.164, or return '' (= OMIT it).
	 *
	 * E.164 CONTRACT ADDITION (STABLE, oToK e-commerce contract 2026-07-14): ALL
	 * phone values in otok/* payloads (consent contact, cart contact, order
	 * contact) MUST be E.164 or be OMITTED entirely. The envelope has no
	 * country field, so the server DROPS un-canonicalizable phones rather
	 * than guess — omitting client-side loses nothing and keeps the payload
	 * honest. Email remains the primary identity; omitting a phone is
	 * always safe.
	 *
	 * Rules, in order:
	 *  - normalize: trim, strip spaces/dashes/dots/parens — but on
	 *    international-prefixed input ("+…"/"00…") a parenthesized trunk
	 *    zero ("+44 (0) 20 …", a very common European convention) is
	 *    deleted FIRST, so the trunk 0 never merges into the digits;
	 *    Italy is the carve-out: its leading 0 is genuinely part of the
	 *    E.164 number, so "(0)" is ambiguous on a +39/0039 input and the
	 *    phone is OMITTED rather than guessed;
	 *  - leading "+": already international — validate and send;
	 *  - leading "00": international with the 00 exit prefix — swap for "+";
	 *  - otherwise (national number): apply the curated trunk rule for the
	 *    billing country (tables above); no country, an uncurated country,
	 *    or a failed post-canonicalization validation ⇒ OMIT.
	 *
	 * The result is filterable via `otok_wc_canonicalize_phone` (args:
	 * canonical-or-empty, raw input, country) so a store can rescue an
	 * uncurated country — but the filtered value is re-validated, so the
	 * E.164-or-omit wire contract holds regardless of what a filter returns.
	 *
	 * @param string $phone   Raw phone as captured (billing field).
	 * @param string $country ISO 3166-1 alpha-2 billing country, '' if unknown.
	 * @return string E.164 phone, or '' when the phone must be omitted.
	 */
	public static function canonicalize_phone( $phone, $country = '' ) {
		$raw = trim( (string) $phone );

		// International "(0)" trunk notation ("+44 (0) 20 7946 0958"): the
		// parenthesized zero is the NATIONAL trunk prefix and must not
		// survive into E.164 — the generic separator strip below would
		// silently merge it into the digits ("+4402079460958", a
		// plausible-but-wrong number). Delete the token on
		// international-prefixed input before stripping separators.
		$paren_trunk_zero = preg_match( '/^(?:\+|00)/', $raw ) && preg_match( '/\(\s*0\s*\)/', $raw );
		$input            = $paren_trunk_zero ? (string) preg_replace( '/\(\s*0\s*\)/', '', $raw ) : $raw;

		$number = (string) preg_replace( '/[\s.\-()]+/u', '', $input );

		$candidate = '';

		if ( str_starts_with( $number, '+' ) ) {
			$candidate = $number;
		} elseif ( str_starts_with( $number, '00' ) ) {
			$candidate = '+' . substr( $number, 2 );
		} elseif ( '' !== $number ) {
			$candidate = self::national_to_e164( $number, strtoupper( (string) $country ) );
		}

		// Italy carve-out for the "(0)" notation: an Italian leading 0 is
		// genuinely part of the E.164 number (never a trunk prefix), so a
		// "+39 (0)…" input is ambiguous — omit rather than guess ("+379…"
		// Vatican does not match the "+39" prefix).
		if ( $paren_trunk_zero && str_starts_with( $candidate, '+39' ) ) {
			$candidate = '';
		}

		if ( ! preg_match( self::E164_REGEX, $candidate ) ) {
			$candidate = '';
		}

		/**
		 * Filter the canonicalized phone before it is emitted on the wire.
		 *
		 * Runs on every outcome — including '' (omitted) — so a store whose
		 * country is not in the curated tables can supply its own rule. The
		 * returned value is re-validated against the E.164 shape; anything
		 * invalid is omitted.
		 *
		 * @param string $candidate Canonical E.164 phone, or '' when omitted.
		 * @param string $raw       The raw phone as captured.
		 * @param string $country   ISO 3166-1 alpha-2 billing country ('' if unknown).
		 */
		$candidate = (string) apply_filters( 'otok_wc_canonicalize_phone', $candidate, $raw, (string) $country );

		return preg_match( self::E164_REGEX, $candidate ) ? $candidate : '';
	}

	/**
	 * Apply the curated trunk rule for a national (no +/00 prefix) number.
	 *
	 * @param string $number  Separator-stripped national number.
	 * @param string $country Uppercased ISO 3166-1 alpha-2 country.
	 * @return string "+"-prefixed candidate, or '' when no curated rule applies.
	 */
	private static function national_to_e164( $number, $country ) {
		if ( '' === $country || ! ctype_digit( $number ) ) {
			return '';
		}

		if ( in_array( $country, self::NANP_COUNTRIES, true ) ) {
			if ( 11 === strlen( $number ) && str_starts_with( $number, '1' ) ) {
				$number = substr( $number, 1 ); // Country code typed without "+".
			}

			// NANP structure: area code and exchange each start 2-9 — a
			// 10-digit string failing this (e.g. a leading 0) is not a NANP
			// number and must be omitted, not shipped as "+1…".
			return preg_match( '/^[2-9]\d{2}[2-9]\d{6}$/', $number ) ? '+1' . $number : '';
		}

		if ( in_array( $country, self::TRUNK_ZERO_DROP_COUNTRIES, true ) ) {
			return self::prefix_national(
				str_starts_with( $number, '0' ) ? substr( $number, 1 ) : $number,
				$country
			);
		}

		if ( in_array( $country, self::TRUNK_ZERO_SIX_DROP_COUNTRIES, true ) ) {
			if ( str_starts_with( $number, '06' ) ) {
				$number = substr( $number, 2 );
			} elseif ( str_starts_with( $number, '0' ) ) {
				// A lone leading 0 is not Hungary's trunk prefix — malformed.
				return '';
			}

			return self::prefix_national( $number, $country );
		}

		if ( in_array( $country, self::NO_TRUNK_PREFIX_COUNTRIES, true ) ) {
			// No trunk prefix exists to drop: a leading 0 is malformed input,
			// never a prefix to launder into a plausible-but-wrong number.
			return str_starts_with( $number, '0' ) ? '' : self::prefix_national( $number, $country );
		}

		if ( in_array( $country, self::TRUNK_ZERO_KEEP_COUNTRIES, true ) ) {
			$code = self::calling_code( $country );
			if ( '' === $code ) {
				return '';
			}

			// Italy does NOT ride prefix_national()'s own-calling-code guard:
			// 390–393 are REAL Italian mobile prefixes and Italian mobiles are
			// 9–10 digits, so a 10-digit national starting "39" is almost
			// certainly a genuine mobile — the generic guard (calling code +
			// ≥8 digits) would false-omit every one of them, Italy's calling
			// code being "39" itself. Instead the guard is length-gated: a
			// national within the plausible zero-less national length is
			// prefixed as-is; only a LONGER digit string starting "39" reads
			// as the country code typed without "+" and is accepted as
			// already-international (the E.164 shape check in
			// canonicalize_phone() still omits an invalid result).
			$cc = substr( $code, 1 );
			if ( str_starts_with( $number, $cc ) && strlen( $number ) > self::IT_NATIONAL_MAX_DIGITS ) {
				return '+' . $number;
			}

			return $code . $number;
		}

		return '';
	}

	/**
	 * Prepend the country calling code to a trunk-handled national number —
	 * unless the digits already READ as a complete international number:
	 * the country's own calling code followed by a full subscriber number
	 * (a customer typing "44 20 7946 0958" without "+"). Prepending again
	 * would double the calling code ("+44442079460958") and still pass the
	 * E.164 shape check, so such numbers are OMITTED (omit-over-guess).
	 * Genuine national numbers that merely start with the calling-code
	 * digits stay under the calling-code + 8-digit length floor.
	 *
	 * @param string $number  National number after trunk-prefix handling.
	 * @param string $country Uppercased ISO 3166-1 alpha-2 country.
	 * @return string "+"-prefixed candidate, or '' when the number must be omitted.
	 */
	private static function prefix_national( $number, $country ) {
		$code = self::calling_code( $country );
		if ( '' === $code ) {
			return '';
		}

		$cc = substr( $code, 1 );
		if ( str_starts_with( $number, $cc ) && strlen( $number ) >= strlen( $cc ) + 8 ) {
			return '';
		}

		return $code . $number;
	}

	/**
	 * Country calling code via WooCommerce, normalized to "+digits".
	 *
	 * WC_Countries::get_country_calling_code() is docblocked string|array
	 * ("some countries have multiple") — current WooCommerce collapses
	 * multi-code entries to the first element itself, but handle an array
	 * defensively and take the first. Unknown country ⇒ ''.
	 *
	 * @param string $country Uppercased ISO 3166-1 alpha-2 country.
	 * @return string "+"-prefixed calling code, or '' when unavailable.
	 */
	private static function calling_code( $country ) {
		if ( ! function_exists( 'WC' ) || empty( WC()->countries ) || ! is_callable( array( WC()->countries, 'get_country_calling_code' ) ) ) {
			return '';
		}

		$code = WC()->countries->get_country_calling_code( $country );
		if ( is_array( $code ) ) {
			$code = reset( $code );
		}

		$code = (string) preg_replace( '/[^0-9]/', '', (string) $code );

		return ( '' === $code ) ? '' : '+' . $code;
	}

	/**
	 * Contact sub-object: optional identity fields, empty values dropped.
	 * Cast to object so an identity-less contact serializes as `{}`, never `[]`.
	 *
	 * `phone` is E.164-canonicalized against the accompanying `country`
	 * (billing country, alpha-2 — a canonicalization INPUT consumed here,
	 * never emitted) and omitted when it cannot be canonicalized — see
	 * canonicalize_phone().
	 *
	 * @param array $contact Raw contact fields (email/phone/country/first_name/last_name).
	 * @return object
	 */
	private static function contact( $contact ) {
		$out = array();

		foreach ( array( 'email', 'phone', 'first_name', 'last_name' ) as $field ) {
			if ( 'phone' === $field ) {
				$phone = self::canonicalize_phone(
					isset( $contact['phone'] ) ? $contact['phone'] : '',
					isset( $contact['country'] ) ? $contact['country'] : ''
				);

				if ( '' !== $phone ) {
					$out['phone'] = $phone;
				}

				continue;
			}

			if ( ! empty( $contact[ $field ] ) ) {
				$out[ $field ] = (string) $contact[ $field ];
			}
		}

		return (object) $out;
	}

	/**
	 * Line-item list: maps raw producer tuples onto the shared wire item
	 * shape (contract §5/§6): `external_id` (the stable line-item id — Woo
	 * order-item id / cart-item key), `external_product_id`, `sku`, `title`,
	 * `qty`, `unit_price`. `unit_price` is tax-exclusive by the frozen money
	 * rule; `line_subtotal` is a tolerated extra carrying the EXACT
	 * pre-discount tax-exclusive line amount (unit_price is a derived,
	 * rounded convenience — "3 for 10.00" cannot round-trip through
	 * unit_price × qty at fixed precision). `qty` is emitted as a JSON number
	 * and may be fractional (decimal-quantity plugins: 0.5 kg is 0.5, never
	 * truncated to 0 — a deliberate, documented deviation from the contract's
	 * integer wording; core stores always emit integers).
	 *
	 * @param array $items Raw tuples {external_id?, product_id, sku, title,
	 *                     qty, unit_price, line_subtotal?}.
	 * @return array[]
	 */
	private static function items( $items ) {
		$out = array();

		foreach ( (array) $items as $item ) {
			$row = array();

			if ( ! empty( $item['external_id'] ) ) {
				$row['external_id'] = (string) $item['external_id'];
			}

			$row['external_product_id'] = (string) ( isset( $item['product_id'] ) ? $item['product_id'] : '' );

			if ( ! empty( $item['sku'] ) ) {
				$row['sku'] = (string) $item['sku'];
			}

			$qty = (float) $item['qty'];

			$row['title']      = (string) $item['title'];
			$row['qty']        = ( (float) (int) $qty === $qty ) ? (int) $qty : $qty;
			$row['unit_price'] = self::money( $item['unit_price'] );

			if ( isset( $item['line_subtotal'] ) ) {
				$row['line_subtotal'] = self::money( $item['line_subtotal'] );
			}

			$out[] = $row;
		}

		return $out;
	}

	/**
	 * Data payload for `otok/disconnected` (best-effort, fire-once).
	 *
	 * Sent when the plugin is deactivated or the store owner disconnects in
	 * the plugin settings — BEFORE local credentials are wiped — so oToK can
	 * mark the connection dead (and surface reconnect UX) server-side. The
	 * server tolerates never receiving it.
	 *
	 * @param string $reason Why the connection ended: 'deactivated' or 'disconnected'.
	 * @return array
	 */
	public static function disconnected( $reason ) {
		return array(
			'reason'   => ( 'deactivated' === $reason ) ? 'deactivated' : 'disconnected',
			'site_url' => site_url(),
		);
	}
}
