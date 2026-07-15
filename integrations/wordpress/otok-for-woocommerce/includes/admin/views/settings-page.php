<?php
/**
 * Settings page view.
 *
 * Rendered by Otok_WC_Admin::render_page(), which provides $data:
 * notice, connected, connection, masked_connection_id, site_url_matches,
 * consent_label, consent_default_label, guest_email_capture,
 * guest_email_strict, health, health_label, queue_counts, recent_failures,
 * diagnostics.
 *
 * @package OtokWC
 */

defined( 'ABSPATH' ) || exit;
?>
<div class="wrap otok-wc-settings">
	<h1><?php esc_html_e( 'oToK for WooCommerce', 'otok-for-woocommerce' ); ?></h1>

	<?php if ( ! empty( $data['notice'] ) ) : ?>
		<div class="notice notice-<?php echo esc_attr( $data['notice']['type'] ); ?> is-dismissible">
			<p><?php echo esc_html( $data['notice']['message'] ); ?></p>
		</div>
	<?php endif; ?>

	<?php if ( ! $data['connected'] ) : ?>

		<div class="otok-wc-card">
			<h2><?php esc_html_e( 'Connect to oToK', 'otok-for-woocommerce' ); ?></h2>
			<p><?php esc_html_e( 'Generate a one-time connect code on the WooCommerce connect screen in your oToK workspace, then paste it here. The code is exchanged once over HTTPS and never stored.', 'otok-for-woocommerce' ); ?></p>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<input type="hidden" name="action" value="otok_wc_connect" />
				<?php wp_nonce_field( 'otok_wc_connect' ); ?>
				<p>
					<label class="otok-wc-field-label" for="otok_wc_pairing_code"><?php esc_html_e( 'One-time connect code', 'otok-for-woocommerce' ); ?></label>
					<input type="text"
						id="otok_wc_pairing_code"
						name="otok_wc_pairing_code"
						class="regular-text code"
						required
						autocomplete="off"
						spellcheck="false" />
				</p>
				<?php submit_button( __( 'Connect', 'otok-for-woocommerce' ), 'primary', 'submit', false ); ?>
			</form>
		</div>

	<?php else : ?>

		<div class="otok-wc-card">
			<h2><?php esc_html_e( 'Connected to oToK', 'otok-for-woocommerce' ); ?></h2>
			<table class="otok-wc-table">
				<tbody>
					<tr>
						<th scope="row"><?php esc_html_e( 'Connection ID', 'otok-for-woocommerce' ); ?></th>
						<td><code><?php echo esc_html( $data['masked_connection_id'] ); ?></code></td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'Connected on', 'otok-for-woocommerce' ); ?></th>
						<td>
						<?php
						$otok_wc_connected_at = (string) ( $data['connection']['connected_at'] ?? '' );
						$otok_wc_connected_ts = '' !== $otok_wc_connected_at ? strtotime( $otok_wc_connected_at ) : false;
						echo esc_html( $otok_wc_connected_ts ? wp_date( get_option( 'date_format' ) . ' ' . get_option( 'time_format' ), $otok_wc_connected_ts ) : $otok_wc_connected_at );
						?>
						</td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'Site URL check', 'otok-for-woocommerce' ); ?></th>
						<td>
							<?php if ( $data['site_url_matches'] ) : ?>
								<span class="otok-wc-status otok-wc-status--ok"><?php esc_html_e( 'Matches the connect-time snapshot', 'otok-for-woocommerce' ); ?></span>
							<?php else : ?>
								<span class="otok-wc-status otok-wc-status--warn"><?php esc_html_e( 'Site URL changed since connecting — if this site was moved or cloned, reconnect it to oToK.', 'otok-for-woocommerce' ); ?></span>
							<?php endif; ?>
						</td>
					</tr>
				</tbody>
			</table>
			<form method="post"
				action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>"
				id="otok-wc-disconnect-form"
				data-confirm="<?php esc_attr_e( 'Disconnect this store from oToK? Events will stop flowing until you reconnect.', 'otok-for-woocommerce' ); ?>">
				<input type="hidden" name="action" value="otok_wc_disconnect" />
				<?php wp_nonce_field( 'otok_wc_disconnect' ); ?>
				<?php submit_button( __( 'Disconnect', 'otok-for-woocommerce' ), 'delete', 'submit', false ); ?>
			</form>
		</div>

	<?php endif; ?>

	<div class="otok-wc-card">
		<h2><?php esc_html_e( 'Marketing consent at checkout', 'otok-for-woocommerce' ); ?></h2>
		<p><?php esc_html_e( 'Shoppers see this checkbox at checkout — in the order information step of the Checkout block, and after the email field on the classic checkout. Their choice is recorded on the order.', 'otok-for-woocommerce' ); ?></p>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
			<input type="hidden" name="action" value="otok_wc_save_consent" />
			<?php wp_nonce_field( 'otok_wc_save_consent' ); ?>
			<p>
				<label class="otok-wc-field-label" for="otok_wc_consent_label"><?php esc_html_e( 'Checkbox label', 'otok-for-woocommerce' ); ?></label>
				<input type="text"
					id="otok_wc_consent_label"
					name="otok_wc_consent_label"
					class="large-text"
					maxlength="500"
					value="<?php echo esc_attr( $data['consent_label'] ); ?>"
					placeholder="<?php echo esc_attr( $data['consent_default_label'] ); ?>" />
				<span class="otok-wc-field-hint"><?php esc_html_e( 'Plain text only. Leave empty to use the default label.', 'otok-for-woocommerce' ); ?></span>
			</p>
			<p class="otok-wc-field-hint">
				<?php esc_html_e( 'The checkbox is always shown and always starts unchecked. Express opt-in laws (such as the Israeli spam law and the GDPR) do not allow pre-ticked marketing consent, so there is deliberately no setting to change this.', 'otok-for-woocommerce' ); ?>
			</p>
			<?php submit_button( __( 'Save consent settings', 'otok-for-woocommerce' ), 'primary', 'submit', false ); ?>
		</form>
	</div>

	<div class="otok-wc-card">
		<h2><?php esc_html_e( 'Cart tracking', 'otok-for-woocommerce' ); ?></h2>
		<p><?php esc_html_e( 'Cart activity is sent to oToK as raw snapshots so abandoned-cart automations can run there. Whether and when a cart counts as abandoned is decided in your oToK workspace, not by this plugin.', 'otok-for-woocommerce' ); ?></p>
		<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
			<input type="hidden" name="action" value="otok_wc_save_capture" />
			<?php wp_nonce_field( 'otok_wc_save_capture' ); ?>
			<p>
				<label for="otok_wc_guest_email_capture">
					<input type="checkbox"
						id="otok_wc_guest_email_capture"
						name="otok_wc_guest_email_capture"
						value="1"
						<?php checked( $data['guest_email_capture'] ); ?> />
					<?php esc_html_e( 'Capture the email address guests type at checkout', 'otok-for-woocommerce' ); ?>
				</label>
				<span class="otok-wc-field-hint"><?php esc_html_e( 'Lets oToK match an abandoned cart to a contact before an order exists. The address is kept only in the shopper\'s WooCommerce session and attached to cart events — it is never logged or stored elsewhere.', 'otok-for-woocommerce' ); ?></span>
			</p>
			<p>
				<label for="otok_wc_guest_email_strict">
					<input type="checkbox"
						id="otok_wc_guest_email_strict"
						name="otok_wc_guest_email_strict"
						value="1"
						<?php checked( $data['guest_email_strict'] ); ?> />
					<?php esc_html_e( 'Strict mode: attach the captured email only after the shopper ticks the marketing-consent checkbox', 'otok-for-woocommerce' ); ?>
				</label>
				<span class="otok-wc-field-hint"><?php esc_html_e( 'Conservative option for stores that do not want to send a guest\'s email with cart events before an explicit opt-in. Cart events themselves are always sent; only the captured guest email is held back. Applies to the classic checkout; on the Checkout block the email is held back until the order is placed.', 'otok-for-woocommerce' ); ?></span>
			</p>
			<?php submit_button( __( 'Save cart tracking settings', 'otok-for-woocommerce' ), 'primary', 'submit', false ); ?>
		</form>
	</div>

	<div class="otok-wc-card">
		<h2><?php esc_html_e( 'Health', 'otok-for-woocommerce' ); ?></h2>
		<table class="otok-wc-table">
			<tbody>
				<tr>
					<th scope="row"><?php esc_html_e( 'Delivery state', 'otok-for-woocommerce' ); ?></th>
					<td>
						<?php $otok_wc_state_class = ( 'connected' === $data['health']['state'] ) ? 'ok' : 'warn'; ?>
						<span class="otok-wc-status otok-wc-status--<?php echo esc_attr( $otok_wc_state_class ); ?>"><?php echo esc_html( $data['health_label'] ); ?></span>
						<?php if ( 'revoked' === $data['health']['state'] ) : ?>
							<p class="otok-wc-field-hint"><?php esc_html_e( 'Queued events are kept. Disconnect above, generate a fresh connect code in your oToK workspace, and reconnect to resume delivery.', 'otok-for-woocommerce' ); ?></p>
						<?php endif; ?>
					</td>
				</tr>
				<tr>
					<th scope="row"><?php esc_html_e( 'Queue depth', 'otok-for-woocommerce' ); ?></th>
					<td>
						<?php
						printf(
							/* translators: 1: number of queued (pending) events, 2: number of permanently failed events. */
							esc_html__( '%1$s pending / %2$s failed', 'otok-for-woocommerce' ),
							esc_html( number_format_i18n( $data['queue_counts']['pending'] + $data['queue_counts']['sending'] ) ),
							esc_html( number_format_i18n( $data['queue_counts']['failed'] ) )
						);
						?>
					</td>
				</tr>
				<tr>
					<th scope="row"><?php esc_html_e( 'Last successful delivery', 'otok-for-woocommerce' ); ?></th>
					<td>
						<?php
						$otok_wc_last_success    = (string) $data['health']['last_success_at'];
						$otok_wc_last_success_ts = '' !== $otok_wc_last_success ? strtotime( $otok_wc_last_success ) : false;
						if ( $otok_wc_last_success_ts ) {
							echo esc_html( wp_date( get_option( 'date_format' ) . ' ' . get_option( 'time_format' ), $otok_wc_last_success_ts ) );
						} else {
							esc_html_e( 'No deliveries yet', 'otok-for-woocommerce' );
						}
						?>
					</td>
				</tr>
			</tbody>
		</table>

		<?php if ( ! empty( $data['recent_failures'] ) ) : ?>
			<h3><?php esc_html_e( 'Recent delivery failures', 'otok-for-woocommerce' ); ?></h3>
			<table class="otok-wc-table">
				<thead>
					<tr>
						<th scope="col"><?php esc_html_e( 'Time (UTC)', 'otok-for-woocommerce' ); ?></th>
						<th scope="col"><?php esc_html_e( 'Event', 'otok-for-woocommerce' ); ?></th>
						<th scope="col"><?php esc_html_e( 'Status', 'otok-for-woocommerce' ); ?></th>
						<th scope="col"><?php esc_html_e( 'Error', 'otok-for-woocommerce' ); ?></th>
					</tr>
				</thead>
				<tbody>
					<?php foreach ( $data['recent_failures'] as $otok_wc_failure ) : ?>
						<tr>
							<td><?php echo esc_html( (string) $otok_wc_failure['created_at'] ); ?></td>
							<td><code><?php echo esc_html( (string) $otok_wc_failure['topic'] ); ?></code></td>
							<td><?php echo esc_html( (string) $otok_wc_failure['status'] ); ?></td>
							<td><?php echo esc_html( (string) $otok_wc_failure['last_error'] ); ?></td>
						</tr>
					<?php endforeach; ?>
				</tbody>
			</table>
		<?php endif; ?>

		<h3><?php esc_html_e( 'Diagnostics', 'otok-for-woocommerce' ); ?></h3>
		<p><?php esc_html_e( 'Copy this block into a support email. It contains version and status information only — no secrets and no customer data.', 'otok-for-woocommerce' ); ?></p>
		<textarea id="otok-wc-diagnostics" class="otok-wc-diagnostics" rows="12" readonly><?php echo esc_textarea( $data['diagnostics'] ); ?></textarea>
		<p>
			<button type="button"
				id="otok-wc-copy-diagnostics"
				class="button"
				data-copied="<?php esc_attr_e( 'Copied!', 'otok-for-woocommerce' ); ?>"
				data-failed="<?php esc_attr_e( 'Copy failed — select the text and copy it manually.', 'otok-for-woocommerce' ); ?>">
				<?php esc_html_e( 'Copy diagnostics', 'otok-for-woocommerce' ); ?>
			</button>
			<?php // Live region: the button's swapped label alone is not reliably announced by screen readers; admin.js mirrors the feedback here. ?>
			<span id="otok-wc-copy-status" class="screen-reader-text" role="status" aria-live="polite"></span>
		</p>
	</div>

	<p class="otok-wc-support">
		<?php
		printf(
			/* translators: %s: support email address link. */
			esc_html__( 'Need help? Email %s.', 'otok-for-woocommerce' ),
			'<a href="mailto:we@otok.io">we@otok.io</a>'
		);
		?>
	</p>
</div>
