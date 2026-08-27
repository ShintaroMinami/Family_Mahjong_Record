/**
 * Sheet layout definitions and value normalisation helpers.
 *
 * All dates are kept as strings ('YYYY-MM-DD' / ISO 8601) rather than Date
 * objects. Spreadsheets silently reinterpret date cells in the file's timezone,
 * and Date objects do not survive the google.script.run boundary intact, so
 * strings are the only representation that behaves the same everywhere.
 */

/**
 * Column order for every sheet. The array index is the column index.
 * @type {Record<string, string[]>}
 */
var SCHEMA = {
  Players: ['playerId', 'name', 'active', 'createdAt'],
  Rules: ['ruleId', 'name', 'playerCount', 'startPoints', 'returnPoints', 'uma',
    'tobiBonus', 'active'],
  // The rule columns after ruleId are a snapshot taken when the game was saved.
  // Editing a preset later must not silently rewrite the history of past games.
  Games: ['gameId', 'gameDate', 'playedAt', 'ruleId', 'ruleName', 'playerCount',
    'startPoints', 'returnPoints', 'uma', 'tobiBonus', 'venue',
    'paifuId', 'note', 'recordedBy', 'deleted', 'createdAt', 'updatedAt'],
  Results: ['resultId', 'gameId', 'gameDate', 'seat', 'playerId', 'rawScore', 'rank',
    'scorePt', 'umaPt', 'okaPt', 'tobiPt', 'totalPt', 'tobi', 'deleted']
};

/**
 * Columns holding numbers, so that text-formatted cells still come back as numbers.
 * @type {Record<string, boolean>}
 */
var NUMBER_COLUMNS = {
  playerCount: true, startPoints: true, returnPoints: true, tobiBonus: true,
  seat: true, rawScore: true, rank: true, scorePt: true,
  umaPt: true, okaPt: true, tobiPt: true, totalPt: true
};

/**
 * Columns holding booleans.
 * @type {Record<string, boolean>}
 */
var BOOLEAN_COLUMNS = { active: true, deleted: true, tobi: true };

/**
 * Columns holding a plain 'YYYY-MM-DD' date.
 * @type {Record<string, boolean>}
 */
var DATE_COLUMNS = { gameDate: true };

/**
 * Formats a Date as 'YYYY-MM-DD' in the given timezone.
 * @param {Date} date
 * @param {string} [timeZone] IANA timezone name. Defaults to Asia/Tokyo.
 * @returns {string}
 */
function formatDateKey(date, timeZone) {
  var tz = timeZone || 'Asia/Tokyo';
  // en-CA gives exactly 'YYYY-MM-DD', which avoids hand-rolling zero padding.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

/**
 * Coerces a cell value into a 'YYYY-MM-DD' string.
 *
 * Spreadsheets turn a written '2026-08-24' into a Date, so reads have to accept
 * both shapes.
 *
 * @param {unknown} value
 * @returns {string} Empty string when the value is blank or unparseable.
 */
function normalizeDateKey(value) {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) return formatDateKey(value);
  var text = String(value).trim();
  var match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!match) return '';
  return match[1] + '-' + ('0' + match[2]).slice(-2) + '-' + ('0' + match[3]).slice(-2);
}

/**
 * Coerces a cell value to a boolean, accepting the several shapes a sheet may return.
 * @param {unknown} value
 * @returns {boolean}
 */
function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  var text = String(value).trim().toLowerCase();
  return text === 'true' || text === 'yes' || text === '1';
}

/**
 * Coerces a cell value to a number.
 * @param {unknown} value
 * @returns {number} 0 when blank or unparseable.
 */
function normalizeNumber(value) {
  if (typeof value === 'number') return value;
  if (value === null || value === undefined || value === '') return 0;
  var parsed = Number(String(value).replace(/,/g, ''));
  return isNaN(parsed) ? 0 : parsed;
}

/**
 * Parses the comma separated uma column into numbers.
 * @param {unknown} value e.g. '20,10,-10,-20'
 * @returns {number[]} Empty array when the cell is blank.
 */
function parseUma(value) {
  var text = String(value === null || value === undefined ? '' : value).trim();
  if (!text) return [];
  return text.split(',').map(function (part) { return normalizeNumber(part); });
}

/**
 * Formats rank points back into the comma separated column format.
 * @param {number[]|string} uma
 * @returns {string}
 */
function formatUma(uma) {
  return Array.isArray(uma) ? uma.join(',') : String(uma);
}

/**
 * Converts one sheet row into a plain object using the sheet's column order.
 * @param {string} tableName
 * @param {unknown[]} row
 * @returns {Record<string, any>}
 */
function rowToObject(tableName, row) {
  var columns = SCHEMA[tableName];
  /** @type {Record<string, any>} */
  var obj = {};
  for (var i = 0; i < columns.length; i++) {
    var key = columns[i];
    var value = row[i];
    if (NUMBER_COLUMNS[key]) obj[key] = normalizeNumber(value);
    else if (BOOLEAN_COLUMNS[key]) obj[key] = normalizeBoolean(value);
    else if (DATE_COLUMNS[key]) obj[key] = normalizeDateKey(value);
    else obj[key] = value === null || value === undefined ? '' : String(value);
  }
  return obj;
}

/**
 * Converts a plain object into a sheet row using the sheet's column order.
 * @param {string} tableName
 * @param {Record<string, any>} obj
 * @returns {unknown[]}
 */
function objectToRow(tableName, obj) {
  return SCHEMA[tableName].map(function (key) {
    var value = obj[key];
    return value === undefined || value === null ? '' : value;
  });
}

