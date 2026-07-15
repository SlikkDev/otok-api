<?php
/**
 * Order + consent event producers.
 *
 * @package OtokWC
 */

defined( 'ABSPATH' ) || exit;

/**
 * Produces `otok/consent_updated`, `otok/order_created` and
 * `otok/order_updated` events. All order reads go through the WC_Order CRUD
 * (HPOS-safe); all payload shapes live in Otok_WC_Payloads.
 *
 * - `otok/order_created` fires at checkout-order-processed on BOTH stacks
 *   (the same chokepoint timing the consent capture uses; producer
 *   priority 20 runs after capture at 10, so the consent meta seam is already
 *   written). Store-API `checkout-draft` orders are NEVER emitted, and a
 *   payment retry that re-fires the processed hook on the same order emits
 *   `otok/order_updated` instead (guarded by an order-meta stamp) — the
 *   server sees one creation per order. Manual/admin orders deliberately get
 *   no created event (the contract scopes creation to checkout).
 * - `otok/order_updated` fires on EVERY status change (the server derives
 *   paid/refunded transitions from the normalized financial_status — cheap,
 *   keeps fidelity) plus on refund creation, which is the only signal for a
 *   PARTIAL refund (partial refunds do not change the order status).
 * - `otok/consent_updated` fires at order-processed by reading the
 *   `_otok_wc_consent*` order meta seam written by the consent capture. No meta (checkbox never offered) or
 *   no billing email (no identity) means no event; `consent_source` attaches
 *   only to `granted` (the wire contract's seam note, enforced in the
 *   serializer).
 *
 * Producers enqueue only while connected — consent-meta capture is
 * unconditional, event emission is not. Queued rows survive short
 * disconnected windows via the outbox, so gating enqueue on the connection
 * merely avoids pointless rows, never loses a connected store's events.
 */
class Otok_WC_Order_Events {

	/**
	 * Order meta stamped after `otok/order_created` was enqueued for the
	 * order, so a payment-retry re-fire of the processed hook emits an
	 * update instead of a duplicate creation.
	 */
	const META_CREATED_EMITTED = '_otok_wc_order_created_emitted';

	/**
	 * Order meta holding the per-order monotonic emission counter — the wire
	 * `sequence` field that lets the server apply last-writer-wins when
	 * retries deliver events out of order (occurred_at alone can tie).
	 */
	const META_SEQUENCE = '_otok_wc_order_seq';

	/**
	 * Order meta holding the cart token the order concluded, stamped at
	 * order-processed time (the AS-driven status/refund emissions have no
	 * shopper session to read it from). Carried on the order payload so the
	 * server can retire the cart deterministically — including carts
	 * stranded by failed payment retries, where each processed re-fire
	 * re-stamps the latest token.
	 */
	const META_CART_TOKEN = '_otok_wc_cart_token';

	/**
	 * MySQL advisory-lock timeout (seconds) for the per-order emission lock —
	 * see lock_order(). Short: the critical section is a meta read/write plus
	 * one outbox insert.
	 */
	const ORDER_LOCK_TIMEOUT = 2;

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
	 * Cart events (token rotation after order completion).
	 *
	 * @var Otok_WC_Cart_Events
	 */
	private $cart_events;

	/**
	 * Constructor: wire both checkout stacks + the lifecycle hooks.
	 *
	 * @param Otok_WC_Credentials $credentials Credential store.
	 * @param Otok_WC_Delivery    $delivery    Delivery worker.
	 * @param Otok_WC_Cart_Events $cart_events Cart events (token rotation).
	 */
	public function __construct( Otok_WC_Credentials $credentials, Otok_WC_Delivery $delivery, Otok_WC_Cart_Events $cart_events ) {
		$this->credentials = $credentials;
		$this->delivery    = $delivery;
		$this->cart_events = $cart_events;

		// Priority 20: AFTER Otok_WC_Consent::capture_*() (priority 10) has
		// written the consent meta this producer reads.
		add_action( 'woocommerce_checkout_order_processed', array( $this, 'on_classic_checkout' ), 20, 3 );
		add_action( 'woocommerce_store_api_checkout_order_processed', array( $this, 'on_blocks_checkout' ), 20 );

		add_action( 'woocommerce_order_status_changed', array( $this, 'on_status_changed' ), 10, 4 );
		add_action( 'woocommerce_order_refunded', array( $this, 'on_refunded' ), 10, 2 );
	}

	/**
	 * Classic checkout processed.
	 *
	 * @param int      $order_id    Order id (unused; the order object is passed).
	 * @param array    $posted_data Checkout posted data (unused).
	 * @param WC_Order $order       The processed order.
	 * @return void
	 */
	public function on_classic_checkout( $order_id, $posted_data, $order ) { // phpcs:ignore Generic.CodeAnalysis.UnusedFunctionParameter.FoundBeforeLastUsed -- hook signature.
		$this->on_checkout_processed( $order );
	}

	/**
	 * Blocks (Store API) checkout processed.
	 *
	 * @param WC_Order $order The processed order.
	 * @return void
	 */
	public function on_blocks_checkout( $order ) {
		$this->on_checkout_processed( $order );
	}

	/**
	 * Every status change is an update — the server derives financial
	 * transitions. Transitions touching `checkout-draft` are suppressed:
	 * drafts are never emitted, and leaving draft IS the creation the
	 * order-processed hook already covers.
	 *
	 * @param int      $order_id Order id.
	 * @param string   $from     Previous status (no `wc-` prefix).
	 * @param string   $to       New status (no `wc-` prefix).
	 * @param WC_Order $order    The order.
	 * @return void
	 */
	public function on_status_changed( $order_id, $from, $to, $order ) { // phpcs:ignore Generic.CodeAnalysis.UnusedFunctionParameter.FoundBeforeLastUsed -- hook signature.
		if ( ! $this->credentials->is_connected() ) {
			return;
		}

		if ( 'checkout-draft' === (string) $from || 'checkout-draft' === (string) $to ) {
			return;
		}

		if ( ! $order instanceof WC_Order ) {
			return;
		}

		if ( ! $this->lock_order( $order_id ) ) {
			return; // A concurrent emitter holds this order's lock and emits its current state.
		}

		$this->emit_order( Otok_WC_Payloads::TOPIC_ORDER_UPDATED, $order );

		$this->unlock_order( $order_id );
	}

	/**
	 * Refund created (`woocommerce_order_refunded` fires for both full and
	 * partial refunds — the latter never changes the order status, so this is
	 * the only chokepoint that can surface `partially_refunded`).
	 *
	 * @param int $order_id  Order id.
	 * @param int $refund_id Refund id (unused; totals are re-read from the order).
	 * @return void
	 */
	public function on_refunded( $order_id, $refund_id ) { // phpcs:ignore Generic.CodeAnalysis.UnusedFunctionParameter.FoundAfterLastUsed -- hook signature.
		if ( ! $this->credentials->is_connected() ) {
			return;
		}

		$order = wc_get_order( $order_id );
		if ( ! $order instanceof WC_Order ) {
			return;
		}

		// A FULL refund flips the status to `refunded` BEFORE this hook fires
		// (wc_create_refund → woocommerce_order_fully_refunded → status
		// change), so on_status_changed already emitted the refunded state —
		// emitting again here would be an identical duplicate under a new
		// event_id. Partial refunds never change the status and still emit
		// below; stores filtering woocommerce_order_fully_refunded_status to
		// suppress the flip also still emit here.
		if ( 'refunded' === $order->get_status() ) {
			return;
		}

		if ( ! $this->lock_order( $order_id ) ) {
			return; // A concurrent emitter holds this order's lock and emits its current state.
		}

		$this->emit_order( Otok_WC_Payloads::TOPIC_ORDER_UPDATED, $order );

		$this->unlock_order( $order_id );
	}

	/**
	 * Shared order-processed chokepoint (both stacks): rotate the cart token,
	 * then emit consent + order events.
	 *
	 * @param WC_Order $order The processed order.
	 * @return void
	 */
	private function on_checkout_processed( $order ) {
		if ( ! $order instanceof WC_Order ) {
			return;
		}

		// The completed checkout supersedes the cart whatever the connection
		// state — post-purchase browsing must start a fresh cart identity.
		// The token is read BEFORE rotation so the order payload can name it.
		$cart_token = $this->cart_events->current_token();
		$this->cart_events->rotate_after_order();

		if ( ! $this->credentials->is_connected() ) {
			return;
		}

		// Store-API draft orders are never emitted (belt-and-braces: the
		// processed hook fires after the draft status is left).
		if ( 'checkout-draft' === $order->get_status() ) {
			return;
		}

		// Stamp (or re-stamp, on a payment retry that minted a fresh cart
		// token) the cart this order concluded — later status/refund
		// emissions run without the shopper session and read this meta.
		if ( '' !== $cart_token && $cart_token !== (string) $order->get_meta( self::META_CART_TOKEN ) ) {
			$order->update_meta_data( self::META_CART_TOKEN, $cart_token );
			$order->save();
		}

		$this->emit_consent( $order );

		// Per-order advisory lock: the created-dedupe check below and the
		// sequence increment inside emit_order() are read-then-write on order
		// meta — two concurrent requests on the same order (duplicate checkout
		// submission race) could both see META_CREATED_EMITTED unwritten and
		// double-emit `otok/order_created`. On lock failure this request
		// skips: the concurrent holder emits for this order.
		if ( ! $this->lock_order( $order->get_id() ) ) {
			return;
		}

		// Fresh meta under the lock — a concurrent winner may have stamped
		// the dedupe meta after this request loaded the order.
		$order->read_meta_data( true );

		if ( '' === (string) $order->get_meta( self::META_CREATED_EMITTED ) ) {
			$this->emit_order( Otok_WC_Payloads::TOPIC_ORDER_CREATED, $order );
			$order->update_meta_data( self::META_CREATED_EMITTED, gmdate( 'c' ) );
			$order->save();
		} else {
			// Payment retry re-fired the processed hook on the same order —
			// the shopper's resubmission is an update, not a second creation.
			$this->emit_order( Otok_WC_Payloads::TOPIC_ORDER_UPDATED, $order );
		}

		$this->unlock_order( $order->get_id() );
	}

	/**
	 * Emit `otok/consent_updated` from the consent order-meta seam.
	 *
	 * @param WC_Order $order The processed order.
	 * @return void
	 */
	private function emit_consent( $order ) {
		$consent = (string) $order->get_meta( Otok_WC_Consent::META_CONSENT );
		if ( '' === $consent ) {
			return; // Checkbox never offered at submit time — no signal.
		}

		$email = (string) $order->get_billing_email();
		if ( '' === $email ) {
			return; // No identity to update consent for.
		}

		$this->delivery->enqueue_event(
			Otok_WC_Payloads::TOPIC_CONSENT_UPDATED,
			Otok_WC_Payloads::consent_updated(
				array(
					'email'          => $email,
					'phone'          => (string) $order->get_billing_phone(),
					// Billing country: canonicalization input for the phone
					// (E.164-or-omit contract) — never emitted itself.
					'country'        => (string) $order->get_billing_country(),
					'first_name'     => (string) $order->get_billing_first_name(),
					'last_name'      => (string) $order->get_billing_last_name(),
					'consent'        => $consent,
					'consent_source' => (string) $order->get_meta( Otok_WC_Consent::META_SOURCE ),
					'consented_at'   => (string) $order->get_meta( Otok_WC_Consent::META_CAPTURED_AT ),
				)
			)
		);
	}

	/**
	 * Emit an order event (shape owned by Otok_WC_Payloads).
	 *
	 * Money extraction (frozen rules): line `unit_price` = the pre-discount
	 * tax-exclusive line subtotal / quantity; `subtotal` = the order's
	 * tax-exclusive pre-discount item subtotal; discount + shipping
	 * tax-exclusive; `tax` = all tax; `total` = the grand total.
	 *
	 * Concurrency: every caller holds the per-order advisory lock (see
	 * lock_order()) around this call — the sequence read-increment-save below
	 * is check-then-act on order meta, and two concurrent emissions for one
	 * order (a status change racing a refund) must not persist the same
	 * sequence number.
	 *
	 * @param string   $topic TOPIC_ORDER_CREATED or TOPIC_ORDER_UPDATED.
	 * @param WC_Order $order The order.
	 * @return void
	 */
	private function emit_order( $topic, $order ) {
		// Per-order monotonic sequence: incremented (and persisted) for every
		// emission, so the server can order events for one order even when
		// retries deliver them out of order within the same second. The meta
		// is re-read fresh under the caller-held lock so the increment bases
		// on the latest committed value.
		$order->read_meta_data( true );
		$sequence = (int) $order->get_meta( self::META_SEQUENCE ) + 1;
		$order->update_meta_data( self::META_SEQUENCE, $sequence );
		$order->save();

		$items = array();

		foreach ( (array) $order->get_items( 'line_item' ) as $item ) {
			if ( ! is_object( $item ) ) {
				continue;
			}

			$qty     = (float) $item->get_quantity();
			$product = is_callable( array( $item, 'get_product' ) ) ? $item->get_product() : null;

			$items[] = array(
				'product_id'    => $item->get_variation_id() ? $item->get_variation_id() : $item->get_product_id(),
				// 'edit' context: a variation's get_sku('view') INHERITS the
				// parent SKU, which would collapse distinct variations onto
				// one SKU server-side; the serializer drops empty SKUs.
				'sku'           => ( $product && is_callable( array( $product, 'get_sku' ) ) ) ? (string) $product->get_sku( 'edit' ) : '',
				'title'         => (string) $item->get_name(),
				'qty'           => $qty,
				'unit_price'    => (float) $item->get_subtotal() / ( $qty > 0 ? $qty : 1 ),
				'line_subtotal' => (float) $item->get_subtotal(),
			);
		}

		$platform_status  = (string) $order->get_status();
		$financial_status = Otok_WC_Payloads::map_financial_status(
			$platform_status,
			(float) $order->get_total(),
			(float) $order->get_total_refunded()
		);

		$created  = $order->get_date_created();
		$modified = $order->get_date_modified();

		// Refund tuples for the wire `refunds[]` (the server's per-refund
		// idempotency claims key on the stable Woo refund id). get_amount()
		// is the refund's positive total; the serializer re-normalizes sign.
		$refunds = array();
		foreach ( (array) $order->get_refunds() as $refund ) {
			if ( ! is_object( $refund ) ) {
				continue;
			}

			$refund_created = $refund->get_date_created();

			$refunds[] = array(
				'refund_id'  => $refund->get_id(),
				'amount'     => (float) $refund->get_amount(),
				'created_at' => $refund_created ? gmdate( 'c', $refund_created->getTimestamp() ) : gmdate( 'c' ),
			);
		}

		$args = array(
			'external_order_id' => (string) $order->get_id(),
			'order_number'      => (string) $order->get_order_number(),
			'sequence'          => $sequence,
			'contact'           => array(
				'email'      => (string) $order->get_billing_email(),
				'phone'      => (string) $order->get_billing_phone(),
				// Billing country: canonicalization input for the phone
				// (E.164-or-omit contract) — never emitted itself.
				'country'    => (string) $order->get_billing_country(),
				'first_name' => (string) $order->get_billing_first_name(),
				'last_name'  => (string) $order->get_billing_last_name(),
			),
			'items'             => $items,
			'totals'            => array(
				'subtotal'       => (float) $order->get_subtotal(),
				'discount'       => (float) $order->get_discount_total(),
				'shipping'       => (float) $order->get_shipping_total(),
				'tax'            => (float) $order->get_total_tax(),
				'total'          => (float) $order->get_total(),
				'total_refunded' => (float) $order->get_total_refunded(),
			),
			'currency'          => (string) $order->get_currency(),
			'coupon_codes'      => $order->get_coupon_codes(),
			'refunds'           => $refunds,
			'financial_status'  => $financial_status,
			'platform_status'   => $platform_status,
			'created_at'        => $created ? gmdate( 'c', $created->getTimestamp() ) : gmdate( 'c' ),
			// The order's last-modified instant — the server's out-of-order/
			// stale-webhook guard keys on it.
			'updated_at'        => $modified ? gmdate( 'c', $modified->getTimestamp() ) : gmdate( 'c' ),
		);

		$cart_token = (string) $order->get_meta( self::META_CART_TOKEN );
		if ( '' !== $cart_token ) {
			$args['cart_token'] = $cart_token;
		}

		if ( 'cancelled' === $platform_status ) {
			$modified             = $order->get_date_modified();
			$args['cancelled_at'] = gmdate( 'c', $modified ? $modified->getTimestamp() : time() );
		}

		$this->delivery->enqueue_event( $topic, Otok_WC_Payloads::order( $args ) );
	}

	/**
	 * Acquire the per-order MySQL advisory lock that serializes this class's
	 * read-then-write order-meta cycles (created dedupe, sequence counter)
	 * across concurrent requests. Prefix-scoped: GET_LOCK names are
	 * server-wide, so $wpdb->prefix keeps sites on a shared server apart.
	 *
	 * Callers that fail to acquire it skip their emission entirely — the
	 * concurrent holder emits the order's current state.
	 *
	 * @param int $order_id Order id.
	 * @return bool Whether the lock was acquired.
	 */
	private function lock_order( $order_id ) {
		global $wpdb;

		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- MySQL advisory lock; no WP API exists for it.
		$locked = $wpdb->get_var( $wpdb->prepare( 'SELECT GET_LOCK(%s, %d)', $wpdb->prefix . 'otok_wc_order_' . (int) $order_id, self::ORDER_LOCK_TIMEOUT ) );

		return '1' === (string) $locked;
	}

	/**
	 * Release the per-order advisory lock taken by lock_order().
	 *
	 * @param int $order_id Order id.
	 * @return void
	 */
	private function unlock_order( $order_id ) {
		global $wpdb;

		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- releases the advisory lock from lock_order().
		$wpdb->query( $wpdb->prepare( 'SELECT RELEASE_LOCK(%s)', $wpdb->prefix . 'otok_wc_order_' . (int) $order_id ) );
	}
}
