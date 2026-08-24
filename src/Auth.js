/**
 * Passcode gate.
 *
 * The web app is deployed with anonymous access so that family members need no
 * Google account, which means the URL alone is the only thing standing between
 * the data and anyone who has it. A shared passcode adds a second factor that
 * costs nothing to hand out.
 *
 * This is deliberately lightweight: the passcode is stored in script properties
 * and kept in the browser's localStorage, so it protects against someone who
 * stumbles on the URL, not against someone with access to a family member's
 * unlocked phone.
 */

var PASSCODE_KEY = 'PASSCODE';

/** Prefix on the thrown message that tells the UI to show the passcode screen. */
var AUTH_ERROR_PREFIX = 'AUTH_REQUIRED';

/**
 * Returns the configured passcode, or '' when the gate is switched off.
 * @returns {string}
 */
function getStoredPasscode_() {
  return PropertiesService.getScriptProperties().getProperty(PASSCODE_KEY) || '';
}

/**
 * Rejects the call unless the passcode matches.
 *
 * With no passcode configured the app is open, which is what a freshly set up
 * instance looks like until someone sets one.
 *
 * @param {string} [passcode]
 * @returns {void}
 */
function requirePasscode_(passcode) {
  var expected = getStoredPasscode_();
  if (!expected) return;
  if (String(passcode || '') !== expected) {
    throw new Error(AUTH_ERROR_PREFIX + ': 合言葉が正しくありません。');
  }
}

/**
 * Reports whether a passcode is needed, without revealing it.
 *
 * Called before anything else, so it must not require one itself.
 *
 * @returns {{required: boolean}}
 */
function apiAuthStatus() {
  return { required: !!getStoredPasscode_() };
}

/**
 * Checks a passcode the user just typed.
 * @param {string} candidate
 * @returns {{ok: boolean, required: boolean}}
 */
function apiVerifyPasscode(candidate) {
  var expected = getStoredPasscode_();
  return { ok: !expected || String(candidate || '') === expected, required: !!expected };
}

/**
 * Sets, changes or clears the passcode.
 *
 * Changing it signs every other device out, since they hold the old value.
 *
 * @param {string} newPasscode An empty string switches the gate off.
 * @param {string} [passcode] The current passcode, required once one is set.
 * @returns {{required: boolean}}
 */
function apiSetPasscode(newPasscode, passcode) {
  requirePasscode_(passcode);

  var value = String(newPasscode == null ? '' : newPasscode).trim();
  if (value && value.length < 4) {
    throw new Error('合言葉は4文字以上にしてください。');
  }
  if (value.length > 60) {
    throw new Error('合言葉は60文字以内にしてください。');
  }

  var properties = PropertiesService.getScriptProperties();
  if (value) properties.setProperty(PASSCODE_KEY, value);
  else properties.deleteProperty(PASSCODE_KEY);

  return { required: !!value };
}
