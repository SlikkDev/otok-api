<?php
/**
 * Cart event producers — raw cart snapshots with pre-enqueue debounce.
 *
 * @package OtokWC
 */

defined( 'ABSPATH' ) || exit;

/**
 * Produces `otok/cart_created` / `otok/cart_updated` events: RAW snapshots
 * only — abandonment is decided by the oToK server-side sweeper, the plugin
 * deliberately runs NO local abandonment timer.
 *
 * Cart token: a plugin-minted uuid4 stored in the WooCommerce session (never
 * the raw session key), created on first non-empty cart activity, re-saved
 * into the logged-in session on wp_login, and rotated (dropped) after order
 * completion so post-purchase browsing starts a fresh cart identity.
 *
 * Debounce is strictly PRE-ENQUEUE (the outbox freezes payloads at enqueue):
 * every cart mutation stores the LATEST snapshot in a per-token transient and
 * (re)schedules a dated Action Scheduler single action ~45s out, keyed by the
 * cart token — a mutation burst therefore yields ONE event carrying the final
 * state. The flush worker runs without the shopper's session, which is why
 * the snapshot (including contact identity) is captured at mutation time.
 * Entering checkout flushes immediately (classic page load and Store API
 * checkout processing), so the server always has the freshest cart before an
 * order can arrive. A snapshot identical to the last flushed one is never
 * re-armed (`woocommerce_cart_updated` fires on ordinary page loads), and an
 * empty cart that was never announced is dropped rather than sent.
 *
 * The first flushed snapshot for a token is `otok/cart_created`; every later
 * one is `otok/cart_updated` (tracked in a per-token transient set at flush
 * time — the topic decision happens where the send decision happens).
 */
class Otok_WC_Cart_Events {

	/**
	 * Action Scheduler hook for the debounced flush (args: the cart token).
	 * Mirrored as a string literal in uninstall.php — keep in sync.
	 */
	const HOOK_FLUSH = 'otok_wc_flush_cart';

	/**
	 * WooCommerce session key holding the plugin-minted cart token.
	 */
	const SESSION_TOKEN = 'otok_wc_cart_token';

	/**
	 * Debounce quiet window (seconds): a new mutation inside the window
	 * restarts it.
	 */
	const QUIET_WINDOW = 45;

	/**
	 * Per-token transient prefixes: the pending (unsent) snapshot, the
	 * announced marker (created already sent), and the hash of the last
	 * flushed snapshot (suppresses no-change re-sends).
	 */
	const TRANSIENT_SNAP = 'otok_wc_cart_snap_';
	const TRANSIENT_SEEN = 'otok_wc_cart_seen_';
	const TRANSIENT_HASH = 'otok_wc_cart_hash_';

	/**
	 * Transient lifetimes: a pending snapshot is short-lived by nature; the
	 * seen/hash markers should outlive a typical cart session (their expiry
	 * only costs a redundant cart_created, which the server upserts).
	 */
	const SNAP_TTL   = DAY_IN_SECONDS;
	const MARKER_TTL = 7 * DAY_IN_SECONDS;

	/**
	 * Credential store (producers only enqueue while connected).
	 *
	 * @var Otok_WC_Credentials
	 */
	private $credentials;

	/**
	 * Delivery worker (the producer enqueue API).
	 *
	 * @var Otok_WC_Delivery
	 */
	private $delivery;

	/**
	 * Guest-email capture (cart contact identity).
	 *
	 * @var Otok_WC_Guest_Email
	 */
	private $guest_email;

	/**
	 * Tokens already (re)armed during this request — a mutation storm inside
	 * one request re-schedules Action Scheduler only once.
	 *
	 * @var array<string,bool>
	 */
	private $armed = array();

	/**
	 * Constructor: wire cart hooks, the flush worker, checkout-entry flushes,
	 * and the login migration.
	 *
	 * @param Otok_WC_Credentials $credentials Credential store.
	 * @param Otok_WC_Delivery    $delivery    Delivery worker.
	 * @param Otok_WC_Guest_Email $guest_email Guest-email capture.
	 */
	public function __construct( Otok_WC_Credentials $credentials, Otok_WC_Delivery $delivery, Otok_WC_Guest_Email $guest_email ) {
		$this->credentials = $credentials;
		$this->delivery    = $delivery;
		$this->guest_email = $guest_email;

		// Every cart mutation funnels into one snapshot handler (the Store API
		// fires these same hooks). `woocommerce_cart_updated` fires after
		// totals are saved, so within a request the last snapshot wins.
		add_action( 'woocommerce_add_to_cart', array( $this, 'on_cart_mutation' ), 20 );
		add_action( 'woocommerce_cart_item_removed', array( $this, 'on_cart_mutation' ), 20 );
		add_action( 'woocommerce_cart_item_restored', array( $this, 'on_cart_mutation' ), 20 );
		add_action( 'woocommerce_after_cart_item_quantity_update', array( $this, 'on_cart_mutation' ), 20 );
		add_action( 'woocommerce_cart_emptied', array( $this, 'on_cart_mutation' ), 20 );
		add_action( 'woocommerce_cart_updated', array( $this, 'on_cart_mutation' ), 20 );

		// Guest-email capture announces identity changes here.
		add_action( 'otok_wc_cart_contact_updated', array( $this, 'on_cart_mutation' ), 20 );

		// Debounced flush worker (Action Scheduler, no shopper session).
		add_action( self::HOOK_FLUSH, array( $this, 'flush' ) );

		// Immediate flush on checkout entry: classic/blocks page load + Store
		// API checkout processing (headless clients never load the page).
		add_action( 'template_redirect', array( $this, 'on_checkout_page' ) );
		add_action( 'woocommerce_store_api_checkout_update_order_from_request', array( $this, 'on_store_api_checkout' ) );

		add_action( 'wp_login', array( $this, 'migrate_token_on_login' ), 20, 0 );
	}

	/**
	 * Snapshot the current cart and (re)arm the debounce.
	 *
	 * Skips silently when: not connected, no cart/session, or the snapshot is
	 * identical to the pending one / the last flushed one (only the
	 * always-changing updated_at stamp is excluded from the comparison, so a
	 * contact-identity change re-arms just like an item change).
	 *
	 * @return void
	 */
	public function on_cart_mutation() {
		if ( ! $this->credentials->is_connected() || ! $this->wc_available() || null === WC()->cart ) {
			return;
		}

		$cart_empty = WC()->cart->is_empty();
		$token      = $this->get_token( ! $cart_empty );

		if ( '' === $token ) {
			// Empty cart and no token yet: nothing worth announcing, and no
			// token gets minted for it.
			return;
		}

		$data = $this->build_snapshot( $token );
		$hash = $this->snapshot_hash( $data );

		$pending = get_transient( self::TRANSIENT_SNAP . $token );

		if ( is_array( $pending ) && isset( $pending['hash'] ) && $hash === $pending['hash'] ) {
			return; // Unchanged vs the already-pending snapshot.
		}

		if ( false === $pending && (string) get_transient( self::TRANSIENT_HASH . $token ) === $hash ) {
			return; // Unchanged vs the last flushed snapshot — page-load noise.
		}

		set_transient(
			self::TRANSIENT_SNAP . $token,
			array(
				'hash' => $hash,
				'data' => $data,
			),
			self::SNAP_TTL
		);

		$this->arm_debounce( $token );
	}

	/**
	 * The debounced flush worker (Action Scheduler callback): decide the
	 * topic, enqueue the frozen snapshot, mark the token announced.
	 *
	 * A newer mutation after this enqueue is a NEW snapshot with a NEW
	 * event_id — the freeze contract.
	 *
	 * @param string $cart_token The cart token the action was scheduled for.
	 * @return void
	 */
	public function flush( $cart_token ) {
		$cart_token = (string) $cart_token;
		if ( '' === $cart_token ) {
			return;
		}

		$pending = get_transient( self::TRANSIENT_SNAP . $cart_token );

		if ( ! is_array( $pending ) || empty( $pending['data'] ) || ! is_array( $pending['data'] ) ) {
			delete_transient( self::TRANSIENT_SNAP . $cart_token );
			return; // Already flushed (checkout entry) or expired — no-op.
		}

		if ( ! $this->credentials->is_connected() ) {
			delete_transient( self::TRANSIENT_SNAP . $cart_token );
			return; // Disconnected since the snapshot was taken — dropped.
		}

		$seen = '' !== (string) get_transient( self::TRANSIENT_SEEN . $cart_token );

		if ( ! $seen && empty( $pending['data']['items'] ) ) {
			delete_transient( self::TRANSIENT_SNAP . $cart_token );
			return; // Never announce a cart that emptied before its first send.
		}

		$topic  = $seen ? Otok_WC_Payloads::TOPIC_CART_UPDATED : Otok_WC_Payloads::TOPIC_CART_CREATED;
		$result = $this->delivery->enqueue_event( $topic, $pending['data'] );

		if ( is_wp_error( $result ) ) {
			// Keep the snapshot: the enqueue failure is logged by
			// enqueue_event(), and the next cart mutation (or checkout-entry
			// flush) gets another chance instead of silently losing the state.
			return;
		}

		delete_transient( self::TRANSIENT_SNAP . $cart_token );
		set_transient( self::TRANSIENT_SEEN . $cart_token, '1', self::MARKER_TTL );
		set_transient( self::TRANSIENT_HASH . $cart_token, (string) $pending['hash'], self::MARKER_TTL );
	}

	/**
	 * Classic/blocks checkout page load: flush the pending snapshot now.
	 * Excludes checkout endpoints (order-pay, order-received).
	 *
	 * @return void
	 */
	public function on_checkout_page() {
		if ( ! function_exists( 'is_checkout' ) || ! is_checkout() || is_wc_endpoint_url() ) {
			return;
		}

		$this->flush_now();
	}

	/**
	 * Store API checkout processing (headless clients never load the checkout
	 * page): flush immediately so the cart state precedes the order event.
	 *
	 * @return void
	 */
	public function on_store_api_checkout() {
		$this->flush_now();
	}

	/**
	 * Rotate the cart token after order completion: the purchase supersedes
	 * the cart, so any still-pending snapshot is dropped, the timer is
	 * cancelled, and the next cart activity mints a fresh token.
	 *
	 * Called by the order producer at order-processed time.
	 *
	 * @return void
	 */
	public function rotate_after_order() {
		if ( ! $this->wc_available() ) {
			return;
		}

		$token = (string) WC()->session->get( self::SESSION_TOKEN, '' );
		if ( '' === $token ) {
			return;
		}

		WC()->session->set( self::SESSION_TOKEN, null );

		$this->unschedule_flush( $token );
		delete_transient( self::TRANSIENT_SNAP . $token );
		delete_transient( self::TRANSIENT_SEEN . $token );
		delete_transient( self::TRANSIENT_HASH . $token );
	}

	/**
	 * The current session cart token without minting one ('' when absent).
	 * Read by the order producer BEFORE rotation so the order payload can
	 * name the cart it concluded.
	 *
	 * @return string
	 */
	public function current_token() {
		if ( ! $this->wc_available() ) {
			return '';
		}

		return (string) WC()->session->get( self::SESSION_TOKEN, '' );
	}

	/**
	 * Re-save the cart token on login. WooCommerce migrates the guest session
	 * to the user's session; re-setting the value marks it dirty so the token
	 * reliably persists under the logged-in session key.
	 *
	 * @return void
	 */
	public function migrate_token_on_login() {
		if ( ! $this->wc_available() ) {
			return;
		}

		$token = (string) WC()->session->get( self::SESSION_TOKEN, '' );
		if ( '' !== $token ) {
			WC()->session->set( self::SESSION_TOKEN, $token );
		}
	}

	/**
	 * Immediate flush: capture the current state first (a checkout-entry
	 * identity may not have re-armed anything), cancel the timer, flush.
	 *
	 * @return void
	 */
	private function flush_now() {
		if ( ! $this->wc_available() ) {
			return;
		}

		$token = (string) WC()->session->get( self::SESSION_TOKEN, '' );
		if ( '' === $token ) {
			return;
		}

		$this->on_cart_mutation();
		$this->unschedule_flush( $token );
		$this->flush( $token );
	}

	/**
	 * The session cart token, optionally minted on first use.
	 *
	 * @param bool $mint_if_missing Whether to mint a fresh uuid4 when absent.
	 * @return string Token, or '' when absent and not minting.
	 */
	private function get_token( $mint_if_missing ) {
		if ( null === WC()->session ) {
			return '';
		}

		$token = (string) WC()->session->get( self::SESSION_TOKEN, '' );

		if ( '' === $token && $mint_if_missing ) {
			$token = wp_generate_uuid4();
			WC()->session->set( self::SESSION_TOKEN, $token );
		}

		return $token;
	}

	/**
	 * Build the wire snapshot of the current cart (shape owned by
	 * Otok_WC_Payloads). Line `unit_price` is the pre-discount tax-exclusive
	 * line subtotal divided by quantity — the frozen money rule.
	 *
	 * @param string $token Cart token.
	 * @return array
	 */
	private function build_snapshot( $token ) {
		$cart  = WC()->cart;
		$items = array();

		foreach ( (array) $cart->get_cart() as $cart_item_key => $cart_item ) {
			if ( ! is_array( $cart_item ) ) {
				continue;
			}

			$qty     = (float) ( isset( $cart_item['quantity'] ) ? $cart_item['quantity'] : 1 );
			$product = ( isset( $cart_item['data'] ) && is_object( $cart_item['data'] ) ) ? $cart_item['data'] : null;

			$items[] = array(
				// The stable Woo cart-item key — the wire `external_id`.
				'external_id'   => (string) $cart_item_key,
				'product_id'    => ! empty( $cart_item['variation_id'] ) ? $cart_item['variation_id'] : ( isset( $cart_item['product_id'] ) ? $cart_item['product_id'] : 0 ),
				// 'edit' context: a variation's get_sku('view') INHERITS the
				// parent SKU (see the order producer note).
				'sku'           => ( $product && is_callable( array( $product, 'get_sku' ) ) ) ? (string) $product->get_sku( 'edit' ) : '',
				'title'         => ( $product && is_callable( array( $product, 'get_name' ) ) ) ? (string) $product->get_name() : '',
				'qty'           => $qty,
				'unit_price'    => ( isset( $cart_item['line_subtotal'] ) ? (float) $cart_item['line_subtotal'] : 0.0 ) / ( $qty > 0 ? $qty : 1 ),
				'line_subtotal' => isset( $cart_item['line_subtotal'] ) ? (float) $cart_item['line_subtotal'] : 0.0,
			);
		}

		return Otok_WC_Payloads::cart(
			array(
				'cart_token'   => $token,
				'contact'      => $this->cart_contact(),
				'items'        => $items,
				'totals'       => array(
					'subtotal' => (float) $cart->get_subtotal(),
					'discount' => (float) $cart->get_discount_total(),
					'shipping' => (float) $cart->get_shipping_total(),
					'tax'      => (float) $cart->get_total_tax(),
					'total'    => (float) $cart->get_total( 'edit' ),
				),
				'currency'     => get_woocommerce_currency(),
				'recovery_url' => wc_get_checkout_url(),
				'updated_at'   => gmdate( 'c' ),
			)
		);
	}

	/**
	 * Cart contact identity: the logged-in customer's billing email/phone, or
	 * the captured guest email (capture + strict-mode policy lives in
	 * Otok_WC_Guest_Email). Identity is optional — carts always flow; the
	 * server matches contacts when it can. `country` rides along solely as
	 * the phone's E.164 canonicalization input (consumed by the payload
	 * serializer, never emitted).
	 *
	 * @return array{email?:string,phone?:string,country?:string}
	 */
	private function cart_contact() {
		$contact = array();

		if ( is_user_logged_in() && null !== WC()->customer ) {
			$email = (string) WC()->customer->get_billing_email();
			if ( '' === $email && is_callable( array( WC()->customer, 'get_email' ) ) ) {
				$email = (string) WC()->customer->get_email();
			}
			if ( '' !== $email ) {
				$contact['email'] = $email;
			}

			$phone = (string) WC()->customer->get_billing_phone();
			if ( '' !== $phone ) {
				$contact['phone']   = $phone;
				$contact['country'] = (string) WC()->customer->get_billing_country();
			}
		}

		if ( empty( $contact['email'] ) ) {
			$captured = $this->guest_email->captured_email();
			if ( '' !== $captured ) {
				$contact['email'] = $captured;
			}
		}

		return $contact;
	}

	/**
	 * Comparison hash of a snapshot, excluding the always-changing
	 * updated_at stamp.
	 *
	 * @param array $data Snapshot data.
	 * @return string
	 */
	private function snapshot_hash( $data ) {
		unset( $data['updated_at'] );
		return md5( (string) wp_json_encode( $data ) );
	}

	/**
	 * (Re)schedule the debounced flush at now + QUIET_WINDOW, replacing any
	 * previously scheduled flush for this token. Once per request — but the
	 * guard is cleared whenever the scheduled flush is consumed or cancelled
	 * (unschedule_flush()), so a post-flush mutation in the same request
	 * (classic checkout: flush_now() at template_redirect, then
	 * `woocommerce_cart_updated` fires during render with recalculated
	 * totals) re-arms correctly instead of stranding a pending snapshot no
	 * flush is scheduled for.
	 *
	 * @param string $token Cart token.
	 * @return void
	 */
	private function arm_debounce( $token ) {
		if ( isset( $this->armed[ $token ] ) ) {
			return;
		}

		if ( ! function_exists( 'as_schedule_single_action' ) ) {
			return;
		}

		$this->unschedule_flush( $token );
		as_schedule_single_action( time() + self::QUIET_WINDOW, self::HOOK_FLUSH, array( $token ), Otok_WC_Delivery::AS_GROUP );
		$this->armed[ $token ] = true;
	}

	/**
	 * Cancel every scheduled flush for a token and clear its request-local
	 * armed guard (a stored pending snapshot must always have a scheduled or
	 * re-armable flush). as_unschedule_all_actions() rather than
	 * as_unschedule_action(): two concurrent requests can double-schedule,
	 * and the singular variant cancels only one pending action.
	 *
	 * @param string $token Cart token.
	 * @return void
	 */
	private function unschedule_flush( $token ) {
		unset( $this->armed[ $token ] );

		if ( function_exists( 'as_unschedule_all_actions' ) ) {
			as_unschedule_all_actions( self::HOOK_FLUSH, array( $token ), Otok_WC_Delivery::AS_GROUP );
		}
	}

	/**
	 * Whether WooCommerce and its session object are available.
	 *
	 * @return bool
	 */
	private function wc_available() {
		return function_exists( 'WC' ) && null !== WC()->session;
	}
}
