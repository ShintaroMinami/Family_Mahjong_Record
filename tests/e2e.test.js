'use strict';

/**
 * Browser end-to-end test.
 *
 * Boots the development server against a temporary database, drives the real UI
 * in headless Chrome (dev/e2e-script.js), and asserts on the report the page
 * posts back. Skipped when no Chrome binary is available.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createAppContext, seedSampleData } = require('../dev/app-context');
const { createServer } = require('../dev/server');

/** Where Chrome usually lives, per platform. CHROME_PATH overrides all of them. */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium'
].filter(Boolean);

function findChrome() {
  return CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || null;
}

const chromePath = findChrome();

/**
 * Boots the app, drives it in headless Chrome and returns the page's report.
 *
 * @param {import('node:test').TestContext} t
 * @param {{mode?: string, prepare?: (app: any) => void}} [options]
 *   mode selects the in-browser scenario (?e2e=<mode>, default '1');
 *   prepare runs against the app before the browser opens.
 * @returns {Promise<{name: string, pass: boolean, detail: string}[]>}
 */
async function runBrowserScenario(t, options) {
  const opts = options || {};
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mahjong-e2e-'));
  const profileDir = path.join(dataDir, 'chrome-profile');
  const app = createAppContext({ dataDir, reset: true });
  seedSampleData(app, { today: new Date() });
  if (opts.prepare) opts.prepare(app);

  let resolveReport;
  const reportPromise = new Promise((resolve) => { resolveReport = resolve; });
  const server = createServer(app, { onE2eReport: resolveReport });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-extensions',
    // The narrowest viewport headless Chrome will honour (it clamps to ~500px),
    // so layout regressions at phone width are caught.
    '--window-size=390,880',
    `--user-data-dir=${profileDir}`,
    `http://127.0.0.1:${port}/?e2e=${opts.mode || '1'}`
  ], { stdio: 'ignore' });

  t.after(async () => {
    // Wait for Chrome to actually exit: it keeps writing to its profile
    // directory for a moment after kill(), which makes the removal fail.
    chrome.kill();
    if (chrome.exitCode === null) {
      await new Promise((resolve) => chrome.once('exit', resolve));
    }
    server.close();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  // unref() so the timer cannot keep the test process alive after a fast run.
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('ブラウザからのレポートがタイムアウトしました')), 90000);
    timer.unref();
  });

  const report = await Promise.race([reportPromise, timeout]);
  clearTimeout(timer);
  return report;
}

/** Formats a report and fails the test if any check did not pass. */
function assertScenario(t, report, minimumChecks) {
  const summary = report
    .map((row) => `${row.pass ? 'OK' : 'NG'} ${row.name}${row.detail ? ' | ' + row.detail : ''}`)
    .join('\n');
  t.diagnostic('\n' + summary);

  const failed = report.filter((row) => !row.pass);
  assert.ok(report.length >= minimumChecks,
    `expected a full scenario, got ${report.length} checks:\n${summary}`);
  assert.equal(failed.length, 0, `ブラウザテストが失敗しました:\n${summary}`);
}

test('browser end-to-end scenario', { skip: chromePath ? false : 'Chrome が見つかりません' },
  async (t) => {
    assertScenario(t, await runBrowserScenario(t), 20);
  });

test('passcode gate blocks the app until the right passcode is entered',
  { skip: chromePath ? false : 'Chrome が見つかりません' },
  async (t) => {
    const report = await runBrowserScenario(t, {
      mode: 'gate',
      prepare: (app) => app.call('apiSetPasscode', 'kazoku2026')
    });
    assertScenario(t, report, 8);
  });
