/**
 * oToK for WooCommerce — classic-checkout guest email capture.
 *
 * Posts the billing email (on blur) and the marketing-consent checkbox state
 * (on change) to the hardened admin-ajax endpoint, so abandoned-cart events
 * can carry the shopper's identity before an order exists. The blocks
 * checkout is captured server-side — on a blocks page these selectors simply
 * never match. Fire-and-forget: failures are silent, checkout is never
 * affected. No dependencies.
 */
( function () {
	'use strict';

	var cfg = window.otokWcCheckout;

	if ( ! cfg || ! window.fetch || ! window.URLSearchParams ) {
		return;
	}

	var lastSentEmail = '';

	function looksLikeEmail( value ) {
		return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test( value );
	}

	function consentChecked() {
		var box = document.getElementById( 'otok_wc_marketing_consent' );
		return box ? box.checked : null;
	}

	function send( email, consent ) {
		var body = new window.URLSearchParams();
		body.append( 'action', cfg.action );
		body.append( 'nonce', cfg.nonce );
		if ( email ) {
			body.append( 'email', email );
		}
		if ( null !== consent ) {
			body.append( 'consent', consent ? '1' : '0' );
		}
		if ( ! email && null === consent ) {
			return;
		}
		window
			.fetch( cfg.ajaxUrl, { method: 'POST', credentials: 'same-origin', body: body } )
			.catch( function () {} );
	}

	function currentEmail() {
		var field = document.getElementById( 'billing_email' );
		var value = field ? ( field.value || '' ).trim() : '';
		return looksLikeEmail( value ) ? value : '';
	}

	document.addEventListener( 'focusout', function ( event ) {
		var target = event.target;
		if ( ! target || 'billing_email' !== target.id ) {
			return;
		}
		var email = ( target.value || '' ).trim();
		if ( email && email !== lastSentEmail && looksLikeEmail( email ) ) {
			lastSentEmail = email;
			send( email, consentChecked() );
		}
	} );

	document.addEventListener( 'change', function ( event ) {
		var target = event.target;
		if ( ! target || 'otok_wc_marketing_consent' !== target.id ) {
			return;
		}
		send( currentEmail(), target.checked );
	} );
}() );
