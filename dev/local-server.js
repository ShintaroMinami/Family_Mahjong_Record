#!/usr/bin/env node
/**
 * Local development server for the Apps Script web app.
 *
 * Runs the real src/*.js against a JSON file instead of a spreadsheet, so the
 * whole app can be exercised in a browser before anything is deployed.
 *
 * Usage:
 *   node dev/local-server.js [--port 8080] [--seed] [--reset]
 */

'use strict';

const path = require('node:path');
const { createAppContext, seedSampleData, sourcesFingerprint, ROOT } = require('./app-context');
const { createServer } = require('./server');

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const flagValue = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const PORT = Number(flagValue('--port', process.env.PORT || 8080));
const DATA_DIR = path.join(__dirname, 'data');
let app = createAppContext({ dataDir: DATA_DIR, reset: hasFlag('--reset') });

// The HTML is re-read per request, so without this an edit to src/*.js leaves
// new front-end code talking to the server that was loaded at startup -- which
// looks like a feature silently breaking rather than like a stale process.
let loaded = sourcesFingerprint();
const currentApp = () => {
  const now = sourcesFingerprint();
  if (now !== loaded) {
    loaded = now;
    app = createAppContext({ dataDir: DATA_DIR });
    console.log('  src/ の変更を読み直しました');
  }
  return app;
};

if (hasFlag('--seed')) {
  const inserted = seedSampleData(app, {
    fourPlayer: Number(flagValue('--games4', 0)),
    threePlayer: Number(flagValue('--games3', 0))
  });
  console.log(inserted
    ? `サンプルデータを投入しました（${inserted}半荘）`
    : '既にデータがあるためシードをスキップしました');
}

// Bound to the loopback interface on purpose: the development database has no
// passcode, so binding to 0.0.0.0 (Node's default) would hand every device on
// the network read and write access to it.
createServer(currentApp).listen(PORT, '127.0.0.1', () => {
  console.log('\n  家族麻雀 スコア記録 (LOCAL)');
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  DB : ${path.relative(ROOT, app.dbPath)}`);
  console.log(`  API: ${app.apiNames.join(', ')}\n`);
});
