<?php
/**
 * Connection credential store.
 *
 * @package OtokWC
 */

defined( 'ABSPATH' ) || exit;

/**
 * Stores the oToK connection record and the signing secret.
 *
 * One oToK connection per site (single-connection cardinality). The
 * connection record (`otok_wc_connection`) holds non-secret metadata,
 * including a snapshot of the site URL taken at connect time — the
 * staging/clone guard in the delivery dispatcher compares it at dispatch time so a cloned
 * site cannot post events into the production connection.
 *
 * Secret at rest — honest blast radius
 * ------------------------------------
 * The signing secret is encrypted with libsodium (XSalsa20-Poly1305 via
 * sodium_crypto_secretbox) using a key derived with hash_hkdf() from the
 * wp-config authentication salts. The salts live in the filesystem — a
 * different compromise class than the database — so a DB-only leak (SQL
 * injection in another plugin, an off-site DB dump) does not yield a usable
 * secret. This deliberately does NOT protect against an attacker with full
 * DB **and** wp-config/filesystem access: such an attacker can derive the
 * key and decrypt. Additionally, wp_salt() falls back to DB-stored secrets
 * when the wp-config constants are missing, in which case the encryption
 * degrades to obfuscation. If the secret ever leaks, revoking the
 * connection in oToK kills it. The secret is never echoed back into admin
 * HTML after save — the UI only ever shows masked values.
 */
class Otok_WC_Credentials {

	const OPTION_CONNECTION = 'otok_wc_connection';
	const OPTION_SECRET     = 'otok_wc_signing_secret';

	/**
	 * Versioned prefix for the encrypted blob, so the scheme can rotate later.
	 */
	const CIPHER_PREFIX = 'v1:';

	/**
	 * Persist a freshly exchanged connection. All-or-nothing: the secret is
	 * encrypted first, and nothing is written if encryption fails.
	 *
	 * @param string $connection_id  Connection id returned by the pairing exchange.
	 * @param string $base_url       oToK base URL the exchange ran against.
	 * @param string $signing_secret Plaintext signing secret returned by the exchange.
	 * @return true|WP_Error True on success, WP_Error when the secret could not be encrypted.
	 */
	public function save_connection( $connection_id, $base_url, $signing_secret ) {
		$encrypted = $this->encrypt( $signing_secret );
		if ( is_wp_error( $encrypted ) ) {
			return $encrypted;
		}

		$connection = array(
			'connection_id' => $connection_id,
			'base_url'      => $base_url,
			'site_url'      => site_url(),
			'connected_at'  => gmdate( 'c' ),
			'connected_by'  => get_current_user_id(),
		);

		// Autoload off: neither value is needed on regular front-end loads.
		update_option( self::OPTION_SECRET, $encrypted, false );
		update_option( self::OPTION_CONNECTION, $connection, false );

		return true;
	}

	/**
	 * Get the stored connection record.
	 *
	 * Consumers that dispatch to `base_url` (the delivery dispatcher) must
	 * re-assert the https scheme at send time — defense in depth for records
	 * written by older plugin versions.
	 *
	 * @return array|null Connection record, or null when not connected.
	 */
	public function get_connection() {
		$connection = get_option( self::OPTION_CONNECTION );
		if ( ! is_array( $connection ) || empty( $connection['connection_id'] ) ) {
			return null;
		}
		return $connection;
	}

	/**
	 * Whether a connection is stored.
	 *
	 * @return bool
	 */
	public function is_connected() {
		return null !== $this->get_connection();
	}

	/**
	 * Decrypt and return the signing secret.
	 *
	 * Callers (the delivery dispatcher) must treat the value as sensitive:
	 * never log it, never echo it. Comparisons against it, if ever needed,
	 * must use hash_equals().
	 *
	 * @return string|null Plaintext secret, or null when absent/undecryptable
	 *                     (e.g. the wp-config salts changed since connect).
	 */
	public function get_signing_secret() {
		$blob = get_option( self::OPTION_SECRET );
		if ( ! is_string( $blob ) || '' === $blob ) {
			return null;
		}
		return $this->decrypt( $blob );
	}

	/**
	 * Masked connection id for display (never the full id in UI/diagnostics).
	 *
	 * @return string Masked id, or an empty string when not connected.
	 */
	public function masked_connection_id() {
		$connection = $this->get_connection();
		if ( null === $connection ) {
			return '';
		}
		$id = (string) $connection['connection_id'];
		return str_repeat( '*', 4 ) . substr( $id, -4 );
	}

	/**
	 * Whether the stored connect-time site URL still matches this site.
	 *
	 * @return bool True when connected and the snapshot matches site_url().
	 */
	public function site_url_matches() {
		$connection = $this->get_connection();
		if ( null === $connection || empty( $connection['site_url'] ) ) {
			return false;
		}
		return untrailingslashit( (string) $connection['site_url'] ) === untrailingslashit( site_url() );
	}

	/**
	 * Re-snapshot the connect-time site URL to the CURRENT site_url().
	 *
	 * Only for the explicit "this URL change is expected" admin action on the
	 * site-mismatch notice (nonce + manage_woocommerce, handled in
	 * Otok_WC_Admin) — never called automatically, so a cloned site cannot
	 * self-heal into the production connection.
	 *
	 * @return void
	 */
	public function update_site_url_snapshot() {
		$connection = $this->get_connection();
		if ( null === $connection ) {
			return;
		}

		$connection['site_url'] = site_url();
		update_option( self::OPTION_CONNECTION, $connection, false );
	}

	/**
	 * Delete all stored credentials (local disconnect).
	 *
	 * @return void
	 */
	public function delete() {
		delete_option( self::OPTION_SECRET );
		delete_option( self::OPTION_CONNECTION );
	}

	/**
	 * Encrypt a secret for storage.
	 *
	 * @param string $plaintext Secret to encrypt.
	 * @return string|WP_Error Versioned base64 blob, or WP_Error when libsodium is unavailable.
	 */
	private function encrypt( $plaintext ) {
		if ( ! function_exists( 'sodium_crypto_secretbox' ) ) {
			// Refuse to store the secret in plaintext rather than degrade silently.
			return new WP_Error(
				'otok_wc_encryption_unavailable',
				__( 'This server\'s PHP is missing the sodium extension, so the connection secret cannot be stored securely. Ask your host to enable ext/sodium (bundled with PHP since 7.2) and try again.', 'otok-for-woocommerce' )
			);
		}

		$nonce      = random_bytes( SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
		$ciphertext = sodium_crypto_secretbox( $plaintext, $nonce, $this->encryption_key() );

		// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode -- binary-safe transport of ciphertext into wp_options, not obfuscation.
		return self::CIPHER_PREFIX . base64_encode( $nonce . $ciphertext );
	}

	/**
	 * Decrypt a stored blob.
	 *
	 * @param string $blob Versioned base64 blob produced by encrypt().
	 * @return string|null Plaintext, or null on tamper/format/key mismatch.
	 */
	private function decrypt( $blob ) {
		if ( ! function_exists( 'sodium_crypto_secretbox_open' ) ) {
			return null;
		}
		if ( 0 !== strpos( $blob, self::CIPHER_PREFIX ) ) {
			return null;
		}

		// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode -- decoding our own ciphertext blob, not obfuscated code.
		$raw = base64_decode( substr( $blob, strlen( self::CIPHER_PREFIX ) ), true );
		if ( false === $raw || strlen( $raw ) <= SODIUM_CRYPTO_SECRETBOX_NONCEBYTES ) {
			return null;
		}

		$nonce      = substr( $raw, 0, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );
		$ciphertext = substr( $raw, SODIUM_CRYPTO_SECRETBOX_NONCEBYTES );

		try {
			$plaintext = sodium_crypto_secretbox_open( $ciphertext, $nonce, $this->encryption_key() );
		} catch ( SodiumException $e ) {
			return null;
		}

		return ( false === $plaintext ) ? null : $plaintext;
	}

	/**
	 * Derive the encryption key from the wp-config auth salts (see class docblock).
	 *
	 * @return string Raw binary key, SODIUM_CRYPTO_SECRETBOX_KEYBYTES long.
	 */
	private function encryption_key() {
		return hash_hkdf(
			'sha256',
			wp_salt( 'auth' ) . wp_salt( 'secure_auth' ),
			SODIUM_CRYPTO_SECRETBOX_KEYBYTES,
			'otok-wc-signing-secret'
		);
	}
}
