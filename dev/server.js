'use strict';

/**
 * HTTP layer for the local development server.
 *
 * Serves the real index.html with include() resolved, and forwards
 * google.script.run calls to the loaded Apps Script functions.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { renderIndexHtml } = require('./app-context');

/**
 * Injected only for ?e2e=1, so normal browsing is never affected.
 * E2E_SCRIPT lets a throwaway script (e.g. one that just opens a tab for a
 * screenshot) take its place without touching the test scenario.
 */
const E2E_SCRIPT = process.env.E2E_SCRIPT || path.join(__dirname, 'e2e-script.js');

/** Injected for ?e2e=gate: the passcode screen needs its own fresh session. */
const E2E_GATE_SCRIPT = path.join(__dirname, 'e2e-gate-script.js');

/**
 * Builds the google.script.run shim that forwards calls to this server.
 *
 * A fresh runner is handed out on every property read, which matches how the
 * real google.script.run behaves when several calls are in flight at once.
 *
 * @param {string[]} apiNames
 * @returns {string}
 */
function runShim(apiNames) {
  return `<script>
(function () {
  var API_NAMES = ${JSON.stringify(apiNames)};
  function makeRunner() {
    var onSuccess = function () {};
    var onFailure = function (error) { console.error(error); };
    var runner = {
      withSuccessHandler: function (fn) { onSuccess = fn; return runner; },
      withFailureHandler: function (fn) { onFailure = fn; return runner; },
      withUserObject: function () { return runner; }
    };
    API_NAMES.forEach(function (name) {
      runner[name] = function () {
        var args = Array.prototype.slice.call(arguments);
        fetch('/api/' + name, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args)
        }).then(function (response) { return response.json(); })
          .then(function (payload) {
            if (payload.ok) onSuccess(payload.result);
            else onFailure(new Error(payload.error));
          })
          .catch(onFailure);
        return runner;
      };
    });
    return runner;
  }
  window.google = { script: { host: { close: function () {} } } };
  Object.defineProperty(window.google.script, 'run', { get: makeRunner });
  document.addEventListener('DOMContentLoaded', function () {
    // The app owns header .sub, so mark the local build on the title instead.
    var title = document.querySelector('header h1');
    if (title) title.textContent += '（LOCAL）';
  });
})();
</script>`;
}

/**
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<string>}
 */
function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e6) reject(new Error('request body too large'));
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  response.end(body);
}

/**
 * Creates the development HTTP server.
 *
 * @param {import('./app-context').AppContext} app
 * @param {{onE2eReport?: (report: any[]) => void}} [options]
 * @returns {import('node:http').Server}
 */
function createServer(app, options) {
  const opts = options || {};

  return http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    try {
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const shim = runShim(app.apiNames);
        const e2eMode = url.searchParams.get('e2e');
        const scenario = e2eMode === 'gate' ? E2E_GATE_SCRIPT : E2E_SCRIPT;
        const head = e2eMode
          ? `${shim}\n<script>\n${fs.readFileSync(scenario, 'utf8')}\n</script>`
          : shim;
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store'
        });
        response.end(renderIndexHtml(head));
        return;
      }

      if (request.method === 'POST' && url.pathname === '/e2e-report') {
        const report = JSON.parse((await readBody(request)) || '[]');
        if (opts.onE2eReport) opts.onE2eReport(report);
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
        const name = url.pathname.slice('/api/'.length);
        if (!app.apiNames.includes(name)) {
          sendJson(response, 404, { ok: false, error: `unknown api: ${name}` });
          return;
        }
        const args = JSON.parse((await readBody(request)) || '[]');
        try {
          sendJson(response, 200, { ok: true, result: app.call(name, ...args) });
        } catch (error) {
          console.error(`[api:${name}]`, error.message);
          // Mirrors google.script.run: a thrown server error reaches the failure handler.
          sendJson(response, 200, { ok: false, error: error.message });
        }
        return;
      }

      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('not found');
    } catch (error) {
      console.error(error);
      sendJson(response, 500, { ok: false, error: error.message });
    }
  });
}

module.exports = { createServer, runShim };
