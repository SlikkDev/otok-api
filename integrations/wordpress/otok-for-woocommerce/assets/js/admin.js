/**
 * oToK for WooCommerce — admin page behavior.
 *
 * Copy-diagnostics button + disconnect confirmation. No dependencies.
 */
( function () {
	'use strict';

	function onReady( fn ) {
		if ( 'loading' !== document.readyState ) {
			fn();
		} else {
			document.addEventListener( 'DOMContentLoaded', fn );
		}
	}

	onReady( function () {
		var copyButton  = document.getElementById( 'otok-wc-copy-diagnostics' );
		var diagnostics = document.getElementById( 'otok-wc-diagnostics' );
		var copyStatus  = document.getElementById( 'otok-wc-copy-status' );

		if ( copyButton && diagnostics ) {
			copyButton.addEventListener( 'click', function () {
				var originalLabel = copyButton.textContent;

				function showResult( label ) {
					copyButton.textContent = label;
					// Mirror into the aria-live region so screen readers
					// announce the outcome (a swapped button label alone is
					// not reliably announced).
					if ( copyStatus ) {
						copyStatus.textContent = label;
					}
					window.setTimeout( function () {
						copyButton.textContent = originalLabel;
						if ( copyStatus ) {
							copyStatus.textContent = '';
						}
					}, 2500 );
				}

				function fallbackCopy() {
					var ok = false;
					diagnostics.focus();
					diagnostics.select();
					try {
						ok = document.execCommand( 'copy' );
					} catch ( err ) {
						ok = false;
					}
					showResult( copyButton.getAttribute( ok ? 'data-copied' : 'data-failed' ) );
				}

				if ( navigator.clipboard && window.isSecureContext ) {
					navigator.clipboard.writeText( diagnostics.value ).then(
						function () {
							showResult( copyButton.getAttribute( 'data-copied' ) );
						},
						fallbackCopy
					);
				} else {
					fallbackCopy();
				}
			} );
		}

		var disconnectForm = document.getElementById( 'otok-wc-disconnect-form' );

		if ( disconnectForm ) {
			disconnectForm.addEventListener( 'submit', function ( event ) {
				if ( ! window.confirm( disconnectForm.getAttribute( 'data-confirm' ) ) ) {
					event.preventDefault();
				}
			} );
		}
	} );
}() );
