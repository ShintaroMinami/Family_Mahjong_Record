#!/usr/bin/env node
/**
 * Regenerates the tab screenshots used by the README and docs/index.html.
 *
 * Boots the development server against a throwaway database, drives the real
 * UI in headless Chrome over the DevTools protocol, and writes one full-page
 * PNG per tab into docs/. Node's built-in WebSocket does the talking, so no
 * automation library is needed -- the same reason the e2e test drives Chrome
 * from the command line.
 *
 * Usage:
 *   node dev/screenshots.js
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createAppContext, seedSampleData, ROOT } = require('./app-context');
const { createServer } = require('./server');

/** Where Chrome usually lives, per platform. CHROME_PATH overrides all of them. */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium'
].filter(Boolean);

const OUT_DIR = path.join(ROOT, 'docs');
/** A large phone. Wide enough that the widest table (the entry preview) fits. */
const WIDTH = 430;
const VIEWPORT_HEIGHT = 844;
/** Retina, so the shots stay readable when a page scales them down. */
const SCALE = 2;
/** The history list holds 100 games; a screenshot only needs to show the shape. */
const HISTORY_ROWS = 8;
const SAMPLE = { fourPlayer: 200, threePlayer: 100 };

const TABS = [
  { id: 'entry', file: 'screen-entry.png' },
  { id: 'today', file: 'screen-today.png' },
  { id: 'history', file: 'screen-history.png' },
  { id: 'stats', file: 'screen-stats.png' },
  { id: 'settings', file: 'screen-settings.png' }
];

/** Scores for the entry form, so the main screen shows a real calculation. */
const ENTRY_SCORES = [42300, 29800, 18600, 9300];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Minimal DevTools protocol client over one flat session. */
class Cdp {
  /** @param {WebSocket} socket */
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.sessionId = null;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {?string} [sessionId] Explicit null addresses the browser itself.
   * @returns {Promise<any>}
   */
  send(method, params, sessionId) {
    const id = this.nextId += 1;
    const payload = { id, method, params: params || {} };
    const session = sessionId === undefined ? this.sessionId : sessionId;
    if (session) payload.sessionId = session;
    this.socket.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /**
   * Evaluates an expression in the page and returns its value.
   * @param {string} expression
   * @returns {Promise<any>}
   */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }

  /**
   * Polls an expression until it is truthy.
   * @param {string} label Named in the error if it never becomes true.
   * @param {string} expression
   * @returns {Promise<void>}
   */
  async waitFor(label, expression) {
    for (let i = 0; i < 150; i += 1) {
      if (await this.evaluate(expression)) return;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${label}`);
  }
}

/** Reads the port Chrome writes into its profile once DevTools is listening. */
async function devtoolsPort(profileDir) {
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  for (let i = 0; i < 100; i += 1) {
    await sleep(100);
    if (!fs.existsSync(portFile)) continue;
    const first = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
    if (first) return Number(first);
  }
  throw new Error('Chrome never published a DevTools port');
}

async function main() {
  const chromePath = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!chromePath) throw new Error('no Chrome binary found (set CHROME_PATH)');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mahjong-shots-'));
  const profileDir = path.join(dataDir, 'chrome-profile');
  const app = createAppContext({ dataDir, reset: true });
  seedSampleData(app, SAMPLE);

  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank'
  ], { stdio: 'ignore' });

  const version = await (await fetch(`http://127.0.0.1:${await devtoolsPort(profileDir)}/json/version`)).json();
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', reject);
  });

  const cdp = new Cdp(socket);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }, null);
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }, null);
  cdp.sessionId = sessionId;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // mobile:false on purpose. The local server serves index.html without the
  // viewport meta tag that doGet() adds in production, and mobile emulation
  // would answer that with its 980px fallback layout instead of a phone width.
  const applyMetrics = () => cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: VIEWPORT_HEIGHT, deviceScaleFactor: SCALE, mobile: false
  });
  await applyMetrics();

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const tab of TABS) {
    await shoot(cdp, applyMetrics, port, tab);
  }

  socket.close();
  chrome.kill();
  server.close();
  // Chrome keeps writing to its profile for a moment after kill().
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
  } catch (error) {
    console.warn(`一時ディレクトリが残りました: ${dataDir}`);
  }
}

/**
 * Loads the app, opens one tab and writes its full-page screenshot.
 *
 * @param {Cdp} cdp
 * @param {() => Promise<any>} applyMetrics Re-applied per load; a navigation drops the override.
 * @param {number} port
 * @param {{id: string, file: string}} tab
 * @returns {Promise<void>}
 */
async function shoot(cdp, applyMetrics, port, tab) {
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await applyMetrics();
  await cdp.waitFor('bootstrap', `
    (function () {
      var overlay = document.getElementById('overlay');
      return !!overlay && !overlay.classList.contains('show') &&
        document.querySelectorAll('#in-rule option').length > 0;
    })()
  `);

  await cdp.evaluate(`document.querySelector('[data-tab="${tab.id}"]').click()`);
  await cdp.waitFor(`${tab.id} content`, `
    (function () {
      if (document.getElementById('overlay').classList.contains('show')) return false;
      var panel = document.getElementById('panel-${tab.id}');
      return !!panel && panel.classList.contains('active') && panel.textContent.trim().length > 0;
    })()
  `);

  if (tab.id === 'entry') await fillEntryForm(cdp);
  if (tab.id === 'history') await trimHistory(cdp);
  await sleep(400);

  await cdp.evaluate(`
    (function () {
      var title = document.querySelector('header h1');
      // The development server marks the header so a local tab is never mistaken
      // for the deployed one. The screenshots stand in for the deployed app.
      if (title) title.textContent = title.textContent.replace('（LOCAL）', '');
      var style = document.getElementById('shot-style') || document.createElement('style');
      style.id = 'shot-style';
      // The tab bar is fixed to the viewport, so a full-page capture would leave
      // it stranded at the bottom of a very tall image. docs/index.html and the
      // README draw their own switcher instead.
      style.textContent = 'nav.tabbar { display: none !important; }' +
        'body { padding-bottom: 0 !important; } main { padding-bottom: 16px !important; }';
      document.head.appendChild(style);
      window.scrollTo(0, 0);
      return true;
    })()
  `);
  await sleep(200);

  const height = await cdp.evaluate('document.documentElement.scrollHeight');
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    // scale stays 1: the device scale factor already doubles the pixels.
    clip: { x: 0, y: 0, width: WIDTH, height, scale: 1 }
  });
  const file = path.join(OUT_DIR, tab.file);
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log(`  docs/${tab.file}  ${WIDTH}x${height} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
}

/** Fills the entry form and previews it, so the shot shows a real calculation. */
async function fillEntryForm(cdp) {
  await cdp.evaluate(`
    (function () {
      var scores = ${JSON.stringify(ENTRY_SCORES)};
      Array.prototype.forEach.call(document.querySelectorAll('#seat-grid .seat-row'), function (row, seat) {
        var player = row.querySelector('.in-player');
        // Index 0 is the blank "-- 選択 --" option.
        player.selectedIndex = seat + 1;
        player.dispatchEvent(new Event('change', { bubbles: true }));
        var score = row.querySelector('.in-score');
        score.value = String(scores[seat]);
        score.dispatchEvent(new Event('input', { bubbles: true }));
      });
      document.getElementById('btn-preview').click();
      return true;
    })()
  `);
  await cdp.waitFor('preview', "document.getElementById('preview-area').children.length > 0");
}

/** Drops all but the first few history rows. */
async function trimHistory(cdp) {
  await cdp.evaluate(`
    (function () {
      var card = document.querySelector('#history-list .card');
      if (!card) return false;
      var kept = 0;
      Array.prototype.slice.call(card.children).forEach(function (child) {
        if (child.tagName === 'H2') return;
        kept += 1;
        if (kept > ${HISTORY_ROWS}) child.remove();
      });
      return true;
    })()
  `);
}

console.log('画面サンプルを撮影します…');
main().then(() => {
  console.log('完了');
}).catch((error) => {
  console.error(error.message);
  process.exit(1);
});
