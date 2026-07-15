<?php
/**
 * E.164 canonicalization matrix — executable wire-contract check.
 *
 * The E.164-or-OMIT contract (oToK e-commerce contract, 2026-07-14) lives in
 * Otok_WC_Payloads::canonicalize_phone(). This script shims the minimal
 * WP/WC surface that method touches and asserts the full input→output
 * matrix, so the contract is enforced by CI/dev runs instead of asserted
 * in docblocks.
 *
 * Run: php bin/check-phone-matrix.php   (exits non-zero on any failure)
 *
 * Dev tooling — not shipped with the plugin (lives outside
 * otok-for-woocommerce/, like build-zip.sh).
 */

define( 'ABSPATH', '/tmp/' );

// --- Minimal WP/WC shims ----------------------------------------------------

$GLOBALS['otok_check_filter'] = null;

function apply_filters( $tag, $value, ...$args ) {
	if ( 'otok_wc_canonicalize_phone' === $tag && is_callable( $GLOBALS['otok_check_filter'] ) ) {
		return call_user_func( $GLOBALS['otok_check_filter'], $value, ...$args );
	}
	return $value;
}

function site_url() {
	return 'https://example.test';
}

class Otok_Check_WC_Countries {
	/**
	 * Real values from woocommerce/i18n/phone.php. 'FR' deliberately
	 * simulates the docblocked string|array shape (the canonicalizer must
	 * take the first element).
	 */
	private $codes = array(
		'IL' => '+972',
		'GB' => '+44',
		'DE' => '+49',
		'FR' => array( '+33', '+33x' ),
		'IT' => '+39',
		'HU' => '+36',
		'ES' => '+34',
		'DK' => '+45',
		'NO' => '+47',
		'PL' => '+48',
		'GR' => '+30',
		'CZ' => '+420',
		'US' => '+1',
		'CA' => '+1',
	);

	public function get_country_calling_code( $cc ) {
		return isset( $this->codes[ $cc ] ) ? $this->codes[ $cc ] : '';
	}
}

class Otok_Check_WC {
	public $countries;
	public function __construct() {
		$this->countries = new Otok_Check_WC_Countries();
	}
}

function WC() {
	static $wc = null;
	if ( null === $wc ) {
		$wc = new Otok_Check_WC();
	}
	return $wc;
}

require __DIR__ . '/../otok-for-woocommerce/includes/class-otok-wc-payloads.php';

// --- Matrix -----------------------------------------------------------------

$fails = 0;
$count = 0;

function check( $label, $expected, $raw, $country = '' ) {
	global $fails, $count;
	$count++;
	$actual = Otok_WC_Payloads::canonicalize_phone( $raw, $country );
	$ok     = ( $expected === $actual );
	if ( ! $ok ) {
		$fails++;
		printf( "FAIL  %-58s expected=%-18s actual=%s\n", $label, var_export( $expected, true ), var_export( $actual, true ) );
	}
}

// Spec matrix (oToK e-commerce contract 2026-07-14, verbatim).
check( 'IL national with trunk 0', '+972501234567', '050-1234567', 'IL' );
check( 'already E.164, no country', '+14155552671', '+14155552671' );
check( '00 exit prefix, no country', '+442079460958', '0044 20 7946 0958' );
check( 'US 10-digit NANP', '+14155552671', '4155552671', 'US' );
check( 'US 9 digits -> omit', '', '415555267', 'US' );
check( 'IT geographic keeps 0', '+390212345678', '0212345678', 'IT' );
check( 'IT mobile (no 0)', '+393123456789', '3123456789', 'IT' );

// Italy 39x collision (2026-07-14): 390-393 are REAL mobile prefixes
// that also spell Italy's own calling code — a plausible-length national must
// NEVER be treated as double-prefixed; only longer strings read as the
// country code typed without "+".
check( 'IT 39x mobile kept (391 is a real range)', '+393912345678', '3912345678', 'IT' );
check( 'IT 39x 9-digit mobile kept', '+39391234567', '391234567', 'IT' );
check( 'IT cc typed without + accepted', '+393123456789', '393123456789', 'IT' );
check( 'IT cc + geographic typed without + accepted', '+390212345678', '390212345678', 'IT' );
check( 'uncurated country -> omit', '', '13812345678', 'CN' );
check( 'national without country -> omit', '', '0501234567' );
check( 'garbage -> omit', '', 'abc', 'IL' );
check( 'zero after + -> omit', '', '+0501234567', 'IL' );
check( '00 + full international', '+972501234567', '00972501234567' );
check( 'empty -> omit', '', '', 'IL' );
check( 'null -> omit', '', null, 'IL' );

// International "(0)" trunk notation (2026-07-14): the trunk zero
// must never survive into the digits.
check( '+44 (0) trunk zero stripped', '+442079460958', '+44 (0) 20 7946 0958' );
check( '0044 (0) trunk zero stripped', '+442079460958', '0044 (0)20 7946 0958' );
check( '+49 (0) mobile stripped', '+4915112345678', '+49 (0)151 12345678' );
check( '+972 (0) stripped', '+972501234567', '+972 (0)50-123-4567' );
check( 'IT +39 (0) ambiguous -> omit', '', '+39 (0)2 12345678', 'IT' );
check( 'Vatican +379 (0) not the IT carve-out', '+379669812345', '+379 (0)66 9812345' );
check( 'national (0XX) grouping unaffected', '+442079460958', '(020) 7946 0958', 'GB' );

// Hungary: trunk prefix is "06", never a single "0".
check( 'HU 06 mobile', '+36201234567', '06 20 123 4567', 'HU' );
check( 'HU 06 geographic (Eger 36)', '+3636123456', '06 36 123 456', 'HU' );
check( 'HU without trunk prefix', '+36201234567', '20 123 4567', 'HU' );
check( 'HU lone leading 0 -> omit', '', '01 234 5678', 'HU' );

// Country code typed without "+": reads as international -> omit, never
// double-prefix.
check( 'GB own cc typed, no + -> omit', '', '44 20 7946 0958', 'GB' );
check( 'IL own cc typed, no + -> omit', '', '972 50 123 4567', 'IL' );
check( 'FR own cc typed, no + -> omit', '', '33 6 12 34 56 78', 'FR' );
check( 'DK own cc typed, no + -> omit', '', '4512345678', 'DK' );
check( 'FR NSN merely starting with cc digits kept', '+33333123456', '0333123456', 'FR' );

// NANP structure: area code + exchange each 2-9; 11-digit 1-form accepted.
check( 'US 1 + 10 digits accepted', '+12125550123', '1 212 555 0123', 'US' );
check( 'CA formatted NANP', '+14165552671', '(416) 555-2671', 'CA' );
check( 'US leading-0 area code -> omit', '', '0234567890', 'US' );
check( 'US exchange starting 1 -> omit', '', '212 155 0123', 'US' );
check( 'US 11 digits not starting 1 -> omit', '', '22125550123', 'US' );

// No-trunk-prefix countries: prepend as-is; leading 0 is malformed -> omit.
check( 'DK 8 digits', '+4512345678', '12 34 56 78', 'DK' );
check( 'DK leading 0 -> omit', '', '04512345678', 'DK' );
check( 'ES mobile', '+34612345678', '612 345 678', 'ES' );
check( 'ES leading 0 -> omit', '', '0612345678', 'ES' );
check( 'NO 8 digits', '+4791234567', '91234567', 'NO' );
check( 'PL 9 digits', '+48512345678', '512345678', 'PL' );
check( 'GR mobile', '+306912345678', '6912345678', 'GR' );
check( 'CZ 9 digits', '+420601123456', '601123456', 'CZ' );

// Trunk-zero-drop regressions.
check( 'GB trunk 0 dropped', '+442079460958', '020 7946 0958', 'GB' );
check( 'DE dots stripped, trunk 0 dropped', '+4930901820', '030.901820', 'DE' );
check( 'lowercase country accepted', '+972501234567', '0501234567', 'il' );
check( 'trunk-drop without leading 0 still prefixes', '+972501234567', '501234567', 'IL' );
check( 'array calling code takes first', '+33612345678', '06 12 34 56 78', 'FR' );

// Shape bounds.
check( '+ too short -> omit', '', '+123456' );
check( '+ too long -> omit', '', '+1234567890123456' );
check( 'letters inside -> omit', '', '050-CALL-ME', 'IL' );
check( 'whitespace only -> omit', '', '   ', 'IL' );

// Filter seam: rescue is possible, garbage is re-validated into omission.
$GLOBALS['otok_check_filter'] = function ( $canonical, $raw, $country ) {
	return ( 'CN' === $country && '' === $canonical ) ? '+8613812345678' : $canonical;
};
check( 'filter rescues uncurated country', '+8613812345678', '13812345678', 'CN' );

$GLOBALS['otok_check_filter'] = function () {
	return 'not-a-phone';
};
check( 'filter garbage still omits', '', '+14155552671', 'US' );
$GLOBALS['otok_check_filter'] = null;

printf( "%d checks, %d failures\n", $count, $fails );
exit( $fails > 0 ? 1 : 0 );
