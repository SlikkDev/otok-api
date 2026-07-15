<?php
/**
 * Guest email capture — cart-event identity for shoppers without an account.
 *
 * @package OtokWC
 */

defined( 'ABSPATH' ) || exit;

/**
 * Captures the email address a guest types at checkout so cart events carry
 * an identity BEFORE an order exists (the whole point of abandoned-cart
 * automation). Two capture paths:
 *
 * - Classic checkout: a tiny front-end script posts the billing email field
 *   on blur to a hardened admin-ajax endpoint. The controls that actually
 *   carry the load for anonymous traffic are the WC-session binding, the
 *   non-empty-cart requirement, is_email() validation and the dual
 *   (per-session + per-IP) rate limits — a logged-out nonce is minted for
 *   user 0 with no session token, so one nonce is valid for EVERY anonymous
 *   visitor in the tick window and contributes nothing against abuse here
 *   (it stays as CSRF hygiene for logged-in shoppers). Do not weaken the
 *   session/cart/rate-limit checks on the assumption the nonce gates access.
 * - Blocks / Store API: `woocommerce_store_api_cart_update_customer_from_request`
 *   fires server-side whenever the checkout block syncs the customer — no
 *   JavaScript needed.
 *
 * The captured address lives in the WooCommerce SESSION only (never an
 * option, never a log line — no PII in logs is a hard rule; it reaches the
 * outbox only inside a cart payload's contact). It expires with the session
 * and is never echoed back to the browser.
 *
 * Settings: capture is ON by default (`otok_wc_guest_email_capture`);
 * optional STRICT mode (`otok_wc_guest_email_strict`) attaches the captured
 * email to cart events only after the shopper has ticked the marketing-consent
 * checkbox. The consent hint comes from the same classic-checkout script
 * (checkbox change events); the checkout BLOCK exposes no pre-submit signal
 * for additional fields, so in strict mode a blocks-checkout guest's email is
 * deliberately withheld until the order is placed (conservative by design).
 * Strict mode gates ONLY the captured guest email — cart events themselves
 * always flow, and a logged-in customer's identity is unaffected.
 */
class Otok_WC_Guest_Email {

	/**
	 * Settings options ('1'/'0'): capture toggle (default ON) and strict mode
	 * (default OFF).
	 */
	const OPTION_CAPTURE = 'otok_wc_guest_email_capture';
	const OPTION_STRICT  = 'otok_wc_guest_email_strict';

	/**
	 * Admin-ajax action + nonce action for the classic-checkout capture.
	 */
	const AJAX_ACTION = 'otok_wc_capture_email';

	/**
	 * WooCommerce session keys: the captured address and the consent-checkbox
	 * hint ('1' once the shopper ticked the box on the classic checkout).
	 */
	const SESSION_EMAIL        = 'otok_wc_guest_email';
	const SESSION_CONSENT_HINT = 'otok_wc_consent_hint';

	/**
	 * Rate limits for the AJAX endpoint: per WC session AND per client IP.
	 * A guest's session/customer id is minted with the session itself, so an
	 * attacker can reset the per-session bucket at will by minting fresh
	 * sessions — the IP bucket is the attacker-independent backstop.
	 */
	const RATE_LIMIT    = 10;
	const RATE_LIMIT_IP = 60;
	const RATE_WINDOW   = 10 * MINUTE_IN_SECONDS;

	/**
	 * Constructor: wire both capture paths + the checkout script.
	 */
	public function __construct() {
		add_action( 'wp_ajax_' . self::AJAX_ACTION, array( $this, 'handle_ajax' ) );
		add_action( 'wp_ajax_nopriv_' . self::AJAX_ACTION, array( $this, 'handle_ajax' ) );
		add_action( 'woocommerce_store_api_cart_update_customer_from_request', array( $this, 'capture_from_store_api' ), 10, 2 );
		add_action( 'wp_enqueue_scripts', array( $this, 'enqueue_checkout_script' ) );
	}

	/**
	 * Whether guest-email capture is enabled (default ON).
	 *
	 * @return bool
	 */
	public function is_capture_enabled() {
		return '0' !== (string) get_option( self::OPTION_CAPTURE, '1' );
	}

	/**
	 * Whether strict mode is enabled (default OFF).
	 *
	 * @return bool
	 */
	public function is_strict() {
		return '1' === (string) get_option( self::OPTION_STRICT, '0' );
	}

	/**
	 * Persist the two settings (admin form handler).
	 *
	 * @param bool $capture Guest-email capture on/off.
	 * @param bool $strict  Strict mode on/off.
	 * @return void
	 */
	public function save_settings( $capture, $strict ) {
		update_option( self::OPTION_CAPTURE, $capture ? '1' : '0' );
		update_option( self::OPTION_STRICT, $strict ? '1' : '0' );
	}

	/**
	 * The captured guest email a cart payload may attach, or '' when there is
	 * none / capture is off / strict mode withholds it.
	 *
	 * @return string
	 */
	public function captured_email() {
		if ( ! $this->is_capture_enabled() || ! $this->session_available() ) {
			return '';
		}

		$email = (string) WC()->session->get( self::SESSION_EMAIL, '' );
		if ( '' === $email || ! is_email( $email ) ) {
			return '';
		}

		if ( $this->is_strict() && '1' !== (string) WC()->session->get( self::SESSION_CONSENT_HINT, '' ) ) {
			return '';
		}

		return $email;
	}

	/**
	 * Hardened classic-checkout capture endpoint (wp_ajax + wp_ajax_nopriv).
	 *
	 * Accepts `email` (validated, stored) and/or `consent` ('1'/'0' checkbox
	 * hint for strict mode). Session-bound: no WooCommerce session or an
	 * empty cart means there is no cart to identify — rejected. Responses
	 * never echo the submitted address.
	 *
	 * @return void
	 */
	public function handle_ajax() {
		check_ajax_referer( self::AJAX_ACTION, 'nonce' );

		if ( ! $this->is_capture_enabled() ) {
			wp_send_json_error( null, 403 );
		}

		if ( ! $this->session_available() || ! WC()->session->has_session() ) {
			wp_send_json_error( null, 400 );
		}

		if ( null === WC()->cart || WC()->cart->is_empty() ) {
			wp_send_json_error( null, 400 );
		}

		if ( ! $this->within_rate_limit() ) {
			wp_send_json_error( null, 429 );
		}

		$updated = false;

		if ( isset( $_POST['consent'] ) ) {
			WC()->session->set( self::SESSION_CONSENT_HINT, '1' === sanitize_text_field( wp_unslash( $_POST['consent'] ) ) ? '1' : '0' );
			$updated = true;
		}

		if ( isset( $_POST['email'] ) && '' !== trim( (string) wp_unslash( $_POST['email'] ) ) ) { // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- sanitized via sanitize_email() below.
			$email = sanitize_email( wp_unslash( $_POST['email'] ) ); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- sanitize_email() IS the sanitizer.
			if ( ! is_email( $email ) ) {
				wp_send_json_error( null, 400 );
			}
			WC()->session->set( self::SESSION_EMAIL, $email );
			$updated = true;
		}

		if ( ! $updated ) {
			wp_send_json_error( null, 400 );
		}

		// Let the cart producer re-snapshot: identity changes are cart changes.
		do_action( 'otok_wc_cart_contact_updated' );

		wp_send_json_success();
	}

	/**
	 * Blocks / Store API capture: fires whenever the checkout block syncs the
	 * customer (email typed into the contact step included).
	 *
	 * @param WC_Customer     $customer Customer object freshly updated from the request.
	 * @param WP_REST_Request $request  The Store API request (unused).
	 * @return void
	 */
	public function capture_from_store_api( $customer, $request ) { // phpcs:ignore Generic.CodeAnalysis.UnusedFunctionParameter.FoundAfterLastUsed -- hook signature.
		if ( ! $this->is_capture_enabled() || ! $this->session_available() ) {
			return;
		}

		if ( ! is_object( $customer ) || ! is_callable( array( $customer, 'get_billing_email' ) ) ) {
			return;
		}

		$email = (string) $customer->get_billing_email();
		if ( '' === $email || ! is_email( $email ) ) {
			return;
		}

		if ( (string) WC()->session->get( self::SESSION_EMAIL, '' ) === $email ) {
			return;
		}

		// Same buckets as the AJAX path (parity — an anonymous Store API
		// client can drive this hook too). Checked only after the
		// changed-email guard above so the block's routine customer syncs
		// never burn budget; on an exhausted bucket the capture is silently
		// skipped (this is a hook, not a response surface).
		if ( ! $this->within_rate_limit() ) {
			return;
		}

		WC()->session->set( self::SESSION_EMAIL, $email );

		do_action( 'otok_wc_cart_contact_updated' );
	}

	/**
	 * Enqueue the classic-checkout capture script on the checkout page. The
	 * blocks checkout captures server-side, and on a blocks page the script's
	 * selectors simply never match — harmless either way.
	 *
	 * @return void
	 */
	public function enqueue_checkout_script() {
		if ( ! $this->is_capture_enabled() ) {
			return;
		}

		if ( ! function_exists( 'is_checkout' ) || ! is_checkout() || is_wc_endpoint_url() ) {
			return;
		}

		wp_enqueue_script( 'otok-wc-checkout', OTOK_WC_PLUGIN_URL . 'assets/js/checkout.js', array(), OTOK_WC_VERSION, true );
		wp_localize_script(
			'otok-wc-checkout',
			'otokWcCheckout',
			array(
				'ajaxUrl' => admin_url( 'admin-ajax.php' ),
				'action'  => self::AJAX_ACTION,
				'nonce'   => wp_create_nonce( self::AJAX_ACTION ),
			)
		);
	}

	/**
	 * Whether the WooCommerce session object is available.
	 *
	 * @return bool
	 */
	private function session_available() {
		return function_exists( 'WC' ) && null !== WC()->session;
	}

	/**
	 * Rate limit shared by BOTH capture paths (AJAX + Store API): rejected
	 * when EITHER the per-session bucket or the per-IP bucket is exhausted
	 * (see the constants for why the session bucket alone is not enough for
	 * anonymous traffic).
	 *
	 * @return bool True when this request is within both limits.
	 */
	private function within_rate_limit() {
		$session_key = 'otok_wc_geml_' . md5( (string) WC()->session->get_customer_id() );
		$ip          = isset( $_SERVER['REMOTE_ADDR'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REMOTE_ADDR'] ) ) : '';
		$ip_key      = 'otok_wc_geml_ip_' . md5( $ip );

		return $this->claim_rate_slot( $session_key, self::RATE_LIMIT )
			&& $this->claim_rate_slot( $ip_key, self::RATE_LIMIT_IP );
	}

	/**
	 * Claim one slot in a fixed-window counter bucket — as atomically as the
	 * site's WordPress allows.
	 *
	 * With an external object cache the claim is genuinely atomic
	 * (wp_cache_add() as the create-once seed + wp_cache_incr() as the
	 * increment — concurrent requests can never lose an increment). Without
	 * one, transients fall back to a read-then-write pair, so a concurrent
	 * burst can overshoot the nominal cap by the number of in-flight
	 * requests — accepted: the buckets bound sustained abuse, not
	 * instantaneous concurrency, and the WC-session + non-empty-cart guards
	 * already price each request.
	 *
	 * @param string $key   Bucket key.
	 * @param int    $limit Slots per window.
	 * @return bool True when a slot was claimed (request allowed).
	 */
	private function claim_rate_slot( $key, $limit ) {
		if ( wp_using_ext_object_cache() ) {
			if ( wp_cache_add( $key, 1, 'otok-wc', self::RATE_WINDOW ) ) {
				return true;
			}

			$count = wp_cache_incr( $key, 1, 'otok-wc' );

			// false = the key expired between add and incr; treat as a fresh
			// window rather than failing open forever or closed forever.
			return false === $count ? wp_cache_add( $key, 1, 'otok-wc', self::RATE_WINDOW ) : $count <= $limit;
		}

		$count = (int) get_transient( $key );

		if ( $count >= $limit ) {
			return false;
		}

		set_transient( $key, $count + 1, self::RATE_WINDOW );

		return true;
	}
}
