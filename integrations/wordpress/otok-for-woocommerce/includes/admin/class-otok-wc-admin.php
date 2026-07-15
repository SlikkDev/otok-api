<?php
/**
 * Admin settings page.
 *
 * @package OtokWC
 */

defined( 'ABSPATH' ) || exit;

/**
 * Settings page under the WooCommerce menu: connect card, connected-state
 * card, and the health panel shell. Every action requires the
 * `manage_woocommerce` capability and a nonce.
 */
class Otok_WC_Admin {

	const PAGE_SLUG  = 'otok-wc-settings';
	const CAPABILITY = 'manage_woocommerce';

	/**
	 * Credential store.
	 *
	 * @var Otok_WC_Credentials
	 */
	private $credentials;

	/**
	 * Connect client.
	 *
	 * @var Otok_WC_Connect
	 */
	private $connect;

	/**
	 * Consent capture (owns the checkbox-label setting).
	 *
	 * @var Otok_WC_Consent
	 */
	private $consent;

	/**
	 * Guest-email capture (owns the capture + strict-mode settings).
	 *
	 * @var Otok_WC_Guest_Email
	 */
	private $guest_email;

	/**
	 * Outbox (health-panel queue stats).
	 *
	 * @var Otok_WC_Outbox
	 */
	private $outbox;

	/**
	 * Delivery worker (health state, disconnected signal, dispatch kicks).
	 *
	 * @var Otok_WC_Delivery
	 */
	private $delivery;

	/**
	 * Hook suffix of the registered settings page.
	 *
	 * @var string
	 */
	private $page_hook = '';

	/**
	 * Constructor: wire admin hooks.
	 *
	 * @param Otok_WC_Credentials $credentials Credential store.
	 * @param Otok_WC_Connect     $connect     Connect client.
	 * @param Otok_WC_Consent     $consent     Consent capture.
	 * @param Otok_WC_Guest_Email $guest_email Guest-email capture.
	 * @param Otok_WC_Outbox      $outbox      Outbox.
	 * @param Otok_WC_Delivery    $delivery    Delivery worker.
	 */
	public function __construct( Otok_WC_Credentials $credentials, Otok_WC_Connect $connect, Otok_WC_Consent $consent, Otok_WC_Guest_Email $guest_email, Otok_WC_Outbox $outbox, Otok_WC_Delivery $delivery ) {
		$this->credentials = $credentials;
		$this->connect     = $connect;
		$this->consent     = $consent;
		$this->guest_email = $guest_email;
		$this->outbox      = $outbox;
		$this->delivery    = $delivery;

		add_action( 'admin_menu', array( $this, 'register_menu' ) );
		add_action( 'admin_enqueue_scripts', array( $this, 'enqueue_assets' ) );
		add_action( 'admin_notices', array( $this, 'delivery_state_notices' ) );
		add_action( 'admin_post_otok_wc_connect', array( $this, 'handle_connect' ) );
		add_action( 'admin_post_otok_wc_disconnect', array( $this, 'handle_disconnect' ) );
		add_action( 'admin_post_otok_wc_save_consent', array( $this, 'handle_save_consent' ) );
		add_action( 'admin_post_otok_wc_save_capture', array( $this, 'handle_save_capture' ) );
		add_action( 'admin_post_otok_wc_accept_site_url', array( $this, 'handle_accept_site_url' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( OTOK_WC_PLUGIN_FILE ), array( $this, 'plugin_action_links' ) );
	}

	/**
	 * Register the settings page under the WooCommerce menu.
	 *
	 * @return void
	 */
	public function register_menu() {
		$this->page_hook = (string) add_submenu_page(
			'woocommerce',
			__( 'oToK for WooCommerce', 'otok-for-woocommerce' ),
			__( 'oToK', 'otok-for-woocommerce' ),
			self::CAPABILITY,
			self::PAGE_SLUG,
			array( $this, 'render_page' )
		);
	}

	/**
	 * Enqueue the admin stylesheet/script on our page only.
	 *
	 * @param string $hook_suffix Current admin page hook suffix.
	 * @return void
	 */
	public function enqueue_assets( $hook_suffix ) {
		if ( '' === $this->page_hook || $this->page_hook !== $hook_suffix ) {
			return;
		}

		// No RTL sibling sheet: admin.css uses CSS logical properties
		// throughout, so it is direction-correct as-is. Register one (RTLCSS
		// in the build step, not a hand-maintained copy) only if a genuine
		// physical-direction override ever becomes necessary.
		wp_enqueue_style( 'otok-wc-admin', OTOK_WC_PLUGIN_URL . 'assets/css/admin.css', array(), OTOK_WC_VERSION );

		wp_enqueue_script( 'otok-wc-admin', OTOK_WC_PLUGIN_URL . 'assets/js/admin.js', array(), OTOK_WC_VERSION, true );
	}

	/**
	 * Add a Settings link on the plugins-list row.
	 *
	 * @param array $links Existing action links.
	 * @return array
	 */
	public function plugin_action_links( $links ) {
		$settings_link = sprintf(
			'<a href="%s">%s</a>',
			esc_url( $this->page_url() ),
			esc_html__( 'Settings', 'otok-for-woocommerce' )
		);
		array_unshift( $links, $settings_link );
		return $links;
	}

	/**
	 * Render the settings page.
	 *
	 * @return void
	 */
	public function render_page() {
		if ( ! current_user_can( self::CAPABILITY ) ) {
			wp_die( esc_html__( 'You do not have permission to access this page.', 'otok-for-woocommerce' ) );
		}

		$connection = $this->credentials->get_connection();
		$health     = $this->delivery->health();

		$data = array(
			'notice'                => $this->consume_notice(),
			'connected'             => null !== $connection,
			'connection'            => $connection,
			'masked_connection_id'  => $this->credentials->masked_connection_id(),
			'site_url_matches'      => $this->credentials->site_url_matches(),
			'consent_label'         => $this->consent->stored_label(),
			'consent_default_label' => $this->consent->default_label(),
			'guest_email_capture'   => $this->guest_email->is_capture_enabled(),
			'guest_email_strict'    => $this->guest_email->is_strict(),
			'health'                => $health,
			'health_label'          => $this->health_state_label( $health['state'] ),
			'queue_counts'          => $this->outbox->counts(),
			'recent_failures'       => $this->outbox->recent_failures(),
			'diagnostics'           => $this->diagnostics_text(),
		);

		include OTOK_WC_PLUGIN_DIR . 'includes/admin/views/settings-page.php';
	}

	/**
	 * Localized label for a delivery health state. The entitlement pause is
	 * deliberately labeled distinctly from rate limiting.
	 *
	 * @param string $state State key from Otok_WC_Delivery::health().
	 * @return string
	 */
	private function health_state_label( $state ) {
		switch ( $state ) {
			case 'revoked':
				return __( 'Revoked — oToK no longer accepts this connection', 'otok-for-woocommerce' );
			case 'site_mismatch':
				return __( 'Suspended — site URL changed since connecting', 'otok-for-woocommerce' );
			case 'misconfigured':
				return __( 'Paused — stored credentials are unreadable on this server (retrying automatically, nothing is lost). Reconnect the store.', 'otok-for-woocommerce' );
			case 'entitlement_paused':
				return __( 'Paused — oToK plan lapsed (retrying automatically, nothing is lost)', 'otok-for-woocommerce' );
			case 'connected':
				return __( 'Connected', 'otok-for-woocommerce' );
			default:
				return __( 'Not connected', 'otok-for-woocommerce' );
		}
	}

	/**
	 * Global admin notices for delivery-blocking states (revoked connection,
	 * site-URL mismatch) — shown to shop managers on every admin page, since
	 * both states silently stop event delivery until acted on.
	 *
	 * @return void
	 */
	public function delivery_state_notices() {
		if ( ! current_user_can( self::CAPABILITY ) || ! $this->credentials->is_connected() ) {
			return;
		}

		$health = $this->delivery->health();

		if ( 'revoked' === $health['state'] ) {
			printf(
				'<div class="notice notice-error"><p><strong>%s</strong> %s</p><p><a class="button button-primary" href="%s">%s</a></p></div>',
				esc_html__( 'oToK for WooCommerce: connection revoked.', 'otok-for-woocommerce' ),
				esc_html__( 'oToK repeatedly rejected this store\'s credentials, so event delivery is paused. Queued events are kept. Disconnect and reconnect with a fresh code from your oToK workspace.', 'otok-for-woocommerce' ),
				esc_url( $this->page_url() ),
				esc_html__( 'Open oToK settings to reconnect', 'otok-for-woocommerce' )
			);
			return;
		}

		if ( 'misconfigured' === $health['state'] ) {
			printf(
				'<div class="notice notice-error"><p><strong>%s</strong> %s</p><p><a class="button button-primary" href="%s">%s</a></p></div>',
				esc_html__( 'oToK for WooCommerce: connection needs attention.', 'otok-for-woocommerce' ),
				esc_html__( 'This site can no longer use its stored oToK credentials — this usually happens when the wp-config security salts are rotated. Event delivery is paused and queued events are kept. Disconnect and reconnect with a fresh code from your oToK workspace.', 'otok-for-woocommerce' ),
				esc_url( $this->page_url() ),
				esc_html__( 'Open oToK settings to reconnect', 'otok-for-woocommerce' )
			);
			return;
		}

		if ( 'site_mismatch' === $health['state'] ) {
			$accept_url = wp_nonce_url(
				add_query_arg( array( 'action' => 'otok_wc_accept_site_url' ), admin_url( 'admin-post.php' ) ),
				'otok_wc_accept_site_url'
			);

			printf(
				'<div class="notice notice-warning"><p><strong>%s</strong> %s</p><p><a class="button button-primary" href="%s">%s</a> <a class="button" href="%s">%s</a></p></div>',
				esc_html__( 'oToK for WooCommerce: site URL changed.', 'otok-for-woocommerce' ),
				esc_html__( 'This site\'s URL no longer matches the one recorded when the store was connected — this usually means a staging copy or a migrated site. Event delivery is suspended so a clone can never send data into the original connection. Queued events are kept.', 'otok-for-woocommerce' ),
				esc_url( $this->page_url() ),
				esc_html__( 'This is a copy — reconnect it separately', 'otok-for-woocommerce' ),
				esc_url( $accept_url ),
				esc_html__( 'The URL change is expected — resume delivery', 'otok-for-woocommerce' )
			);
		}
	}

	/**
	 * Handle the accept-new-site-URL action from the site-mismatch notice.
	 *
	 * @return void
	 */
	public function handle_accept_site_url() {
		if ( ! current_user_can( self::CAPABILITY ) ) {
			wp_die( esc_html__( 'You do not have permission to do that.', 'otok-for-woocommerce' ) );
		}
		check_admin_referer( 'otok_wc_accept_site_url' );

		$this->credentials->update_site_url_snapshot();
		$this->delivery->schedule_dispatch();

		$this->flash_notice( 'success', __( 'Site URL confirmed — event delivery resumes.', 'otok-for-woocommerce' ) );
		$this->redirect_back();
	}

	/**
	 * Handle the connect form (admin-post.php).
	 *
	 * @return void
	 */
	public function handle_connect() {
		if ( ! current_user_can( self::CAPABILITY ) ) {
			wp_die( esc_html__( 'You do not have permission to do that.', 'otok-for-woocommerce' ) );
		}
		check_admin_referer( 'otok_wc_connect' );

		$code = isset( $_POST['otok_wc_pairing_code'] ) ? sanitize_text_field( wp_unslash( $_POST['otok_wc_pairing_code'] ) ) : '';

		$result = $this->connect->connect( $code );

		if ( is_wp_error( $result ) ) {
			$this->flash_notice( 'error', $result->get_error_message() );
		} else {
			// A fresh connection starts with clean delivery state (auth
			// counters, clock offset, revoked flag), and any backlog queued
			// while disconnected starts draining right away.
			Otok_WC_Delivery::reset_connection_state();
			$this->delivery->schedule_dispatch();
			$this->flash_notice( 'success', __( 'Store connected to oToK.', 'otok-for-woocommerce' ) );
		}

		$this->redirect_back();
	}

	/**
	 * Handle the consent-settings form (admin-post.php).
	 *
	 * Only the checkbox LABEL is editable. There is deliberately no
	 * enable/default-checked setting — the checkbox is always shown and
	 * always starts unchecked (see the Otok_WC_Consent class docblock).
	 *
	 * @return void
	 */
	public function handle_save_consent() {
		if ( ! current_user_can( self::CAPABILITY ) ) {
			wp_die( esc_html__( 'You do not have permission to do that.', 'otok-for-woocommerce' ) );
		}
		check_admin_referer( 'otok_wc_save_consent' );

		$label = isset( $_POST['otok_wc_consent_label'] ) ? sanitize_text_field( wp_unslash( $_POST['otok_wc_consent_label'] ) ) : '';

		$this->consent->save_label( $label );

		$this->flash_notice( 'success', __( 'Consent settings saved.', 'otok-for-woocommerce' ) );
		$this->redirect_back();
	}

	/**
	 * Handle the cart-tracking settings form (admin-post.php): the guest
	 * email capture toggle (default ON) and its strict mode.
	 *
	 * @return void
	 */
	public function handle_save_capture() {
		if ( ! current_user_can( self::CAPABILITY ) ) {
			wp_die( esc_html__( 'You do not have permission to do that.', 'otok-for-woocommerce' ) );
		}
		check_admin_referer( 'otok_wc_save_capture' );

		$this->guest_email->save_settings(
			! empty( $_POST['otok_wc_guest_email_capture'] ),
			! empty( $_POST['otok_wc_guest_email_strict'] )
		);

		$this->flash_notice( 'success', __( 'Cart tracking settings saved.', 'otok-for-woocommerce' ) );
		$this->redirect_back();
	}

	/**
	 * Handle the disconnect form (admin-post.php).
	 *
	 * @return void
	 */
	public function handle_disconnect() {
		if ( ! current_user_can( self::CAPABILITY ) ) {
			wp_die( esc_html__( 'You do not have permission to do that.', 'otok-for-woocommerce' ) );
		}
		check_admin_referer( 'otok_wc_disconnect' );

		// Best-effort `otok/disconnected` BEFORE the local wipe — afterwards
		// the event can no longer be signed. Fire-once, failures ignored.
		// Never sent from a mismatched site (staging clone must stay silent).
		if ( $this->credentials->site_url_matches() ) {
			$this->delivery->send_disconnected( 'disconnected' );
		}

		$this->connect->disconnect();
		Otok_WC_Delivery::reset_connection_state();

		$this->flash_notice( 'success', __( 'Disconnected from oToK on this site. To fully revoke the connection, also remove it in your oToK workspace.', 'otok-for-woocommerce' ) );
		$this->redirect_back();
	}

	/**
	 * Plain-text diagnostics for the copy button. Deliberately not
	 * translated: this block is pasted into support emails to we@otok.io and
	 * must stay machine-comparable. Contains no secrets and no PII — the
	 * connection id is masked and the only URL is the store's own.
	 *
	 * @return string
	 */
	private function diagnostics_text() {
		global $wp_version;

		$connection = $this->credentials->get_connection();
		$connected  = null !== $connection;

		$lines = array(
			'oToK for WooCommerce - diagnostics',
			'Generated (UTC): ' . gmdate( 'Y-m-d H:i:s' ),
			'Plugin version: ' . OTOK_WC_VERSION,
			'WordPress: ' . $wp_version . ( is_multisite() ? ' (multisite)' : '' ),
			'WooCommerce: ' . ( defined( 'WC_VERSION' ) ? WC_VERSION : 'not detected' ),
			'PHP: ' . PHP_VERSION,
			'Connection status: ' . ( $connected ? 'connected' : 'not connected' ),
		);

		if ( $connected ) {
			$lines[] = 'Connection ID (masked): ' . $this->credentials->masked_connection_id();
			$lines[] = 'Connected at (UTC): ' . (string) ( $connection['connected_at'] ?? 'unknown' );
			$lines[] = 'Site URL matches connect-time snapshot: ' . ( $this->credentials->site_url_matches() ? 'yes' : 'NO (site moved or cloned since connect)' );
		}

		$health = $this->delivery->health();
		$counts = $this->outbox->counts();

		$lines[] = 'Delivery state: ' . $health['state'];
		$lines[] = 'Queue depth (pending): ' . $counts['pending'] . ( $counts['sending'] > 0 ? ' (+' . $counts['sending'] . ' in flight)' : '' );
		$lines[] = 'Failed events (retained 30d): ' . $counts['failed'];
		$lines[] = 'Sent events (retained 7d): ' . $counts['sent'];
		$lines[] = 'Last successful delivery (UTC): ' . ( '' !== $health['last_success_at'] ? $health['last_success_at'] : 'never' );
		$lines[] = 'Consecutive auth failures: ' . $health['auth_failures'];
		$lines[] = 'Clock offset applied (s): ' . $health['clock_offset'];

		if ( $health['paused_until'] > time() ) {
			$lines[] = 'Entitlement pause until (UTC): ' . gmdate( 'Y-m-d H:i:s', $health['paused_until'] );
		}
		if ( '' !== $health['revoked_at'] ) {
			$lines[] = 'Revoked at (UTC): ' . $health['revoked_at'];
		}

		// Recent failures: topic + redacted capped error + time only — the
		// errors were PII-redacted at write time and payloads never appear.
		$failures = $this->outbox->recent_failures();
		if ( ! empty( $failures ) ) {
			$lines[] = 'Recent failures:';
			foreach ( $failures as $failure ) {
				$lines[] = '- [' . (string) $failure['created_at'] . ' UTC] ' . (string) $failure['topic'] . ' (' . (string) $failure['status'] . ', attempt ' . (int) $failure['attempts'] . '): ' . (string) $failure['last_error'];
			}
		}

		return implode( "\n", $lines );
	}

	/**
	 * URL of the settings page.
	 *
	 * @return string
	 */
	private function page_url() {
		return add_query_arg( array( 'page' => self::PAGE_SLUG ), admin_url( 'admin.php' ) );
	}

	/**
	 * Store a one-shot admin notice for the current user (transient-backed,
	 * so no state rides the URL and no $_GET handling is needed on render).
	 *
	 * @param string $type    Notice type: 'success' or 'error'.
	 * @param string $message Already-translated message.
	 * @return void
	 */
	private function flash_notice( $type, $message ) {
		set_transient(
			'otok_wc_notice_' . get_current_user_id(),
			array(
				'type'    => $type,
				'message' => $message,
			),
			MINUTE_IN_SECONDS
		);
	}

	/**
	 * Fetch-and-delete the pending notice for the current user.
	 *
	 * @return array|null Array with 'type' and 'message', or null.
	 */
	private function consume_notice() {
		$key    = 'otok_wc_notice_' . get_current_user_id();
		$notice = get_transient( $key );
		if ( ! is_array( $notice ) || empty( $notice['message'] ) ) {
			return null;
		}
		delete_transient( $key );
		return array(
			'type'    => ( 'error' === $notice['type'] ) ? 'error' : 'success',
			'message' => (string) $notice['message'],
		);
	}

	/**
	 * Redirect back to the settings page after an admin-post action.
	 *
	 * @return void
	 */
	private function redirect_back() {
		wp_safe_redirect( $this->page_url() );
		exit;
	}
}
