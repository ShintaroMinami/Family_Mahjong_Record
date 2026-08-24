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
const { createAppContext, seedSampleData, ROOT } = require('./app-context');
const { createServer } = require('./server');

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const flagValue = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const PORT = Number(flagValue('--port', process.env.PORT || 8080));
const app = createAppContext({ dataDir: path.join(__dirname, 'data'), reset: hasFlag('--reset') });

if (hasFlag('--seed')) {
  const inserted = seedSampleData(app);
  console.log(inserted
    ? `サンプルデータを投入しました（${inserted}半荘）`
    : '既にデータがあるためシードをスキップしました');
}

createServer(app).listen(PORT, () => {
  console.log('\n  家族麻雀 スコア記録 (LOCAL)');
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  DB : ${path.relative(ROOT, app.dbPath)}`);
  console.log(`  API: ${app.apiNames.join(', ')}\n`);
});
