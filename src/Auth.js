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
 *
 * The gate is never off in a deployed instance: setup() mints a random passcode
 * when none exists, so there is no window in which the URL alone grants write
 * access. requirePasscode_ still passes when nothing is configured, because the
 * local development server runs the same code against a throwaway JSON file and
 * has no setup() step. That state is unreachable in production -- without
 * setup() there is no spreadsheet to read or write either.
 */

var PASSCODE_KEY = 'PASSCODE';

/** Length of a generated passcode. Hex, so 12 characters is ~48 bits. */
var GENERATED_PASSCODE_LENGTH = 12;

/** Shortest passcode a human may choose. */
var MIN_PASSCODE_LENGTH = 6;

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
 * Compares two strings without returning early on the first mismatch.
 *
 * The gate has no rate limit, so a comparison whose duration tracks the length
 * of the matching prefix would let an attacker recover the passcode character
 * by character. Length is still observable; content is not.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function constantTimeEquals_(a, b) {
  var diff = a.length ^ b.length;
  for (var i = 0; i < a.length && i < b.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Mints a passcode for a fresh instance.
 *
 * getUuid() is a v4 UUID, which is a far better entropy source than
 * Math.random(); the dashes are dropped so the result reads as one word.
 *
 * @returns {string}
 */
function generatePasscode_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, GENERATED_PASSCODE_LENGTH);
}

/**
 * Rejects the call unless the passcode matches.
 *
 * Passing when nothing is configured is what lets the local development server
 * run without a gate; see the note at the top of this file for why a deployed
 * instance never reaches that state.
 *
 * @param {string} [passcode]
 * @returns {void}
 */
function requirePasscode_(passcode) {
  var expected = getStoredPasscode_();
  if (!expected) return;
  if (!constantTimeEquals_(String(passcode || ''), expected)) {
    throw new Error(AUTH_ERROR_PREFIX + ': パスワードが正しくありません。');
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
  return { ok: !expected || constantTimeEquals_(String(candidate || ''), expected), required: !!expected };
}

/**
 * Changes the passcode.
 *
 * Changing it signs every other device out, since they hold the old value.
 *
 * Claiming the *first* passcode is restricted to a signed-in caller, i.e. the
 * owner running this from the Apps Script editor. A web app deployed for
 * anonymous access reports an empty active user, so a stranger who found the
 * URL of an ungated instance cannot set a passcode of their own and lock the
 * family out. The gate cannot be switched off from here at all: an instance
 * with no passcode accepts anonymous writes, so that has to be a deliberate act
 * at the editor, not a button in the UI.
 *
 * @param {string} newPasscode
 * @param {string} [passcode] The current passcode, required once one is set.
 * @returns {{required: boolean}}
 */
function apiSetPasscode(newPasscode, passcode) {
  var configured = getStoredPasscode_();
  requirePasscode_(passcode);
  if (!configured && !Session.getActiveUser().getEmail()) {
    throw new Error('最初のパスワードはGASエディタから設定してください。');
  }

  var value = String(newPasscode == null ? '' : newPasscode).trim();
  if (!value) {
    throw new Error('パスワードは空にできません。解除するにはスクリプトプロパティ PASSCODE を削除してください。');
  }
  if (value.length < MIN_PASSCODE_LENGTH) {
    throw new Error('パスワードは' + MIN_PASSCODE_LENGTH + '文字以上にしてください。');
  }
  if (value.length > 60) {
    throw new Error('パスワードは60文字以内にしてください。');
  }

  PropertiesService.getScriptProperties().setProperty(PASSCODE_KEY, value);
  return { required: true };
}

/**
 * Mints the initial passcode unless one already exists. Called by setup().
 * @returns {string} The new passcode, or '' when one was already configured.
 */
function ensurePasscode_() {
  if (getStoredPasscode_()) return '';
  var value = generatePasscode_();
  PropertiesService.getScriptProperties().setProperty(PASSCODE_KEY, value);
  return value;
}
