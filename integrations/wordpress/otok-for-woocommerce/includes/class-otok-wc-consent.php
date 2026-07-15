<?php
/**
 * Marketing-consent checkbox at checkout.
 *
 * @package OtokWC
 */

defined( 'ABSPATH' ) || exit;

/**
 * Renders the marketing-consent checkbox on BOTH checkout stacks (the
 * Checkout block via the Additional Checkout Fields API, and the classic
 * shortcode checkout via `woocommerce_checkout_fields`) and captures the
 * shopper's decision as normalized order meta at order-processed time. This
 * class is the single capture chokepoint — both stacks funnel into
 * {@see Otok_WC_Consent::capture()}.
 *
 * Consent semantics (frozen wire contract):
 * - Checkbox checked        → `granted`, consent_source `checkout_checkbox`.
 * - Shown but left unchecked → `not_granted` (server-side: leave existing
 *   consent state untouched).
 * - Field not offered at submit time (e.g. removed by a checkout-field-editor
 *   plugin) → NO capture at all: no meta is written, so the event producers emit nothing.
 * - The plugin NEVER produces `denied` or `unknown` — checkout has no
 *   explicit-decline gesture.
 *
 * Headless/Store API interpretation (accepted by design): once registered,
 * the field is part of the published Store API checkout schema, so a
 * headless/custom frontend that never visually renders the checkout block
 * still counts as "offered" — such checkouts record `not_granted`
 * (shown-but-unchecked). Capture is skipped only when the field was not
 * registered at all for that stack.
 *
 * Hard rules (Israel Communications Law §30A + GDPR): the checkbox is ALWAYS
 * shown and ALWAYS starts unchecked. There is deliberately no setting to
 * pre-check it and none may be added.
 *
 * Capture is unconditional — it runs whether or not the store is connected
 * to oToK. The order meta is the store's legal opt-in evidence, valuable
 * even if the connection is only added (or was temporarily removed) later;
 * a connection lookup per checkout would add a failure mode for no benefit.
 * Event emission (`otok/consent_updated`) is the order-event producers' job: they read this order
 * meta, which is the stable seam between capture and delivery. The meta is
 * deliberately retained on uninstall (see uninstall.php).
 */
class Otok_WC_Consent {

	/**
	 * Option holding the store-owner-edited checkbox label ('' / absent = use
	 * the localized default).
	 */
	const OPTION_LABEL = 'otok_wc_consent_label';

	/**
	 * Additional Checkout Fields API field id (blocks checkout). Its value is
	 * stored by WooCommerce under order meta `_wc_other/{id}`. The `otok-wc`
	 * namespace matches the plugin's reserved prefix convention; this id is a
	 * persisted meta key, frozen once real orders carry it.
	 */
	const BLOCKS_FIELD_ID = 'otok-wc/marketing-consent';

	/**
	 * Classic-checkout field key (also the POST key on checkout submit).
	 */
	const CLASSIC_FIELD_KEY = 'otok_wc_marketing_consent';

	/**
	 * Normalized order meta keys — the seam the order-event producers read.
	 * `_otok_wc_consent` is `granted` or `not_granted`; the label meta is the
	 * exact (sanitized) label text shown, kept as consent evidence.
	 *
	 * Event-emission seam note: `_otok_wc_consent_source` records the capture mechanism
	 * for BOTH values, but the wire contract attaches `consent_source` to
	 * `granted` only — event emission must include it on the payload only when
	 * the consent value is `granted`.
	 */
	const META_CONSENT     = '_otok_wc_consent';
	const META_SOURCE      = '_otok_wc_consent_source';
	const META_LABEL       = '_otok_wc_consent_label';
	const META_CAPTURED_AT = '_otok_wc_consent_captured_at';

	/**
	 * Consent values this plugin produces (never `denied`, never `unknown`).
	 */
	const CONSENT_GRANTED     = 'granted';
	const CONSENT_NOT_GRANTED = 'not_granted';

	/**
	 * The consent_source recorded with every capture. A real source string is
	 * what lets the oToK server record basis `express_opt_in` instead of
	 * `imported`.
	 */
	const SOURCE_CHECKOUT_CHECKBOX = 'checkout_checkbox';

	/**
	 * Hard cap on the stored label length: the label becomes order meta on
	 * every order, so it must stay bounded.
	 */
	const LABEL_MAX_LENGTH = 500;

	/**
	 * Whether the blocks field was actually registered on this request. When
	 * registration bailed (API unavailable, `woocommerce_init` not fired), a
	 * Store API checkout never offered the field — capture_blocks() must not
	 * record a signal for a checkbox that could not have been shown.
	 *
	 * @var bool
	 */
	private $blocks_field_registered = false;

	/**
	 * Constructor: wire both checkout stacks into the capture chokepoint.
	 */
	public function __construct() {
		// Blocks-field registration must run after `woocommerce_init` (API
		// requirement) AND after this plugin's textdomain loads on `init` 10,
		// so the localized default label resolves — hence `init` 20, not
		// `woocommerce_init` itself (which fires during `init` 0).
		add_action( 'init', array( $this, 'register_blocks_field' ), 20 );

		add_filter( 'woocommerce_checkout_fields', array( $this, 'add_classic_field' ) );

		// Both stacks capture at order-processed time. For blocks this is the
		// earliest safe point: the additional-field value is saved onto the
		// order during checkout processing and does not exist at order
		// creation. The two hooks are mutually exclusive per order (one per
		// stack); capture() is last-write-wins, so a payment-retry re-fire
		// always records the shopper's current choice.
		add_action( 'woocommerce_checkout_order_processed', array( $this, 'capture_classic' ), 10, 3 );
		add_action( 'woocommerce_store_api_checkout_order_processed', array( $this, 'capture_blocks' ) );
	}

	/**
	 * The localized default checkbox label.
	 *
	 * @return string
	 */
	public function default_label() {
		return __( "I'd like to receive news and offers by email", 'otok-for-woocommerce' );
	}

	/**
	 * The raw stored label option ('' when unset) — for the admin input value.
	 *
	 * @return string
	 */
	public function stored_label() {
		return (string) get_option( self::OPTION_LABEL, '' );
	}

	/**
	 * The label to show at checkout: the store owner's text, or the localized
	 * default. Plain text by contract (save_label() strips everything else);
	 * sinks that emit raw HTML must still escape it.
	 *
	 * @return string
	 */
	public function get_label() {
		$stored = $this->stored_label();
		return '' !== $stored ? $stored : $this->default_label();
	}

	/**
	 * Persist the store-owner-edited label. Plain text only (deliberately no
	 * HTML allowlist — the label is echoed into two different sinks and
	 * snapshotted into order meta, so text keeps every path trivially safe).
	 * An empty value deletes the option, reverting to the localized default.
	 *
	 * @param string $label Raw label input.
	 * @return void
	 */
	public function save_label( $label ) {
		$label = sanitize_text_field( (string) $label );

		if ( mb_strlen( $label ) > self::LABEL_MAX_LENGTH ) {
			$label = mb_substr( $label, 0, self::LABEL_MAX_LENGTH );
		}

		if ( '' === $label ) {
			delete_option( self::OPTION_LABEL );
			return;
		}

		// Autoload on (the default): the label is needed on every checkout render.
		update_option( self::OPTION_LABEL, $label );
	}

	/**
	 * Register the checkbox with the blocks checkout (Additional Checkout
	 * Fields API): order location, optional — `required => false` is the hard
	 * rule, a required checkbox would force consent.
	 *
	 * Location `order` (the order-information step of the Checkout block) is
	 * deliberate: `contact`-location values are persisted to the logged-in
	 * shopper's ACCOUNT, surfaced editable on My Account → Account details
	 * (a consent surface nothing captures), and pre-filled on future
	 * checkouts — a returning opted-in customer would see the box
	 * PRE-CHECKED, violating the always-starts-unchecked hard rule. Order
	 * fields save to the order only; the `_wc_other/{id}` meta key and the
	 * `get_field_from_object( …, 'other' )` read are shared by both
	 * locations, so read_blocks_value() is unaffected.
	 *
	 * @return void
	 */
	public function register_blocks_field() {
		if ( ! function_exists( 'woocommerce_register_additional_checkout_field' ) || ! did_action( 'woocommerce_init' ) ) {
			return;
		}

		woocommerce_register_additional_checkout_field(
			array(
				'id'       => self::BLOCKS_FIELD_ID,
				'label'    => $this->get_label(),
				'location' => 'order',
				'type'     => 'checkbox',
				'required' => false,
			)
		);

		$this->blocks_field_registered = true;
	}

	/**
	 * Add the checkbox to the classic (shortcode) checkout. The Additional
	 * Checkout Fields API is blocks-only, so the classic stack needs its own
	 * field. Billing priority 111 places it directly after the email field
	 * (billing_email is 110) — the classic equivalent of the contact area.
	 *
	 * @param array $fields Checkout fields (sections => fields).
	 * @return array
	 */
	public function add_classic_field( $fields ) {
		if ( ! is_array( $fields ) ) {
			return $fields;
		}

		$fields['billing'][ self::CLASSIC_FIELD_KEY ] = array(
			'type'     => 'checkbox',
			// woocommerce_form_field() emits checkbox labels unescaped (to
			// allow markup); ours is plain text, escaped here for that sink.
			'label'    => esc_html( $this->get_label() ),
			'required' => false,
			// ALWAYS unchecked by default — hard rule, see class docblock.
			'default'  => 0,
			'priority' => 111,
			'class'    => array( 'form-row-wide', 'otok-wc-consent-field' ),
		);

		return $fields;
	}

	/**
	 * Capture from the classic checkout (`woocommerce_checkout_order_processed`).
	 *
	 * WC_Checkout::get_posted_data() ALWAYS emits a key for every registered
	 * checkbox field (`isset( $_POST[ $key ] ) ? 1 : ''`), so a key present
	 * in $posted_data means the field was registered at submit time: checked
	 * → `granted`, unchecked → `not_granted`. A key absent from BOTH
	 * $posted_data and $_POST means the field was NOT registered when the
	 * shopper submitted (e.g. removed by a later `woocommerce_checkout_fields`
	 * filter) — the checkbox was never shown, so NO capture happens: writing
	 * `not_granted` there would fabricate a "shown but unchecked" signal. The
	 * raw-$_POST branch remains only as a positive fallback for a
	 * filter-rebuilt $posted_data array that dropped the key.
	 *
	 * Order-pay retry path (VERIFIED against WooCommerce core, 2026-07-14):
	 * the checkout/order-pay endpoint (My Account → Pay, offsite-gateway
	 * failure redirects) is handled by WC_Form_Handler::pay_action(), which
	 * fires only woocommerce_before/after_pay_action and never runs
	 * WC_Checkout::process_checkout() — `woocommerce_checkout_order_processed`
	 * fires ONLY inside process_checkout(), i.e. a genuine checkout-form
	 * submission where the checkbox was rendered. This capture therefore
	 * cannot fire in a context where the checkbox was never offered, and a
	 * previously `granted` order cannot be flipped to `not_granted` by a
	 * pay-page retry the shopper had no checkbox on. (An on-checkout payment
	 * failure re-submits the FULL checkout form, checkbox included — that
	 * re-capture is the intended last-write-wins, see capture().)
	 *
	 * @param int      $order_id    Order id (unused; the order object is passed).
	 * @param array    $posted_data Checkout data from WC_Checkout::get_posted_data().
	 * @param WC_Order $order       The processed order.
	 * @return void
	 */
	public function capture_classic( $order_id, $posted_data, $order ) {
		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- WooCommerce verified the woocommerce-process_checkout nonce before firing this hook.
		$raw_post = isset( $_POST[ self::CLASSIC_FIELD_KEY ] ) ? sanitize_text_field( wp_unslash( $_POST[ self::CLASSIC_FIELD_KEY ] ) ) : null;

		if ( is_array( $posted_data ) && array_key_exists( self::CLASSIC_FIELD_KEY, $posted_data ) ) {
			$checked = $this->is_checked_value( $posted_data[ self::CLASSIC_FIELD_KEY ] );
		} elseif ( null !== $raw_post ) {
			$checked = $this->is_checked_value( $raw_post );
		} else {
			// Field not registered at submit time — never shown, no signal.
			return;
		}

		$this->capture( $order, $checked );
	}

	/**
	 * Capture from the blocks checkout (`woocommerce_store_api_checkout_order_processed`).
	 *
	 * Only captures when the field was actually registered on this request —
	 * if register_blocks_field() bailed, no Store API client was ever offered
	 * the checkbox, so recording `not_granted` would fabricate evidence. A
	 * registered field IS part of the published checkout schema, so headless
	 * clients that skip rendering it still count as offered (see class
	 * docblock).
	 *
	 * @param WC_Order $order The processed order.
	 * @return void
	 */
	public function capture_blocks( $order ) {
		if ( ! $this->blocks_field_registered ) {
			return;
		}

		$this->capture( $order, $this->is_checked_value( $this->read_blocks_value( $order ) ) );
	}

	/**
	 * Read the blocks-field value from the order: the CheckoutFields service
	 * when available, else the `_wc_other/{id}` order meta it writes to.
	 *
	 * @param WC_Order $order The processed order.
	 * @return mixed Raw stored value; shape deliberately not trusted (see is_checked_value()).
	 */
	private function read_blocks_value( $order ) {
		if ( class_exists( \Automattic\WooCommerce\Blocks\Package::class )
			&& class_exists( \Automattic\WooCommerce\Blocks\Domain\Services\CheckoutFields::class ) ) {
			try {
				$checkout_fields = \Automattic\WooCommerce\Blocks\Package::container()->get( \Automattic\WooCommerce\Blocks\Domain\Services\CheckoutFields::class );

				$value = $checkout_fields->get_field_from_object( self::BLOCKS_FIELD_ID, $order, 'other' );
				if ( null !== $value && '' !== $value ) {
					return $value;
				}
			} catch ( \Throwable $e ) { // phpcs:ignore Generic.CodeAnalysis.EmptyStatement.DetectedCatch -- fall through to the raw-meta read below.
				// The container/service seam is Woo-internal; never fatal over it.
			}
		}

		return $order->get_meta( '_wc_other/' . self::BLOCKS_FIELD_ID );
	}

	/**
	 * Normalize a stored/posted checkbox value to a boolean.
	 *
	 * Deliberately paranoid (woocommerce#56840 — checkbox values have shape
	 * edge cases): absent/''/'0'/false/anything else → unchecked; only
	 * true/1/'1'/'true' → checked. Never assume shape.
	 *
	 * @param mixed $value Raw value.
	 * @return bool
	 */
	private function is_checked_value( $value ) {
		if ( true === $value || 1 === $value || '1' === $value ) {
			return true;
		}

		return is_string( $value ) && 'true' === strtolower( trim( $value ) );
	}

	/**
	 * The single capture chokepoint: write the normalized consent meta onto
	 * the order.
	 *
	 * Last capture wins: both processed hooks re-fire on the SAME order when
	 * payment fails and the shopper resubmits (classic reuses the
	 * `order_awaiting_payment` session order; blocks reuses the draft order),
	 * and every firing is a genuine checkout submission carrying the
	 * shopper's CURRENT choice — so the meta must reflect the final gesture.
	 * First-capture-wins would freeze a stale decision in both directions:
	 * checked-then-unchecked would over-record a `granted` the successful
	 * submission revoked, and unchecked-then-checked would silently discard a
	 * real opt-in. Re-writes stay idempotent where it matters: if both stacks
	 * ever fired for one submission they would compute the same value, and an
	 * unchanged value skips the save entirely (no meta churn, original
	 * captured_at preserved).
	 *
	 * The label snapshot is the option value at capture time — the same value
	 * both render paths used moments earlier (an owner editing the label in
	 * the seconds between render and submit is the accepted rounding error;
	 * the alternative, echoing the label through the form, would make the
	 * evidence shopper-spoofable).
	 *
	 * @param WC_Order $order      The processed order.
	 * @param bool     $is_checked Whether the shopper checked the box.
	 * @return void
	 */
	private function capture( $order, $is_checked ) {
		if ( ! $order instanceof WC_Order ) {
			return;
		}

		$value = $is_checked ? self::CONSENT_GRANTED : self::CONSENT_NOT_GRANTED;

		// Unchanged decision (double-fire for one submission, or a retry with
		// the same choice): skip the save, keeping the original evidence.
		if ( $value === (string) $order->get_meta( self::META_CONSENT ) ) {
			return;
		}

		$order->update_meta_data( self::META_CONSENT, $value );
		$order->update_meta_data( self::META_SOURCE, self::SOURCE_CHECKOUT_CHECKBOX );
		$order->update_meta_data( self::META_LABEL, $this->get_label() );
		$order->update_meta_data( self::META_CAPTURED_AT, gmdate( 'c' ) );
		$order->save();
	}
}
