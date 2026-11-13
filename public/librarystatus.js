/* WebSolid — server parts-library availability states.
 *
 * The parts library is optional server storage. The editor must say which of
 * three states it is in — checking, ready, or unavailable — instead of leaving
 * a first-time visitor on an indefinite "Checking…?" line, and every failure
 * state must offer a retry plus a concrete portable fallback (Save file).
 *
 * Pure functions only, so the copy can be unit-tested in Node without a DOM.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WebSolidLibraryStatus = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* How long a pending /api/parts request may stay quiet before the panel says
     it is taking longer than usual, and when the request is abandoned. */
  var SLOW_AFTER_MS = 4000;
  var GIVE_UP_AFTER_MS = 12000;

  var UNAVAILABLE_CORE =
    'Server parts library unavailable — Save part and Save as are disabled. ' +
    'Browser-local recovery depends on storage being allowed. Save file downloads an editable .websolid.json copy to this device, not to the server. Reopen it with Open file.';

  function pluralParts(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return null;
    return n === 0 ? 'no parts saved yet' : (n === 1 ? '1 part saved' : n + ' parts saved');
  }

  /* statusFor(state, opts) -> plain description of the panel state.
     state: 'checking' | 'ready' | 'unavailable'
     opts:  { count, reason, slow, attempts } */
  function statusFor(state, opts) {
    opts = opts || {};
    if (state === 'ready') {
      var saved = pluralParts(opts.count);
      return {
        state: 'ready',
        hintHidden: false,
        hintClass: 'hint hint-ok',
        retryHidden: true,
        fallbackSaveHidden: true,
        fallbackSaveLabel: 'Save portable .json file instead',
        saveButtonsDisabled: false,
        hintText: 'Server parts library ready' + (saved ? ' \u00b7 ' + saved : '') +
          '. Save part stores the part in the server library, not in this browser or an account.'
      };
    }
    if (state === 'checking') {
      var attempts = typeof opts.attempts === 'number' && opts.attempts > 1
        ? ' (attempt ' + opts.attempts + ')'
        : '';
      return {
        state: 'checking',
        hintHidden: false,
        hintClass: 'hint',
        retryHidden: !opts.slow,
        fallbackSaveHidden: !opts.slow,
        fallbackSaveLabel: 'Save portable .json file instead',
        saveButtonsDisabled: true,
        hintText: (opts.slow
          ? 'Still checking the server parts library\u2026 it is taking longer than usual. '
          : 'Checking server parts library availability\u2026 ') +
          'The modeler works without it: Save file downloads an editable .websolid.json part to this device, not to the server. Reopen it with Open file. ' +
          'A retry appears if the check takes longer than usual.' + attempts
      };
    }
    var reason = opts.reason === 'timeout'
      ? 'The check timed out. '
      : (opts.reason === 'server' ? 'The server answered but not with a parts list. ' : '');
    return {
      state: 'unavailable',
      hintHidden: false,
      hintClass: 'hint hint-warn',
      retryHidden: false,
      fallbackSaveHidden: false,
      fallbackSaveLabel: 'Save portable .json file instead',
      saveButtonsDisabled: true,
      hintText: reason + UNAVAILABLE_CORE
    };
  }

  /* Copy shown while a request is pending past SLOW_AFTER_MS. */
  function slowNotice() {
    return statusFor('checking', { slow: true }).hintText;
  }

  /* Retry button label; keeps the disabled/offline reason visible. */
  function retryLabel(state) {
    return state === 'checking' ? 'Retry check' : 'Try again';
  }

  return {
    SLOW_AFTER_MS: SLOW_AFTER_MS,
    GIVE_UP_AFTER_MS: GIVE_UP_AFTER_MS,
    UNAVAILABLE_CORE: UNAVAILABLE_CORE,
    statusFor: statusFor,
    slowNotice: slowNotice,
    retryLabel: retryLabel
  };
});
