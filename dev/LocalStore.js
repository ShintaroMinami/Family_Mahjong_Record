/**
 * Local development replacement for src/Store.js.
 *
 * It exposes exactly the same global functions, backed by a JSON file instead
 * of a spreadsheet. Rows are held as arrays and pushed back through
 * rowToObject/objectToRow, so the value normalisation path is identical to the
 * real one and type bugs show up locally too.
 *
 * This file is evaluated in the same VM context as src/*.js, so it can use the
 * globals defined there (SCHEMA, rowToObject, ...).
 */

var LOCAL_DB_PATH = __LOCAL_DB_PATH__;

/**
 * Reads the whole database file.
 * @returns {Record<string, unknown[][]>}
 */
function localReadDb_() {
  if (!__fs.existsSync(LOCAL_DB_PATH)) return {};
  try {
    return JSON.parse(__fs.readFileSync(LOCAL_DB_PATH, 'utf8'));
  } catch (error) {
    throw new Error('ローカルDBの読み込みに失敗しました: ' + error.message);
  }
}

/**
 * Writes the whole database file.
 * @param {Record<string, unknown[][]>} db
 */
function localWriteDb_(db) {
  __fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(db, null, 2));
}

/**
 * @param {string} tableName
 * @returns {Record<string, any>[]}
 */
function storeReadTable(tableName) {
  var rows = localReadDb_()[tableName] || [];
  return rows
    .filter(function (row) { return String(row[0]).trim() !== ''; })
    .map(function (row) { return rowToObject(tableName, row); });
}

/**
 * @param {string} tableName
 * @param {Record<string, any>[]} objects
 */
function storeAppendRows(tableName, objects) {
  if (!objects.length) return;
  var db = localReadDb_();
  if (!db[tableName]) db[tableName] = [];
  objects.forEach(function (obj) { db[tableName].push(objectToRow(tableName, obj)); });
  localWriteDb_(db);
}

/**
 * @param {string} tableName
 * @param {string} keyColumn
 * @param {Record<string, Record<string, any>>} updatesByKey
 * @returns {number}
 */
function storeUpdateRowsByKey(tableName, keyColumn, updatesByKey) {
  var db = localReadDb_();
  var rows = db[tableName] || [];
  var keyIndex = SCHEMA[tableName].indexOf(keyColumn);
  if (keyIndex < 0) throw new Error('unknown column: ' + tableName + '.' + keyColumn);
  var updated = 0;
  for (var i = 0; i < rows.length; i++) {
    var key = String(rows[i][keyIndex]);
    if (Object.prototype.hasOwnProperty.call(updatesByKey, key)) {
      rows[i] = objectToRow(tableName, updatesByKey[key]);
      updated++;
    }
  }
  if (updated) { db[tableName] = rows; localWriteDb_(db); }
  return updated;
}

/**
 * @param {string} tableName
 * @param {string} keyColumn
 * @param {string[]} keys
 * @returns {number}
 */
function storeDeleteRowsByKey(tableName, keyColumn, keys) {
  if (!keys.length) return 0;
  var db = localReadDb_();
  var rows = db[tableName] || [];
  var keyIndex = SCHEMA[tableName].indexOf(keyColumn);
  var targets = {};
  keys.forEach(function (key) { targets[String(key)] = true; });
  var kept = rows.filter(function (row) { return !targets[String(row[keyIndex])]; });
  var removed = rows.length - kept.length;
  if (removed) { db[tableName] = kept; localWriteDb_(db); }
  return removed;
}

/**
 * The local server is single threaded, so there is nothing to lock.
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function withLock(fn) { return fn(); }

/** @returns {string} */
function nowIso() { return new Date().toISOString(); }

/** @returns {string} */
function todayKey() { return formatDateKey(new Date()); }

/**
 * Creates the tables and seeds the default rules. Mirrors setup() in Code.js.
 * @returns {string}
 */
function setup() {
  var db = localReadDb_();
  Object.keys(SCHEMA).forEach(function (tableName) {
    if (!db[tableName]) db[tableName] = [];
  });
  localWriteDb_(db);
  if (!storeReadTable('Rules').length) storeAppendRows('Rules', DEFAULT_RULES);
  return LOCAL_DB_PATH;
}
