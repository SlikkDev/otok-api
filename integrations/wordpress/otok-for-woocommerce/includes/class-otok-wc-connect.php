<?php
/**
 * Pairing-code connect client.
 *
 * @package OtokWC
 */

defined( 'ABSPATH' ) || exit;

if ( ! defined( 'OTOK_WC_PAIRING_PATH' ) ) {
	/**
	 * FROZEN — pairing-token exchange endpoint path (the normative oToK
	 * e-commerce wire contract §9):
	 * one-time token in, `{connection_id, signing_secret}` out (plaintext
	 * exactly once); every failure is a uniform 404. The constant + the
	 * `otok_wc_pairing_path` filter remain as a coordinated-version-bump
	 * seam only.
	 */
	define( 'OTOK_WC_PAIRING_PATH', '/api/ecommerce/pair/woocommerce' );
}

/**
 * Exchanges a pasted one-time connect code for connection credentials.
 *
 * The store owner generates the code in the oToK Woo connect UI and pastes
 * it into the plugin's settings page; this client POSTs it to the oToK host
 * over HTTPS (the plugin pins `sslverify => true` and `redirection => 0` on
 * its own request and exposes no filter to weaken either; site-wide WP
 * HTTP-API filters such as `http_request_args` can theoretically still
 * override them — a residual risk inherent to the WP HTTP API) and stores
 * the returned credentials via Otok_WC_Credentials. A failed exchange never
 * persists partial credentials, and the pasted code itself is never
 * persisted anywhere.
 */
class Otok_WC_Connect {

	/**
	 * Default oToK host. Overridable via the `otok_wc_base_url` filter
	 * (HTTPS is enforced regardless of the filter's return value).
	 */
	const DEFAULT_BASE_URL = 'https://app.otok.io';

	/**
	 * Credential store.
	 *
	 * @var Otok_WC_Credentials
	 */
	private $credentials;

	/**
	 * Constructor.
	 *
	 * @param Otok_WC_Credentials $credentials Credential store.
	 */
	public function __construct( Otok_WC_Credentials $credentials ) {
		$this->credentials = $credentials;
	}

	/**
	 * The oToK base URL (no trailing slash).
	 *
	 * @return string
	 */
	public function get_base_url() {
		/**
		 * Filters the oToK host the plugin talks to.
		 *
		 * @param string $base_url Default oToK base URL.
		 */
		$base_url = apply_filters( 'otok_wc_base_url', self::DEFAULT_BASE_URL );

		return untrailingslashit( (string) $base_url );
	}

	/**
	 * The oToK base URL, sanitized and HTTPS-validated.
	 *
	 * Resolved exactly once per operation: connect() derives both the
	 * exchange URL and the persisted `base_url` from one call, so a
	 * non-deterministic `otok_wc_base_url` filter cannot pass validation
	 * with one value and store another.
	 *
	 * @return string|WP_Error Sanitized HTTPS base URL (no trailing slash), or WP_Error.
	 */
	public function get_validated_base_url() {
		$base_url = esc_url_raw( $this->get_base_url() );

		if ( '' === $base_url || 'https' !== wp_parse_url( $base_url, PHP_URL_SCHEME ) ) {
			return new WP_Error(
				'otok_wc_insecure_url',
				__( 'The oToK service URL must use HTTPS.', 'otok-for-woocommerce' )
			);
		}

		return $base_url;
	}

	/**
	 * Full pairing-exchange URL for a validated base URL.
	 *
	 * @param string $base_url Base URL returned by get_validated_base_url().
	 * @return string Absolute exchange URL.
	 */
	private function pairing_url( $base_url ) {
		/**
		 * Filters the pairing-exchange endpoint path (FROZEN — see the
		 * OTOK_WC_PAIRING_PATH docblock; override only for a coordinated
		 * contract version bump).
		 *
		 * @param string $path Endpoint path relative to the oToK base URL.
		 */
		$path = apply_filters( 'otok_wc_pairing_path', OTOK_WC_PAIRING_PATH );

		return $base_url . '/' . ltrim( (string) $path, '/' );
	}

	/**
	 * Exchange a one-time connect code for credentials and store them.
	 *
	 * Serialized under a MySQL advisory lock: the is_connected() guard and
	 * save_connection()'s two option writes are check-then-act, so two
	 * concurrent submits (double-click, replayed POST) could otherwise both
	 * pass the guard and interleave their secret/connection-id writes into a
	 * mismatched pair. The lock is held across the exchange POST (rare admin
	 * action, ≤15s); a concurrent attempt fails fast with a clear message
	 * instead of burning its one-time code.
	 *
	 * @param string $pairing_code One-time code pasted by the store owner.
	 * @return true|WP_Error True on success; WP_Error with a user-facing message otherwise.
	 */
	public function connect( $pairing_code ) {
		global $wpdb;

		$lock = $wpdb->prefix . 'otok_wc_connect';

		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- MySQL advisory lock; no WP API exists for it.
		$locked = $wpdb->get_var( $wpdb->prepare( 'SELECT GET_LOCK(%s, %d)', $lock, 2 ) );

		if ( '1' !== (string) $locked ) {
			return new WP_Error(
				'otok_wc_connect_busy',
				__( 'Another connection attempt is already in progress. Please wait a moment and try again.', 'otok-for-woocommerce' )
			);
		}

		$result = $this->do_connect( $pairing_code );

		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- releases the advisory lock above.
		$wpdb->query( $wpdb->prepare( 'SELECT RELEASE_LOCK(%s)', $lock ) );

		return $result;
	}

	/**
	 * The connect() body — runs under the advisory lock.
	 *
	 * @param string $pairing_code One-time code pasted by the store owner.
	 * @return true|WP_Error True on success; WP_Error with a user-facing message otherwise.
	 */
	private function do_connect( $pairing_code ) {
		// Single-connection cardinality is enforced here, at the rule's home:
		// a stale tab or replayed POST must never silently replace a live
		// connection. Replacing = explicit disconnect first.
		if ( $this->credentials->is_connected() ) {
			return new WP_Error(
				'otok_wc_already_connected',
				__( 'This store is already connected to oToK. Disconnect first to connect with a new code.', 'otok-for-woocommerce' )
			);
		}

		$code = preg_replace( '/\s+/', '', (string) $pairing_code );

		if ( '' === $code || strlen( $code ) > 200 || ! preg_match( '/^[A-Za-z0-9._\-]+$/', $code ) ) {
			return new WP_Error(
				'otok_wc_invalid_code',
				__( 'That connect code does not look valid. Paste the one-time code exactly as shown in oToK.', 'otok-for-woocommerce' )
			);
		}

		$base_url = $this->get_validated_base_url();
		if ( is_wp_error( $base_url ) ) {
			return $base_url;
		}

		$response = wp_remote_post(
			$this->pairing_url( $base_url ),
			array(
				'timeout'             => 15,
				// The exchange endpoint has no legitimate reason to redirect;
				// following one could re-POST the one-time code to another
				// host/scheme. A 3xx lands in the non-2xx branch below.
				'redirection'         => 0,
				// WP's default, pinned explicitly so a changed default or
				// audit never leaves this request's TLS posture ambiguous.
				'sslverify'           => true,
				// The expected response is a tiny JSON object — cap the body
				// so a hostile host cannot exhaust PHP memory. A truncated
				// over-limit body fails the credential validation below.
				'limit_response_size' => 64 * KB_IN_BYTES,
				'headers'             => array(
					'Content-Type' => 'application/json',
					'Accept'       => 'application/json',
				),
				'body'                => wp_json_encode( array( 'token' => $code ) ),
				// RFC 7231 product token + parenthesized comment; the site URL
				// is an operator courtesy so oToK can identify the caller.
				'user-agent'          => 'oToK-for-WooCommerce/' . OTOK_WC_VERSION . ' (' . esc_url_raw( site_url() ) . ')',
			)
		);

		if ( is_wp_error( $response ) ) {
			$detail = $this->sanitize_error_detail( $response->get_error_message(), $code );

			return new WP_Error(
				'otok_wc_unreachable',
				'' !== $detail
					? sprintf(
						/* translators: %s: sanitized transport error detail (e.g. timeout, DNS, or TLS message). */
						__( 'Could not reach the oToK service. Check that this server can make outbound HTTPS requests and try again. Details: %s', 'otok-for-woocommerce' ),
						$detail
					)
					: __( 'Could not reach the oToK service. Check that this server can make outbound HTTPS requests and try again.', 'otok-for-woocommerce' ),
				array( 'detail' => $detail )
			);
		}

		$status = (int) wp_remote_retrieve_response_code( $response );

		// The exchange endpoint is rate-limited per IP, so 429 is an expected
		// response — the code was never evaluated and stays valid.
		if ( 429 === $status ) {
			return new WP_Error(
				'otok_wc_rate_limited',
				__( 'Too many connection attempts. Wait a minute and try again with the same code.', 'otok-for-woocommerce' )
			);
		}

		if ( $status >= 400 && $status < 500 ) {
			return new WP_Error(
				'otok_wc_invalid_code',
				__( 'oToK rejected the connect code. Codes are one-time and expire quickly — generate a fresh code in oToK and try again.', 'otok-for-woocommerce' )
			);
		}

		if ( $status < 200 || $status >= 300 ) {
			$detail = $this->sanitize_error_detail( wp_remote_retrieve_body( $response ), $code );
			$detail = 'HTTP ' . $status . ( '' !== $detail ? ' — ' . $detail : '' );

			return new WP_Error(
				'otok_wc_server_error',
				sprintf(
					/* translators: %s: sanitized error detail (HTTP status and response excerpt). */
					__( 'The oToK service returned an unexpected error. Please try again in a few minutes. Details: %s', 'otok-for-woocommerce' ),
					$detail
				),
				array(
					'status' => $status,
					'detail' => $detail,
				)
			);
		}

		$data = json_decode( wp_remote_retrieve_body( $response ), true );

		$connection_id  = ( is_array( $data ) && isset( $data['connection_id'] ) && is_string( $data['connection_id'] ) ) ? trim( $data['connection_id'] ) : '';
		$signing_secret = ( is_array( $data ) && isset( $data['signing_secret'] ) && is_string( $data['signing_secret'] ) ) ? $data['signing_secret'] : '';

		if ( '' === $connection_id || '' === $signing_secret ) {
			return new WP_Error(
				'otok_wc_bad_response',
				__( 'The oToK service returned an unexpected response. Please try again; if it keeps failing, contact we@otok.io.', 'otok-for-woocommerce' )
			);
		}

		// save_connection() is all-or-nothing and snapshots site_url for the
		// staging/clone guard. $base_url is the same validated value the
		// exchange ran against — never re-resolved through the filter.
		$saved = $this->credentials->save_connection( sanitize_text_field( $connection_id ), $base_url, $signing_secret );
		if ( is_wp_error( $saved ) ) {
			return $saved;
		}

		return true;
	}

	/**
	 * Sanitize a transport/server error detail for the admin error notice.
	 *
	 * Strips tags, collapses whitespace, redacts the pasted code should the
	 * server ever echo it back, and caps the length so a hostile or verbose
	 * body cannot flood the notice. Credentials never reach this path — they
	 * only appear in 2xx bodies, which are handled separately. The rendered
	 * notice is escaped at output time by the settings view.
	 *
	 * @param string $detail Raw detail (WP_Error message or response body).
	 * @param string $code   Pairing code to redact from the detail.
	 * @return string Sanitized detail; possibly empty.
	 */
	private function sanitize_error_detail( $detail, $code ) {
		$detail = wp_strip_all_tags( (string) $detail );
		$detail = trim( (string) preg_replace( '/\s+/', ' ', $detail ) );

		if ( '' !== $code ) {
			$detail = str_replace( $code, '[redacted]', $detail );
		}

		if ( mb_strlen( $detail ) > 200 ) {
			$detail = mb_substr( $detail, 0, 200 ) . '…';
		}

		return $detail;
	}

	/**
	 * Disconnect: delete local credentials.
	 *
	 * Local wipe only. The best-effort `otok/disconnected` signal is fired by
	 * the caller (Otok_WC_Admin::handle_disconnect, the deactivation hook)
	 * BEFORE calling this — once the credentials are gone the event can no
	 * longer be signed. The connection should also be revoked from the oToK
	 * workspace for a guaranteed server-side kill.
	 *
	 * @return void
	 */
	public function disconnect() {
		$this->credentials->delete();
	}
}
