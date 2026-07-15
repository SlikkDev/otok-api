<?php
/**
 * Plugin bootstrap singleton.
 *
 * @package OtokWC
 */

defined( 'ABSPATH' ) || exit;

require_once OTOK_WC_PLUGIN_DIR . 'includes/class-otok-wc-credentials.php';
require_once OTOK_WC_PLUGIN_DIR . 'includes/class-otok-wc-connect.php';
require_once OTOK_WC_PLUGIN_DIR . 'includes/class-otok-wc-consent.php';
require_once OTOK_WC_PLUGIN_DIR . 'includes/class-otok-wc-payloads.php';
require_once OTOK_WC_PLUGIN_DIR . 'includes/class-otok-wc-outbox.php';
require_once OTOK_WC_PLUGIN_DIR . 'includes/class-otok-wc-delivery.php';
require_once OTOK_WC_PLUGIN_DIR . 'includes/class-otok-wc-guest-email.php';
require_once OTOK_WC_PLUGIN_DIR . 'includes/class-otok-wc-cart-events.php';
require_once OTOK_WC_PLUGIN_DIR . 'includes/class-otok-wc-order-events.php';

/**
 * Wires the plugin's services together. Only constructed after the runtime
 * requirement check in otok_wc_bootstrap() has passed.
 */
final class Otok_WC_Plugin {

	/**
	 * Singleton instance.
	 *
	 * @var Otok_WC_Plugin|null
	 */
	private static $instance = null;

	/**
	 * Credential store.
	 *
	 * @var Otok_WC_Credentials
	 */
	private $credentials;

	/**
	 * Pairing-code connect client.
	 *
	 * @var Otok_WC_Connect
	 */
	private $connect;

	/**
	 * Marketing-consent checkbox (both checkout stacks) + order-meta capture.
	 *
	 * @var Otok_WC_Consent
	 */
	private $consent;

	/**
	 * Durable event outbox.
	 *
	 * @var Otok_WC_Outbox
	 */
	private $outbox;

	/**
	 * Outbox delivery worker (Action Scheduler dispatch).
	 *
	 * @var Otok_WC_Delivery
	 */
	private $delivery;

	/**
	 * Guest-email capture (cart-event identity + settings).
	 *
	 * @var Otok_WC_Guest_Email
	 */
	private $guest_email;

	/**
	 * Cart event producers (token lifecycle + debounced snapshots).
	 *
	 * @var Otok_WC_Cart_Events
	 */
	private $cart_events;

	/**
	 * Order + consent event producers.
	 *
	 * @var Otok_WC_Order_Events
	 */
	private $order_events;

	/**
	 * Admin UI (settings page), only in admin context.
	 *
	 * @var Otok_WC_Admin|null
	 */
	private $admin = null;

	/**
	 * Get (and lazily create) the singleton instance.
	 *
	 * @return Otok_WC_Plugin
	 */
	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * Wire services and hooks.
	 */
	private function __construct() {
		$this->credentials = new Otok_WC_Credentials();
		$this->connect     = new Otok_WC_Connect( $this->credentials );
		// Constructed unconditionally: checkout renders and Store API checkout
		// requests are front-end contexts, and capture runs connected or not.
		$this->consent = new Otok_WC_Consent();

		// Constructed unconditionally too: Action Scheduler runs its queue in
		// cron and admin-ajax contexts, and the dispatch/purge callbacks must
		// be registered wherever an AS runner might claim our actions.
		$this->outbox   = new Otok_WC_Outbox();
		$this->delivery = new Otok_WC_Delivery( $this->credentials, $this->outbox );

		// Event producers — unconditional too: cart/checkout hooks are
		// front-end, Store API checkout is REST, refunds/status changes fire
		// from admin and crons, and the debounced cart flush runs wherever an
		// AS runner claims it.
		$this->guest_email  = new Otok_WC_Guest_Email();
		$this->cart_events  = new Otok_WC_Cart_Events( $this->credentials, $this->delivery, $this->guest_email );
		$this->order_events = new Otok_WC_Order_Events( $this->credentials, $this->delivery, $this->cart_events );

		// Plugin updates arrive by file replacement, which never re-fires the
		// activation hook — re-assert the outbox schema on admin loads.
		add_action( 'admin_init', array( 'Otok_WC_Outbox', 'maybe_upgrade' ) );

		if ( is_admin() ) {
			require_once OTOK_WC_PLUGIN_DIR . 'includes/admin/class-otok-wc-admin.php';
			$this->admin = new Otok_WC_Admin( $this->credentials, $this->connect, $this->consent, $this->guest_email, $this->outbox, $this->delivery );
		}
	}

	/**
	 * Credential store accessor.
	 *
	 * @return Otok_WC_Credentials
	 */
	public function credentials() {
		return $this->credentials;
	}

	/**
	 * Connect client accessor.
	 *
	 * @return Otok_WC_Connect
	 */
	public function connect() {
		return $this->connect;
	}

	/**
	 * Consent capture accessor.
	 *
	 * @return Otok_WC_Consent
	 */
	public function consent() {
		return $this->consent;
	}

	/**
	 * Outbox accessor.
	 *
	 * @return Otok_WC_Outbox
	 */
	public function outbox() {
		return $this->outbox;
	}

	/**
	 * Delivery accessor — event producers enqueue through
	 * `Otok_WC_Plugin::instance()->delivery()->enqueue_event( $topic, $data )`.
	 *
	 * @return Otok_WC_Delivery
	 */
	public function delivery() {
		return $this->delivery;
	}
}
