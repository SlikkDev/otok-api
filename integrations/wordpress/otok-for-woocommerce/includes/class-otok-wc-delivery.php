<?php
/**
 * Delivery worker — signed HTTP delivery with the frozen retry/revocation policy.
 *
 * @package OtokWC
 */

defined( 'ABSPATH' ) || exit;

/**
 * Drains the outbox to oToK over Action Scheduler.
 *
 * Dispatch model (deliberate choice): SELF-SCHEDULING single/async actions,
 * not a fixed every-minute recurring action. enqueue_event() enqueues an
 * async dispatch action immediately (sub-minute latency for fresh events, no
 * per-minute churn on idle stores), and each dispatch run re-schedules
 * itself: an async follow-up when due work remains after the batch budget,
 * or a dated single action at the earliest future retry time. A burst of
 * events can enqueue a few redundant async runs — each drains the whole due
 * queue, so the extras no-op cheaply; that redundancy also self-heals a lost
 * follow-up action. Only the retention purge is a recurring (daily) action.
 *
 * Delivery contract (FROZEN as part of the oToK e-commerce contract, 2026-07-14):
 * - POST {base}/api/ecommerce/webhooks/woocommerce/{connection_id}, HTTPS
 *   only (re-asserted at send time), sslverify pinned true, redirects 0,
 *   response size capped.
 * - X-Otok-Signature: t=<unix>,v1=<hex hmac-sha256(secret, "{t}.{body}")>,
 *   signing the EXACT frozen payload bytes; t is re-minted per attempt and
 *   shifted by the persisted clock offset.
 * - 2xx = success (server dedupe replays answer 2xx too).
 * - 408/425/429/5xx/network = retryable with exponential backoff
 *   (~1m, 5m, 15m, 1h, 4h, then every 6h; give up after 10 attempts —
 *   ≈29h horizon — status `failed`). Retry-After honored on 429.
 * - 429 + JSON body {"code":"entitlement_paused"} = the workspace's oToK
 *   plan lapsed: the WHOLE queue pauses until Retry-After (default 3600s);
 *   nothing is dropped, attempts are NOT consumed, and the health panel
 *   labels the state distinctly from rate limiting.
 * - Other 4xx = permanent failure (logged to the health panel, no retry).
 *   Any non-2xx status outside the classes above (1xx/3xx/HTTP 0) is
 *   unclassified and treated as retryable — never dropped on first sight.
 * - 401/404 = possible revocation: one shared CONSECUTIVE counter (reset by
 *   any other outcome); at 3 the connection is treated as revoked — the
 *   whole queue pauses and the settings page shows reconnect UX. A single
 *   401 may be clock skew beyond the verifier's tolerance: the offset is
 *   computed from the response's Date header, persisted, applied to t, and
 *   the POST retried ONCE — the occurrence counts toward revocation only if
 *   that retry also fails.
 * - Site guard: if site_url() no longer matches the connect-time snapshot
 *   (staging clone), every dispatch run bails before sending anything; the
 *   admin notice offers reconnect / accept-new-URL.
 */
class Otok_WC_Delivery {

	/**
	 * Action Scheduler hook + group names. Mirrored as string literals in
	 * uninstall.php (which runs without the plugin loaded) — keep in sync.
	 */
	const HOOK_DISPATCH = 'otok_wc_dispatch_outbox';
	const HOOK_PURGE    = 'otok_wc_purge_outbox';
	const AS_GROUP      = 'otok-for-woocommerce';

	/**
	 * Option holding persisted delivery state: consecutive auth-failure
	 * counter, clock offset, revoked flag, entitlement pause, last success.
	 */
	const OPTION_STATE = 'otok_wc_delivery_state';

	/**
	 * MySQL advisory-lock timeout (seconds) for the state read-merge-write
	 * cycle in mutate_state(). Short: the critical section is one option
	 * read + one option write.
	 */
	const STATE_LOCK_TIMEOUT = 2;

	/**
	 * FROZEN — ingest endpoint path prefix (the connection id is appended).
	 * The normative oToK e-commerce wire contract §1; isolated here so a
	 * coordinated version bump is one line.
	 */
	const ENDPOINT_PATH = '/api/ecommerce/webhooks/woocommerce/';

	/**
	 * Retry policy bounds.
	 */
	const MAX_ATTEMPTS              = 10;
	const AUTH_FAILURE_LIMIT        = 3;
	const SKEW_MIN_DELTA            = 30;
	const RETRY_AFTER_CAP           = 6 * HOUR_IN_SECONDS;
	const ENTITLEMENT_PAUSE_DEFAULT = HOUR_IN_SECONDS;
	const ENTITLEMENT_PAUSE_CAP     = DAY_IN_SECONDS;

	/**
	 * Per-run batch budget.
	 */
	const BATCH_LIMIT   = 25;
	const TIME_BUDGET   = 20;
	const CLAIM_TIMEOUT = 10 * MINUTE_IN_SECONDS;

	/**
	 * Credential store.
	 *
	 * @var Otok_WC_Credentials
	 */
	private $credentials;

	/**
	 * Outbox.
	 *
	 * @var Otok_WC_Outbox
	 */
	private $outbox;

	/**
	 * Constructor: register the Action Scheduler callbacks.
	 *
	 * @param Otok_WC_Credentials $credentials Credential store.
	 * @param Otok_WC_Outbox      $outbox      Outbox.
	 */
	public function __construct( Otok_WC_Credentials $credentials, Otok_WC_Outbox $outbox ) {
		$this->credentials = $credentials;
		$this->outbox      = $outbox;

		add_action( self::HOOK_DISPATCH, array( $this, 'run_queue' ) );
		add_action( self::HOOK_PURGE, array( $this, 'run_purge' ) );
		add_action( 'init', array( $this, 'ensure_purge_scheduled' ) );
	}

	/**
	 * THE producer API (Capture stage): freeze an event into the outbox and
	 * kick an immediate dispatch run.
	 *
	 * @param string $topic One of the Otok_WC_Payloads::TOPIC_* constants.
	 * @param array  $data  Topic-specific payload (shape owned by Otok_WC_Payloads).
	 * @return string|WP_Error The minted event_id, or WP_Error.
	 */
	public function enqueue_event( $topic, $data ) {
		$event_id = $this->outbox->enqueue( $topic, $data );

		if ( is_wp_error( $event_id ) && 'otok_wc_enqueue_failed' === $event_id->get_error_code() ) {
			// A plugin update by file replacement never re-fires the activation
			// hook, so the insert may have hit a stale schema before the next
			// wp-admin visit runs maybe_upgrade(). Upgrade + retry once.
			Otok_WC_Outbox::maybe_upgrade();
			$event_id = $this->outbox->enqueue( $topic, $data );
		}

		if ( is_wp_error( $event_id ) ) {
			// Capture-stage loss is the one loss path the durable outbox cannot
			// see — leave a trace. Topic + error code only, never payload/PII.
			if ( function_exists( 'wc_get_logger' ) ) {
				wc_get_logger()->error(
					sprintf( 'oToK outbox enqueue failed for %s: %s', $topic, $event_id->get_error_code() ),
					array( 'source' => 'otok-for-woocommerce' )
				);
			}
			return $event_id;
		}

		$this->schedule_dispatch();

		return $event_id;
	}

	/**
	 * Schedule a dispatch run: async (now) or a dated single action.
	 *
	 * @param int $timestamp Unix time for a dated run; 0 = as soon as possible.
	 * @return void
	 */
	public function schedule_dispatch( $timestamp = 0 ) {
		if ( ! function_exists( 'as_enqueue_async_action' ) ) {
			return;
		}

		if ( $timestamp > time() ) {
			as_schedule_single_action( $timestamp, self::HOOK_DISPATCH, array(), self::AS_GROUP );
			return;
		}

		as_enqueue_async_action( self::HOOK_DISPATCH, array(), self::AS_GROUP );
	}

	/**
	 * Assert the daily retention-purge action exists. Runs on `init`, gated
	 * to admin/cron contexts so front-end page views never pay the lookup.
	 *
	 * @return void
	 */
	public function ensure_purge_scheduled() {
		if ( ! is_admin() && ! wp_doing_cron() ) {
			return;
		}
		if ( ! function_exists( 'as_has_scheduled_action' ) || ! function_exists( 'as_schedule_recurring_action' ) ) {
			return;
		}

		if ( ! as_has_scheduled_action( self::HOOK_PURGE, array(), self::AS_GROUP ) ) {
			// $unique guards the check-then-schedule race: two concurrent
			// requests could both see no scheduled action and a duplicate
			// recurring action would re-schedule itself forever.
			as_schedule_recurring_action( time() + DAY_IN_SECONDS, DAY_IN_SECONDS, self::HOOK_PURGE, array(), self::AS_GROUP, true );
		}
	}

	/**
	 * Action Scheduler callback: drain due outbox rows within the batch budget.
	 *
	 * @return void
	 */
	public function run_queue() {
		if ( null === $this->credentials->get_connection() ) {
			return;
		}

		// Site guard: a cloned/moved site must never post into the production
		// connection. Suspend silently here — the admin notice carries the
		// reconnect / accept-new-URL choices. Deliberately no re-schedule:
		// resuming (accepting the URL or reconnecting) kicks a fresh run.
		if ( ! $this->credentials->site_url_matches() ) {
			return;
		}

		$state = $this->get_state();

		if ( $state['revoked'] ) {
			return;
		}

		if ( $state['paused_until'] > time() ) {
			$this->schedule_dispatch( (int) $state['paused_until'] );
			return;
		}

		$this->outbox->reclaim_stuck( self::CLAIM_TIMEOUT );

		$deadline  = time() + self::TIME_BUDGET;
		$processed = 0;

		while ( $processed < self::BATCH_LIMIT && time() < $deadline ) {
			$row = $this->outbox->claim_next();
			if ( null === $row ) {
				break;
			}

			if ( false === $this->send_row( $row ) ) {
				// Local misconfiguration: every row would hit the same wall,
				// so stop the run — the rescheduled row's next_attempt_at
				// produces the dated follow-up below.
				break;
			}
			++$processed;

			// A mid-batch revocation or entitlement pause stops the run —
			// hammering a dead/paused connection helps nobody.
			$state = $this->get_state();
			if ( $state['revoked'] || $state['paused_until'] > time() ) {
				break;
			}
		}

		// Follow-up scheduling (see the class docblock's dispatch model).
		if ( $state['revoked'] ) {
			return;
		}
		if ( $state['paused_until'] > time() ) {
			$this->schedule_dispatch( (int) $state['paused_until'] );
			return;
		}
		if ( $this->outbox->has_due() ) {
			$this->schedule_dispatch();
			return;
		}
		$next = $this->outbox->next_due_at();
		if ( $next > time() ) {
			$this->schedule_dispatch( $next );
		}
	}

	/**
	 * Action Scheduler callback: daily retention purge.
	 *
	 * @return void
	 */
	public function run_purge() {
		$this->outbox->purge_retention();
	}

	/**
	 * Deliver one claimed row and apply the retry/revocation policy.
	 *
	 * @param array $row Outbox row (claimed, status `sending`).
	 * @return bool False when the whole run should stop (local
	 *              misconfiguration — every row would hit the same wall).
	 */
	public function send_row( $row ) {
		$id       = (int) $row['id'];
		$attempts = (int) $row['attempts'];
		$body     = (string) $row['payload'];

		$url    = $this->endpoint_url();
		$secret = $this->credentials->get_signing_secret();

		if ( is_wp_error( $url ) || null === $secret ) {
			// Local misconfiguration (non-HTTPS record from an older version,
			// or the wp-config salts changed so the secret no longer
			// decrypts). Not the server's fault and fully recoverable by
			// reconnecting, so — like the entitlement pause — it must NOT
			// consume the retry budget: attempts stay unchanged, the row
			// re-checks hourly, and health() reports `misconfigured`.
			$reason = is_wp_error( $url ) ? $url->get_error_message() : 'Signing secret cannot be decrypted (wp-config salts changed since connect?). Reconnect the store.';
			$this->outbox->mark_retry( $id, $attempts, time() + HOUR_IN_SECONDS, $reason );
			return false;
		}

		$state    = $this->get_state();
		$t        = time() + (int) $state['clock_offset'];
		$response = $this->post_event( $url, $secret, $t, $body );

		// Single clock-skew retry on 401: re-sync t from the server's Date
		// header and retry ONCE before the occurrence can count toward
		// revocation. Only when the offset meaningfully changed — a genuine
		// bad-secret 401 must not double-POST forever.
		if ( ! is_wp_error( $response ) && 401 === (int) wp_remote_retrieve_response_code( $response ) ) {
			$new_offset = self::offset_from_response_date( wp_remote_retrieve_header( $response, 'date' ) );
			if ( null !== $new_offset && abs( $new_offset - (int) $state['clock_offset'] ) >= self::SKEW_MIN_DELTA ) {
				$this->update_state( array( 'clock_offset' => $new_offset ) );
				$response = $this->post_event( $url, $secret, time() + $new_offset, $body );
			}
		}

		$this->apply_outcome( $id, $attempts, $response );

		return true;
	}

	/**
	 * Best-effort `otok/disconnected`: one immediate signed POST, no outbox
	 * row, no retry, failures ignored. Called BEFORE local credentials are
	 * wiped (manual disconnect) and on plugin deactivation.
	 *
	 * @param string $reason 'deactivated' or 'disconnected'.
	 * @return void
	 */
	public function send_disconnected( $reason ) {
		$url    = $this->endpoint_url();
		$secret = $this->credentials->get_signing_secret();

		if ( is_wp_error( $url ) || null === $secret ) {
			return;
		}

		$body = wp_json_encode(
			Otok_WC_Payloads::envelope(
				wp_generate_uuid4(),
				Otok_WC_Payloads::TOPIC_DISCONNECTED,
				Otok_WC_Payloads::now_iso8601(),
				Otok_WC_Payloads::disconnected( $reason )
			)
		);

		if ( false === $body ) {
			return;
		}

		$state = $this->get_state();
		$this->post_event( $url, $secret, time() + (int) $state['clock_offset'], $body, 5 );
	}

	/**
	 * Health snapshot for the settings panel and diagnostics.
	 *
	 * State precedence: not_connected > revoked > site_mismatch >
	 * misconfigured > entitlement_paused > connected.
	 *
	 * @return array{state:string,auth_failures:int,clock_offset:int,paused_until:int,last_success_at:string,revoked_at:string}
	 */
	public function health() {
		$state = $this->get_state();

		if ( null === $this->credentials->get_connection() ) {
			$status = 'not_connected';
		} elseif ( $state['revoked'] ) {
			$status = 'revoked';
		} elseif ( ! $this->credentials->site_url_matches() ) {
			$status = 'site_mismatch';
		} elseif ( null === $this->credentials->get_signing_secret() || is_wp_error( $this->endpoint_url() ) ) {
			// Local misconfiguration: the stored secret no longer decrypts
			// (wp-config salts rotated) or the stored base URL is unusable.
			// Delivery reschedules hourly without consuming attempts.
			$status = 'misconfigured';
		} elseif ( $state['paused_until'] > time() ) {
			$status = 'entitlement_paused';
		} else {
			$status = 'connected';
		}

		return array(
			'state'           => $status,
			'auth_failures'   => (int) $state['auth_failures'],
			'clock_offset'    => (int) $state['clock_offset'],
			'paused_until'    => (int) $state['paused_until'],
			'last_success_at' => (string) $state['last_success_at'],
			'revoked_at'      => (string) $state['revoked_at'],
		);
	}

	/**
	 * Forget all per-connection delivery state (counters, offset, revoked
	 * flag, pause). Called on connect and disconnect.
	 *
	 * @return void
	 */
	public static function reset_connection_state() {
		delete_option( self::OPTION_STATE );
	}

	/**
	 * Backoff delay (seconds) before the next attempt, given the attempt
	 * number that just failed (1-based): ~1m, 5m, 15m, 1h, 4h, then every 6h.
	 *
	 * @param int $attempt Attempt number that just failed.
	 * @return int
	 */
	public static function backoff_delay( $attempt ) {
		$ladder = array(
			1 => MINUTE_IN_SECONDS,
			2 => 5 * MINUTE_IN_SECONDS,
			3 => 15 * MINUTE_IN_SECONDS,
			4 => HOUR_IN_SECONDS,
			5 => 4 * HOUR_IN_SECONDS,
		);

		$attempt = max( 1, (int) $attempt );

		return isset( $ladder[ $attempt ] ) ? $ladder[ $attempt ] : 6 * HOUR_IN_SECONDS;
	}

	/**
	 * Build the X-Otok-Signature header value: t=<unix>,v1=<hex
	 * hmac-sha256(secret, "{t}.{body}")>. The body MUST be the exact bytes
	 * sent on the wire.
	 *
	 * @param string $secret Signing secret.
	 * @param int    $t      Unix timestamp (already clock-offset-shifted).
	 * @param string $body   Exact request body bytes.
	 * @return string
	 */
	public static function build_signature( $secret, $t, $body ) {
		return 't=' . (int) $t . ',v1=' . hash_hmac( 'sha256', (int) $t . '.' . $body, (string) $secret );
	}

	/**
	 * Parse a Retry-After header value (delta-seconds or HTTP-date) into
	 * seconds from now. 0 when absent/unparseable.
	 *
	 * @param string|array $value Raw header value (wp_remote_retrieve_header()
	 *                            returns an array for duplicated headers).
	 * @return int
	 */
	public static function parse_retry_after( $value ) {
		if ( is_array( $value ) ) {
			$value = reset( $value );
		}

		$value = trim( (string) $value );

		if ( '' === $value ) {
			return 0;
		}

		if ( preg_match( '/^\d+$/', $value ) ) {
			return (int) $value;
		}

		$ts = strtotime( $value );

		return ( false !== $ts && $ts > time() ) ? ( $ts - time() ) : 0;
	}

	/**
	 * Whether a response is the entitlement-pause signal: HTTP 429 with a
	 * JSON body carrying {"code":"entitlement_paused"}. Plain rate-limit
	 * 429s carry no such code.
	 *
	 * @param int    $status HTTP status.
	 * @param string $body   Response body.
	 * @return bool
	 */
	public static function is_entitlement_paused_response( $status, $body ) {
		if ( 429 !== (int) $status ) {
			return false;
		}

		$decoded = json_decode( (string) $body, true );

		return is_array( $decoded ) && isset( $decoded['code'] ) && 'entitlement_paused' === $decoded['code'];
	}

	/**
	 * Compute the local→server clock offset from a response Date header.
	 *
	 * @param string|array $date Raw Date header value.
	 * @return int|null Offset in seconds (server − local), or null when unparseable.
	 */
	public static function offset_from_response_date( $date ) {
		if ( is_array( $date ) ) {
			$date = reset( $date );
		}

		$server_ts = strtotime( (string) $date );

		return false === $server_ts ? null : ( $server_ts - time() );
	}

	/**
	 * Classify a delivery response and apply the policy to the row + state.
	 *
	 * @param int            $id       Row id.
	 * @param int            $attempts Attempts count BEFORE this delivery attempt.
	 * @param array|WP_Error $response wp_remote_post() return value.
	 * @return void
	 */
	private function apply_outcome( $id, $attempts, $response ) {
		if ( is_wp_error( $response ) ) {
			// Network-level failure: retryable; resets the auth counter (it
			// counts CONSECUTIVE 401/404 responses only).
			$this->update_state( array( 'auth_failures' => 0 ) );
			$this->apply_retryable( $id, $attempts, 0, 'Network error: ' . $response->get_error_message() );
			return;
		}

		$status = (int) wp_remote_retrieve_response_code( $response );
		$body   = (string) wp_remote_retrieve_body( $response );

		if ( $status >= 200 && $status < 300 ) {
			$this->update_state(
				array(
					'auth_failures'   => 0,
					'last_success_at' => gmdate( 'c' ),
				)
			);
			$this->outbox->mark_sent( $id );
			return;
		}

		if ( 401 === $status || 404 === $status ) {
			$this->count_auth_failure( $id, $attempts, $status );
			return;
		}

		if ( self::is_entitlement_paused_response( $status, $body ) ) {
			// Workspace plan lapsed: pause the WHOLE queue per Retry-After
			// (default 1h). Nothing dropped, nothing revoked, attempts NOT
			// consumed — the row simply becomes due again when the pause ends.
			$retry_after = self::parse_retry_after( wp_remote_retrieve_header( $response, 'retry-after' ) );
			$pause       = min( $retry_after > 0 ? $retry_after : self::ENTITLEMENT_PAUSE_DEFAULT, self::ENTITLEMENT_PAUSE_CAP );

			$this->update_state(
				array(
					'auth_failures' => 0,
					'paused_until'  => time() + $pause,
				)
			);
			$this->outbox->mark_retry( $id, $attempts, time() + $pause, 'Paused — oToK plan lapsed (retrying automatically).' );
			return;
		}

		$this->update_state( array( 'auth_failures' => 0 ) );

		if ( 429 === $status ) {
			$retry_after = min( self::parse_retry_after( wp_remote_retrieve_header( $response, 'retry-after' ) ), self::RETRY_AFTER_CAP );
			$this->apply_retryable( $id, $attempts, $retry_after, 'HTTP 429 (rate limited)' );
			return;
		}

		if ( 408 === $status || 425 === $status || $status >= 500 ) {
			$this->apply_retryable( $id, $attempts, 0, 'HTTP ' . $status );
			return;
		}

		if ( $status >= 400 && $status < 500 ) {
			// Any other 4xx: permanent failure, no retry (the frozen
			// contract's only permanent-fail class).
			$this->outbox->mark_failed( $id, $attempts + 1, 'HTTP ' . $status . ( '' !== $body ? ' — ' . $body : '' ) );
			return;
		}

		// Anything else (1xx, 3xx — redirects are returned as-is because
		// redirection is 0 — or HTTP 0 from a malformed response) is
		// unclassified, not provably permanent: ride the backoff ladder,
		// bounded by the MAX_ATTEMPTS give-up, instead of dropping the event
		// on a transient LB/CDN redirect window.
		$this->apply_retryable( $id, $attempts, 0, 'HTTP ' . $status . ' (unexpected status)' );
	}

	/**
	 * Count a consecutive 401/404 toward revocation and reschedule the row.
	 * At AUTH_FAILURE_LIMIT the connection is treated as revoked: the whole
	 * queue pauses (rows stay pending, nothing is dropped) and the admin
	 * sees reconnect UX.
	 *
	 * @param int $id       Row id.
	 * @param int $attempts Attempts count before this delivery attempt.
	 * @param int $status   401 or 404.
	 * @return void
	 */
	private function count_auth_failure( $id, $attempts, $status ) {
		// The increment runs INSIDE the state mutation (under the advisory
		// lock, against a fresh read) — a read-outside/write-inside split
		// would re-open the lost-update window mutate_state() closes.
		$state = $this->mutate_state(
			function ( $current ) {
				$failures = (int) $current['auth_failures'] + 1;

				$patch = array( 'auth_failures' => $failures );

				if ( $failures >= self::AUTH_FAILURE_LIMIT ) {
					$patch['revoked']    = true;
					$patch['revoked_at'] = gmdate( 'c' );
				}

				return $patch;
			}
		);

		$failures = (int) $state['auth_failures'];

		$note = ( $failures >= self::AUTH_FAILURE_LIMIT )
			? 'HTTP ' . $status . ' — connection treated as revoked after ' . $failures . ' consecutive authentication failures.'
			: 'HTTP ' . $status . ' (authentication failure ' . $failures . ' of ' . self::AUTH_FAILURE_LIMIT . ')';

		// The row itself stays on the retry ladder: if the connection is NOT
		// revoked yet the next attempt runs on backoff; once revoked the
		// queue is paused anyway and the row waits for a reconnect.
		$this->apply_retryable( $id, $attempts, 0, $note );
	}

	/**
	 * Apply a retryable failure: increment attempts, compute the next
	 * attempt time (backoff ladder, or an explicit minimum delay such as
	 * Retry-After — whichever is later), and fail permanently past
	 * MAX_ATTEMPTS.
	 *
	 * @param int    $id        Row id.
	 * @param int    $attempts  Attempts count before this delivery attempt.
	 * @param int    $min_delay Minimum delay in seconds (0 = backoff only).
	 * @param string $error     Raw error note.
	 * @return void
	 */
	private function apply_retryable( $id, $attempts, $min_delay, $error ) {
		$attempts = (int) $attempts + 1;

		if ( $attempts >= self::MAX_ATTEMPTS ) {
			$this->outbox->mark_failed( $id, $attempts, $error . ' — giving up after ' . $attempts . ' attempts.' );
			return;
		}

		$delay = max( self::backoff_delay( $attempts ), (int) $min_delay );

		$this->outbox->mark_retry( $id, $attempts, time() + $delay, $error );
	}

	/**
	 * One signed POST to the ingest endpoint. TLS posture pinned: HTTPS URL
	 * (asserted by endpoint_url()), sslverify true, no redirects, response
	 * size capped.
	 *
	 * @param string $url     Absolute HTTPS endpoint URL.
	 * @param string $secret  Signing secret (treated as sensitive; never logged).
	 * @param int    $t       Signature timestamp (already offset-shifted).
	 * @param string $body    Exact frozen payload bytes.
	 * @param int    $timeout Request timeout in seconds.
	 * @return array|WP_Error wp_remote_post() return value.
	 */
	private function post_event( $url, $secret, $t, $body, $timeout = 15 ) {
		return wp_remote_post(
			$url,
			array(
				'timeout'             => $timeout,
				'redirection'         => 0,
				'sslverify'           => true,
				'limit_response_size' => 64 * KB_IN_BYTES,
				'headers'             => array(
					'Content-Type'     => 'application/json',
					'Accept'           => 'application/json',
					'X-Otok-Signature' => self::build_signature( $secret, $t, $body ),
				),
				'body'                => $body,
				'user-agent'          => 'oToK-for-WooCommerce/' . OTOK_WC_VERSION . ' (' . esc_url_raw( site_url() ) . ')',
			)
		);
	}

	/**
	 * The ingest endpoint URL for the stored connection, HTTPS re-asserted
	 * at send time (defense in depth for records written by older versions).
	 *
	 * @return string|WP_Error
	 */
	private function endpoint_url() {
		$connection = $this->credentials->get_connection();

		if ( null === $connection || empty( $connection['base_url'] ) ) {
			return new WP_Error( 'otok_wc_not_connected', 'Not connected.' );
		}

		$base = untrailingslashit( esc_url_raw( (string) $connection['base_url'] ) );

		if ( '' === $base || 'https' !== wp_parse_url( $base, PHP_URL_SCHEME ) ) {
			return new WP_Error( 'otok_wc_insecure_url', 'Stored oToK base URL is not HTTPS. Reconnect the store.' );
		}

		return $base . self::ENDPOINT_PATH . rawurlencode( (string) $connection['connection_id'] );
	}

	/**
	 * Persisted delivery state, merged over defaults.
	 *
	 * @return array{auth_failures:int,clock_offset:int,revoked:bool,revoked_at:string,paused_until:int,last_success_at:string}
	 */
	private function get_state() {
		$defaults = array(
			'auth_failures'   => 0,
			'clock_offset'    => 0,
			'revoked'         => false,
			'revoked_at'      => '',
			'paused_until'    => 0,
			'last_success_at' => '',
		);

		$stored = get_option( self::OPTION_STATE );

		return is_array( $stored ) ? array_merge( $defaults, $stored ) : $defaults;
	}

	/**
	 * Patch the persisted delivery state.
	 *
	 * @param array $patch Key => value overrides.
	 * @return void
	 */
	private function update_state( $patch ) {
		$this->mutate_state(
			function () use ( $patch ) {
				return $patch;
			}
		);
	}

	/**
	 * Atomically mutate the persisted delivery state.
	 *
	 * The state option is shared by concurrent dispatch runs (the class
	 * docblock's dispatch model expects redundant async runs, and Action
	 * Scheduler can execute them in parallel PHP workers), so a plain
	 * read → merge → update_option() is a lost-update race: a worker merging
	 * over a stale snapshot could silently clobber another worker's just-set
	 * `revoked: true`, or corrupt `auth_failures`/`clock_offset`/
	 * `paused_until`. Two defenses:
	 *
	 * 1. A MySQL advisory lock (GET_LOCK, prefix-scoped per site) serializes
	 *    the whole read-merge-write cycle, and the read inside the lock drops
	 *    the per-request option cache so the merge bases on the latest
	 *    committed value, not a snapshot from earlier in the run.
	 * 2. Monotonic merge rule as defense in depth (lock timeout, exotic DB
	 *    backends): `revoked` may only transition true → false through the
	 *    explicit admin reconnect/disconnect path — reset_connection_state()
	 *    deletes the option — never through a state patch, so a stale
	 *    concurrent write can never silently un-revoke a dead connection.
	 *
	 * @param callable $mutate Receives the fresh state array, returns a patch
	 *                         (key => value overrides) to merge over it.
	 * @return array The state as written.
	 */
	private function mutate_state( $mutate ) {
		global $wpdb;

		$lock = $wpdb->prefix . self::OPTION_STATE;

		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- MySQL advisory lock; no WP API exists for it.
		$locked = $wpdb->get_var( $wpdb->prepare( 'SELECT GET_LOCK(%s, %d)', $lock, self::STATE_LOCK_TIMEOUT ) );

		// Fresh read: without this, get_option() would serve the value cached
		// earlier in this request, defeating the lock. The notoptions entry
		// matters too — a state option first created by a concurrent worker
		// would otherwise still read as absent here.
		wp_cache_delete( self::OPTION_STATE, 'options' );
		wp_cache_delete( 'notoptions', 'options' );

		$current = $this->get_state();
		$state   = array_merge( $current, (array) call_user_func( $mutate, $current ) );

		// Monotonic rule (defense in depth — see docblock point 2).
		if ( $current['revoked'] ) {
			$state['revoked']    = true;
			$state['revoked_at'] = $current['revoked_at'];
		}

		// Autoload off: only dispatch runs and the settings page read it.
		update_option( self::OPTION_STATE, $state, false );

		if ( '1' === (string) $locked ) {
			// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- releases the advisory lock above.
			$wpdb->query( $wpdb->prepare( 'SELECT RELEASE_LOCK(%s)', $lock ) );
		}

		return $state;
	}
}
