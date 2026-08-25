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
    .setTitle(APP_TITLE)
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
    name: '四麻 25000/30000 ウマ10-20 トビ10',
    playerCount: 4,
    startPoints: 25000,
    returnPoints: 30000,
    uma: '20,10,-10,-20',
    tobiBonus: 10,
    active: true
  },
  {
    ruleId: 'R002',
    name: '三麻 35000/40000 ウマ10-20 トビ10',
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
    spreadsheet = SpreadsheetApp.create(APP_TITLE + ' データ');
    spreadsheet.setSpreadsheetTimeZone('Asia/Tokyo');
    properties.setProperty(SPREADSHEET_ID_KEY, spreadsheet.getId());
  }

  Object.keys(SCHEMA).forEach(function (tableName) { getSheet_(tableName); });

  // The default 'シート1' left over from create() only gets in the way.
  var leftover = spreadsheet.getSheetByName('シート1') || spreadsheet.getSheetByName('Sheet1');
  if (leftover && spreadsheet.getSheets().length > 1) spreadsheet.deleteSheet(leftover);

  if (!storeReadTable('Rules').length) storeAppendRows('Rules', DEFAULT_RULES);

  // Minted here rather than left to the UI so that the app is never reachable
  // for writing by URL alone, not even for the minutes between deploying and
  // choosing a passcode.
  var minted = ensurePasscode_();

  var url = spreadsheet.getUrl();
  Logger.log('セットアップ完了: ' + url);
  Logger.log('');
  Logger.log('--- 次にやること ---');
  if (minted) {
    Logger.log('1. パスワードを発行しました: ' + minted);
    Logger.log('   このままでも使えますが、設定タブで覚えやすいものに変更してください。');
    Logger.log('   家族に伝えるまでURLだけでは誰も入れません。');
  } else {
    Logger.log('1. パスワードは設定済みです。忘れた場合はスクリプトプロパティ');
    Logger.log('   PASSCODE を削除してから setup() をやり直してください。');
  }
  Logger.log('2. タイトルは「' + APP_TITLE + '」です。');
  Logger.log('   変えるなら src/Config.js の APP_TITLE を編集して npm run deploy。');
  Logger.log('   タブ・画面見出し・このスプレッドシート名がまとめて変わります。');
  Logger.log('3. 配色の既定は src/Config.js の DEFAULT_ACCENT で決まります。');
  Logger.log('   使う人は設定タブで各自変更できます（端末ごとに記憶されます）。');
  return url;
}
