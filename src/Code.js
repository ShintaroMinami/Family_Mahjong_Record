/**
 * Web app entry point and one-time setup.
 */

/**
 * Serves the single page app.
 * @param {GoogleAppsScript.Events.DoGet} [e]
 * @returns {GoogleAppsScript.HTML.HtmlOutput}
 */
function doGet(e) {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('家族麻雀 スコア記録')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/**
 * Inlines another HTML file. Used by index.html to pull in css.html and js.html.
 * @param {string} filename
 * @returns {string}
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/** Rule presets created on first setup. */
var DEFAULT_RULES = [
  {
    ruleId: 'R001',
    name: '四麻 25000/30000 ウマ10-20',
    playerCount: 4,
    startPoints: 25000,
    returnPoints: 30000,
    uma: '20,10,-10,-20',
    tobiBonus: 10,
    active: true
  },
  {
    ruleId: 'R002',
    name: '三麻 35000/40000 ウマ10-20',
    playerCount: 3,
    startPoints: 35000,
    returnPoints: 40000,
    uma: '20,0,-20',
    tobiBonus: 10,
    active: true
  }
];

/**
 * Creates the spreadsheet and seeds it. Run once from the Apps Script editor.
 *
 * Safe to run again: an existing spreadsheet is reused and existing rows are
 * left untouched.
 *
 * @returns {string} The spreadsheet URL.
 */
function setup() {
  var properties = PropertiesService.getScriptProperties();
  var id = properties.getProperty(SPREADSHEET_ID_KEY);
  var spreadsheet;

  if (id) {
    spreadsheet = SpreadsheetApp.openById(id);
  } else {
    spreadsheet = SpreadsheetApp.create('家族麻雀 スコア記録データ');
    spreadsheet.setSpreadsheetTimeZone('Asia/Tokyo');
    properties.setProperty(SPREADSHEET_ID_KEY, spreadsheet.getId());
  }

  Object.keys(SCHEMA).forEach(function (tableName) { getSheet_(tableName); });

  // The default 'シート1' left over from create() only gets in the way.
  var leftover = spreadsheet.getSheetByName('シート1') || spreadsheet.getSheetByName('Sheet1');
  if (leftover && spreadsheet.getSheets().length > 1) spreadsheet.deleteSheet(leftover);

  if (!storeReadTable('Rules').length) storeAppendRows('Rules', DEFAULT_RULES);

  var url = spreadsheet.getUrl();
  Logger.log('セットアップ完了: ' + url);
  return url;
}

/**
 * Returns the data spreadsheet URL, for the admin link in the UI.
 * @param {string} [passcode] 合言葉。設定されている場合のみ必要。
 * @returns {string}
 */
function apiGetSpreadsheetUrl(passcode) {
  requirePasscode_(passcode);
  return getSpreadsheet_().getUrl();
}
