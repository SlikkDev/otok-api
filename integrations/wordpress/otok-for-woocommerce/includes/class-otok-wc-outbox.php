<?php
/**
 * Outbox — durable local event queue.
 *
 * @package OtokWC
 */

defined( 'ABSPATH' ) || exit;

/**
 * The plugin's durable outbox: every event is frozen into its own table row
 * at enqueue time and delivered (with retries) by Otok_WC_Delivery.
 *
 * Freeze contract: enqueue() mints the `event_id` (the server's dedupe key)
 * and `occurred_at`, builds the envelope via Otok_WC_Payloads, and stores the
 * JSON-encoded envelope as the row's `payload`. From that moment the payload
 * bytes are immutable — every delivery attempt signs and sends the exact
 * same string, so a replay after a lost 2xx dedupes server-side instead of
 * silently dropping newer state. Producers that coalesce (cart debounce) do
 * so strictly PRE-enqueue; a newer snapshot after enqueue is a NEW row with
 * a NEW event_id.
 *
 * Own table (not Action Scheduler args) so payloads stay queryable for the
 * health panel and survive AS housekeeping. Claiming reuses the
 * `next_attempt_at` column as the claim timestamp while a row is `sending`,
 * which keeps the frozen schema and lets the (status, next_attempt_at) index
 * serve both the due-poll and the stuck-claim reclaim.
 *
 * PII retention: `sent` rows purge after 7 days (they exist only for the
 * health panel), `failed` rows after 30 days, and `pending`/`sending` rows
 * that could not be delivered within 30 days (a permanently halted queue —
 * revoked connection, abandoned clone, disconnected store — must not retain
 * customer payloads forever) — purge_retention() runs from a daily Action
 * Scheduler task regardless of connection state. `last_error` is capped and
 * redacted (never emails/phones/payloads) before storage.
 */
class Otok_WC_Outbox {

	/**
	 * Schema version — bump together with a schema change in install();
	 * maybe_upgrade() re-runs dbDelta when the stored version differs.
	 */
	const SCHEMA_VERSION = 1;

	/**
	 * Option holding the installed schema version.
	 */
	const OPTION_SCHEMA = 'otok_wc_outbox_schema';

	/**
	 * Row statuses.
	 */
	const STATUS_PENDING = 'pending';
	const STATUS_SENDING = 'sending';
	const STATUS_SENT    = 'sent';
	const STATUS_FAILED  = 'failed';

	/**
	 * Retention windows (seconds).
	 */
	const RETENTION_SENT   = 7 * DAY_IN_SECONDS;
	const RETENTION_FAILED = 30 * DAY_IN_SECONDS;

	/**
	 * Hard cap for stored last_error strings (column is VARCHAR(255); the
	 * functional cap is tighter so redaction markers always fit).
	 */
	const ERROR_MAX_LENGTH = 200;

	/**
	 * Fully qualified table name.
	 *
	 * @return string
	 */
	public static function table_name() {
		global $wpdb;
		return $wpdb->prefix . 'otok_wc_outbox';
	}

	/**
	 * Create/upgrade the outbox table (dbDelta) and record the schema version.
	 *
	 * Called from the activation hook and from maybe_upgrade() — never on
	 * regular loads.
	 *
	 * @return void
	 */
	public static function install() {
		global $wpdb;

		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$table           = self::table_name();
		$charset_collate = $wpdb->get_charset_collate();

		dbDelta(
			"CREATE TABLE {$table} (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				event_id CHAR(36) NOT NULL,
				topic VARCHAR(64) NOT NULL,
				payload LONGTEXT NOT NULL,
				status VARCHAR(16) NOT NULL DEFAULT 'pending',
				attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
				next_attempt_at DATETIME NULL DEFAULT NULL,
				last_error VARCHAR(255) NOT NULL DEFAULT '',
				created_at DATETIME NOT NULL,
				sent_at DATETIME NULL DEFAULT NULL,
				PRIMARY KEY  (id),
				UNIQUE KEY event_id (event_id),
				KEY status_next (status,next_attempt_at)
			) {$charset_collate};"
		);

		update_option( self::OPTION_SCHEMA, self::SCHEMA_VERSION, false );
	}

	/**
	 * Re-run install() when the plugin was updated by file replacement (which
	 * never re-fires the activation hook). Cheap version compare otherwise.
	 *
	 * @return void
	 */
	public static function maybe_upgrade() {
		if ( self::SCHEMA_VERSION !== (int) get_option( self::OPTION_SCHEMA ) ) {
			self::install();
		}
	}

	/**
	 * Enqueue an event: mint event_id + occurred_at, freeze the envelope
	 * JSON, insert a due-now pending row.
	 *
	 * This does NOT kick the dispatcher — producers go through
	 * Otok_WC_Delivery::enqueue_event(), which enqueues here and then
	 * schedules an immediate dispatch run.
	 *
	 * @param string $topic One of the Otok_WC_Payloads::TOPIC_* constants.
	 * @param array  $data  Topic-specific payload (shape owned by Otok_WC_Payloads).
	 * @return string|WP_Error The minted event_id, or WP_Error on an unknown
	 *                         topic / unencodable payload / insert failure.
	 */
	public function enqueue( $topic, $data ) {
		global $wpdb;

		if ( ! Otok_WC_Payloads::is_known_topic( $topic ) ) {
			return new WP_Error( 'otok_wc_unknown_topic', 'Unknown outbox topic: ' . $topic );
		}

		$event_id    = wp_generate_uuid4();
		$occurred_at = Otok_WC_Payloads::now_iso8601();
		$payload     = wp_json_encode( Otok_WC_Payloads::envelope( $event_id, $topic, $occurred_at, $data ) );

		if ( false === $payload ) {
			return new WP_Error( 'otok_wc_payload_encoding', 'Outbox payload could not be JSON-encoded.' );
		}

		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery -- plugin-owned custom table; no WP API covers it.
		$inserted = $wpdb->insert(
			self::table_name(),
			array(
				'event_id'        => $event_id,
				'topic'           => (string) $topic,
				'payload'         => $payload,
				'status'          => self::STATUS_PENDING,
				'attempts'        => 0,
				'next_attempt_at' => gmdate( 'Y-m-d H:i:s' ),
				'last_error'      => '',
				'created_at'      => gmdate( 'Y-m-d H:i:s' ),
				'sent_at'         => null,
			),
			// wpdb writes SQL NULL for a null value regardless of its format
			// specifier — '%s' documents the column type instead of leaning
			// on that special case with a literal null in the format array.
			array( '%s', '%s', '%s', '%s', '%d', '%s', '%s', '%s', '%s' )
		);

		if ( false === $inserted ) {
			return new WP_Error( 'otok_wc_enqueue_failed', 'Outbox insert failed.' );
		}

		return $event_id;
	}

	/**
	 * Return stale `sending` rows to `pending`.
	 *
	 * While a row is `sending`, next_attempt_at holds the claim time (see
	 * claim_next()); a worker that died mid-POST leaves the row stranded, so
	 * anything claimed longer than $timeout seconds ago is reclaimed.
	 *
	 * @param int $timeout Claim timeout in seconds.
	 * @return void
	 */
	public function reclaim_stuck( $timeout ) {
		global $wpdb;

		$table  = self::table_name();
		$cutoff = gmdate( 'Y-m-d H:i:s', time() - max( 60, (int) $timeout ) );

		// phpcs:disable WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- plugin-owned custom table (name from a trusted constant); queue rows are never cached.
		$wpdb->query(
			$wpdb->prepare(
				"UPDATE {$table} SET status = %s WHERE status = %s AND next_attempt_at <= %s",
				self::STATUS_PENDING,
				self::STATUS_SENDING,
				$cutoff
			)
		);
		// phpcs:enable WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
	}

	/**
	 * Atomically claim the next due pending row.
	 *
	 * Two-step claim, race-safe without extra columns: pick a candidate id,
	 * then flip it pending→sending with a conditional UPDATE — the worker
	 * that got rows_affected = 1 owns the row; a loser just tries the next
	 * candidate. The claim stamps next_attempt_at with the claim time for
	 * reclaim_stuck().
	 *
	 * Invariant: a `pending` row ALWAYS carries a concrete next_attempt_at
	 * (enqueue() stamps now, mark_retry() stamps the retry time,
	 * reclaim_stuck() keeps the claim time) — the due predicate here and in
	 * has_due() deliberately has no IS NULL branch, and the two MUST stay in
	 * agreement or run_queue()'s has_due→dispatch follow-up would hot-loop on
	 * a row claim_next() can never return.
	 *
	 * @return array|null Owned row (associative), or null when nothing is due.
	 */
	public function claim_next() {
		global $wpdb;

		$table = self::table_name();
		$now   = gmdate( 'Y-m-d H:i:s' );

		// phpcs:disable WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- plugin-owned custom table (name from a trusted constant); queue rows are never cached.
		for ( $i = 0; $i < 3; $i++ ) {
			$candidate_id = $wpdb->get_var(
				$wpdb->prepare(
					"SELECT id FROM {$table} WHERE status = %s AND next_attempt_at <= %s ORDER BY id ASC LIMIT 1",
					self::STATUS_PENDING,
					$now
				)
			);

			if ( null === $candidate_id ) {
				return null;
			}

			$claimed = $wpdb->query(
				$wpdb->prepare(
					"UPDATE {$table} SET status = %s, next_attempt_at = %s WHERE id = %d AND status = %s",
					self::STATUS_SENDING,
					$now,
					(int) $candidate_id,
					self::STATUS_PENDING
				)
			);

			if ( 1 === (int) $claimed ) {
				$row = $wpdb->get_row(
					$wpdb->prepare( "SELECT * FROM {$table} WHERE id = %d", (int) $candidate_id ),
					ARRAY_A
				);
				return is_array( $row ) ? $row : null;
			}
		}
		// phpcs:enable WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared

		return null;
	}

	/**
	 * Mark a row delivered.
	 *
	 * @param int $id Row id.
	 * @return void
	 */
	public function mark_sent( $id ) {
		$this->update_row(
			$id,
			array(
				'status'          => self::STATUS_SENT,
				'sent_at'         => gmdate( 'Y-m-d H:i:s' ),
				'next_attempt_at' => null,
				'last_error'      => '',
			)
		);
	}

	/**
	 * Return a row to pending for a later attempt.
	 *
	 * @param int    $id              Row id.
	 * @param int    $attempts        New attempts count (unchanged for a
	 *                                queue-level pause, incremented for a real
	 *                                delivery failure — the caller decides).
	 * @param int    $next_attempt_ts Unix timestamp of the next attempt.
	 * @param string $error           Raw error note; redacted + capped here.
	 * @return void
	 */
	public function mark_retry( $id, $attempts, $next_attempt_ts, $error ) {
		$this->update_row(
			$id,
			array(
				'status'          => self::STATUS_PENDING,
				'attempts'        => max( 0, (int) $attempts ),
				'next_attempt_at' => gmdate( 'Y-m-d H:i:s', (int) $next_attempt_ts ),
				'last_error'      => self::redact( $error ),
			)
		);
	}

	/**
	 * Mark a row permanently failed (kept for the health panel until the
	 * 30-day retention purge).
	 *
	 * @param int    $id       Row id.
	 * @param int    $attempts Final attempts count.
	 * @param string $error    Raw error note; redacted + capped here.
	 * @return void
	 */
	public function mark_failed( $id, $attempts, $error ) {
		$this->update_row(
			$id,
			array(
				'status'          => self::STATUS_FAILED,
				'attempts'        => max( 0, (int) $attempts ),
				'next_attempt_at' => null,
				'last_error'      => self::redact( $error ),
			)
		);
	}

	/**
	 * Whether any pending row is due now. The due predicate must match
	 * claim_next()'s — see the invariant note there.
	 *
	 * @return bool
	 */
	public function has_due() {
		global $wpdb;

		$table = self::table_name();

		// phpcs:disable WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- plugin-owned custom table (name from a trusted constant); queue rows are never cached.
		$id = $wpdb->get_var(
			$wpdb->prepare(
				"SELECT id FROM {$table} WHERE status = %s AND next_attempt_at <= %s LIMIT 1",
				self::STATUS_PENDING,
				gmdate( 'Y-m-d H:i:s' )
			)
		);
		// phpcs:enable WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared

		return null !== $id;
	}

	/**
	 * Unix timestamp of the earliest future pending attempt, or 0 when none.
	 *
	 * @return int
	 */
	public function next_due_at() {
		global $wpdb;

		$table = self::table_name();

		// phpcs:disable WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- plugin-owned custom table (name from a trusted constant); queue rows are never cached.
		$next = $wpdb->get_var(
			$wpdb->prepare(
				"SELECT MIN(next_attempt_at) FROM {$table} WHERE status = %s",
				self::STATUS_PENDING
			)
		);
		// phpcs:enable WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared

		if ( ! is_string( $next ) || '' === $next ) {
			return 0;
		}

		$ts = strtotime( $next . ' UTC' );
		return false === $ts ? 0 : $ts;
	}

	/**
	 * Row counts by status, for the health panel.
	 *
	 * @return array{pending:int,sending:int,sent:int,failed:int}
	 */
	public function counts() {
		global $wpdb;

		$counts = array(
			self::STATUS_PENDING => 0,
			self::STATUS_SENDING => 0,
			self::STATUS_SENT    => 0,
			self::STATUS_FAILED  => 0,
		);

		// phpcs:disable WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.NotPrepared -- plugin-owned custom table (name from a trusted constant, no user input); health-panel read, never cached.
		$rows = $wpdb->get_results(
			'SELECT status, COUNT(*) AS n FROM ' . self::table_name() . ' GROUP BY status',
			ARRAY_A
		);
		// phpcs:enable WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.NotPrepared

		foreach ( (array) $rows as $row ) {
			if ( isset( $row['status'], $counts[ $row['status'] ] ) ) {
				$counts[ $row['status'] ] = (int) $row['n'];
			}
		}

		return $counts;
	}

	/**
	 * Recent rows carrying an error note, newest first — the health panel's
	 * failure list. Errors were redacted at write time; the panel escapes on
	 * render.
	 *
	 * @param int $limit Max rows.
	 * @return array[] Rows with topic, status, attempts, last_error, created_at.
	 */
	public function recent_failures( $limit = 5 ) {
		global $wpdb;

		$table = self::table_name();

		// phpcs:disable WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- plugin-owned custom table (name from a trusted constant); health-panel read, never cached.
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT topic, status, attempts, last_error, created_at FROM {$table} WHERE last_error <> '' ORDER BY id DESC LIMIT %d",
				max( 1, (int) $limit )
			),
			ARRAY_A
		);
		// phpcs:enable WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared

		return is_array( $rows ) ? $rows : array();
	}

	/**
	 * Delete rows past their retention window: sent after 7 days (by
	 * sent_at), failed after 30 days (by created_at), and undelivered
	 * pending/sending rows after 30 days (by created_at) — a row that could
	 * not leave within the ~29h retry horizon plus a generous reconnect
	 * window is dead weight, and a permanently suspended queue (revoked,
	 * site-mismatched clone, disconnected store) must not retain customer
	 * payloads indefinitely. Runs from the daily Action Scheduler purge task.
	 *
	 * @return void
	 */
	public function purge_retention() {
		global $wpdb;

		$table = self::table_name();

		// phpcs:disable WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- plugin-owned custom table (name from a trusted constant); retention sweep.
		$wpdb->query(
			$wpdb->prepare(
				"DELETE FROM {$table} WHERE status = %s AND sent_at IS NOT NULL AND sent_at < %s",
				self::STATUS_SENT,
				gmdate( 'Y-m-d H:i:s', time() - self::RETENTION_SENT )
			)
		);

		$wpdb->query(
			$wpdb->prepare(
				"DELETE FROM {$table} WHERE status = %s AND created_at < %s",
				self::STATUS_FAILED,
				gmdate( 'Y-m-d H:i:s', time() - self::RETENTION_FAILED )
			)
		);

		$wpdb->query(
			$wpdb->prepare(
				"DELETE FROM {$table} WHERE status IN (%s, %s) AND created_at < %s",
				self::STATUS_PENDING,
				self::STATUS_SENDING,
				gmdate( 'Y-m-d H:i:s', time() - self::RETENTION_FAILED )
			)
		);
		// phpcs:enable WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.InterpolatedNotPrepared
	}

	/**
	 * Redact + cap an error note for storage: strip tags, collapse
	 * whitespace, replace email- and phone-shaped substrings, cap at
	 * ERROR_MAX_LENGTH.
	 *
	 * Scope (honest claim): redaction is SHAPE-BASED and covers emails and
	 * phone numbers only — the two identifiers our own payloads carry. Free
	 * text of other shapes (a name or address the oToK server chose to echo
	 * into an error body) is not detected; the length cap and the trusted
	 * upstream bound that residual exposure. Payloads themselves never pass
	 * through here.
	 *
	 * @param string $error Raw error text.
	 * @return string
	 */
	public static function redact( $error ) {
		$error = wp_strip_all_tags( (string) $error );
		$error = trim( (string) preg_replace( '/\s+/', ' ', $error ) );

		// Email-shaped substrings.
		$error = (string) preg_replace( '/[^\s@"\']+@[^\s@"\']+\.[^\s@"\']+/', '[redacted]', $error );

		// Phone-shaped substrings: 7+ digits allowing separators.
		$error = (string) preg_replace( '/\+?\d[\d\s().-]{5,}\d/', '[redacted]', $error );

		if ( mb_strlen( $error ) > self::ERROR_MAX_LENGTH ) {
			$error = mb_substr( $error, 0, self::ERROR_MAX_LENGTH ) . '…';
		}

		return $error;
	}

	/**
	 * Shared UPDATE helper for the mark_* methods.
	 *
	 * @param int   $id     Row id.
	 * @param array $fields Column => value map.
	 * @return void
	 */
	private function update_row( $id, $fields ) {
		global $wpdb;

		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- plugin-owned custom table; queue rows are never cached.
		$wpdb->update( self::table_name(), $fields, array( 'id' => (int) $id ) );
	}
}
