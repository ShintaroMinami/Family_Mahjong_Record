'use strict';

/**
 * Loads the Apps Script sources into a single Node VM context.
 *
 * Apps Script shares one global scope across every .js file, so evaluating the
 * files in order into one context reproduces the production environment closely.
 * Only the storage layer is swapped (dev/LocalStore.js replaces src/Store.js),
 * which means the local server and the API tests exercise the code that ships.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

/** Evaluation order. LocalStore.js is last so its definitions win over Store.js. */
const LOAD_ORDER = [
  path.join(SRC, 'Config.js'),
  path.join(SRC, 'Schema.js'),
  path.join(SRC, 'Domain.js'),
  path.join(SRC, 'Stats.js'),
  path.join(SRC, 'Auth.js'),
  path.join(SRC, 'Repo.js'),
  path.join(SRC, 'Api.js'),
  path.join(SRC, 'Code.js'),
  path.join(__dirname, 'LocalStore.js')
];

/**
 * @typedef {Object} AppContext
 * @property {vm.Context} context      The VM global object.
 * @property {string[]} apiNames       Server functions callable from the browser.
 * @property {(name: string, ...args: any[]) => any} call Invokes a server function.
 * @property {string} dbPath
 */

/**
 * Builds a ready-to-use application context.
 *
 * @param {{dataDir: string, reset?: boolean}} options
 * @returns {AppContext}
 */
function createAppContext(options) {
  const dataDir = options.dataDir;
  const dbPath = path.join(dataDir, 'db.json');
  const propsPath = path.join(dataDir, 'properties.json');

  fs.mkdirSync(dataDir, { recursive: true });
  if (options.reset) {
    // Properties go too: a passcode left over from a previous run would make
    // the reseeded database unreachable.
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(propsPath)) fs.unlinkSync(propsPath);
  }

  const readProps = () =>
    fs.existsSync(propsPath) ? JSON.parse(fs.readFileSync(propsPath, 'utf8')) : {};
  const writeProps = (props) => fs.writeFileSync(propsPath, JSON.stringify(props, null, 2));

  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (key) => readProps()[key] ?? null,
      setProperty: (key, value) => {
        const props = readProps();
        props[key] = value;
        writeProps(props);
      },
      deleteProperty: (key) => {
        const props = readProps();
        delete props[key];
        writeProps(props);
      }
    })
  };

  // Reaching SpreadsheetApp locally means LocalStore failed to take over, which
  // should fail loudly rather than silently do nothing.
  const SpreadsheetApp = new Proxy({}, {
    get(_target, prop) {
      throw new Error(
        `SpreadsheetApp.${String(prop)} は本番専用です（ローカルでは LocalStore が使われます）`
      );
    }
  });

  // Only non-standard globals are injected. Object, JSON, Intl and friends already
  // exist inside the VM realm; passing Node's versions in would mix two realms'
  // built-ins for no benefit.
  const context = vm.createContext({
    console,
    PropertiesService,
    SpreadsheetApp,
    Logger: { log: (...args) => console.log('[Logger]', ...args) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    // apiSetPasscode treats a signed-in caller as the owner at the editor. Local
    // development is single-user and trusted, so it always looks signed in.
    Session: { getActiveUser: () => ({ getEmail: () => 'local@example.invalid' }) },
    Utilities: { getUuid: () => randomUUID() },
    __fs: fs,
    __LOCAL_DB_PATH__: dbPath
  });

  for (const file of LOAD_ORDER) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, {
      filename: path.relative(ROOT, file)
    });
  }

  const apiNames = Object.getOwnPropertyNames(context)
    .filter((name) => name.startsWith('api') && typeof context[name] === 'function')
    .sort();

  // Values are round-tripped through JSON on the way out, exactly as
  // google.script.run does. It also hands back plain Node-realm objects, which
  // VM-realm ones are not (deepStrictEqual would reject them in tests).
  const call = (name, ...args) => {
    if (typeof context[name] !== 'function') throw new Error(`unknown function: ${name}`);
    const result = context[name].apply(null, args);
    return result === undefined ? null : JSON.parse(JSON.stringify(result));
  };

  call('setup');

  return { context, apiNames, call, dbPath };
}

/**
 * Inserts a handful of games so the views have something to display.
 *
 * Scores are fixed and each set sums to 100000, so a seeded database is
 * reproducible and its point totals cancel out exactly.
 *
 * @param {AppContext} app
 * @param {{today?: Date}} [options]
 * @returns {number} Number of games inserted.
 */
function seedSampleData(app, options) {
  if (app.call('apiGetHistory', {}).total > 0) return 0;

  const players = ['父', '母', '兄', '妹'].map((name) => app.call('apiAddPlayer', name));
  const scoreSets = [
    [45200, 28700, 17800, 8300],
    [32100, 30400, 24500, 13000],
    [51600, 25300, 15200, 7900],
    [38800, 27100, 22600, 11500],
    [29400, 28900, 26300, 15400],
    [60100, 22800, 18700, -1600]
  ];
  const today = (options && options.today) || new Date();

  let index = 0;
  for (let dayOffset = 4; dayOffset >= 0; dayOffset -= 2) {
    const date = new Date(today.getTime() - dayOffset * 86400000);
    const gameDate = date.toISOString().slice(0, 10);
    for (let n = 0; n < 2; n++) {
      const scores = scoreSets[index % scoreSets.length];
      const rotation = index % 4; // rotate seats so ranks vary between players
      app.call('apiSubmitGame', {
        gameDate,
        ruleId: 'R001',
        venue: '自宅',
        recordedBy: '父',
        entries: players.map((player, seat) => ({
          seat,
          playerId: player.playerId,
          rawScore: scores[(seat + rotation) % 4],
          chips: 0
        }))
      });
      index++;
    }
  }
  return index;
}

/**
 * Renders index.html the way HtmlService templates do, resolving include() calls.
 * @param {string} [extraHead] Markup injected before </head>.
 * @returns {string}
 */
function renderIndexHtml(extraHead) {
  const template = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  const config = loadPureFunctions(['Config.js'], ['APP_TITLE', 'DEFAULT_ACCENT']);
  const resolved = template
    .replace(
      /<\?!?=?\s*include\(\s*'([\w-]+)'\s*\)\s*;?\s*\?>/g,
      (_match, name) => fs.readFileSync(path.join(SRC, `${name}.html`), 'utf8')
    )
    // Any bare `<?= NAME ?>` is a Config.js constant; Apps Script substitutes
    // these itself, so the local server has to do the same.
    .replace(/<\?!?=\s*(\w+)\s*;?\s*\?>/g, (match, name) =>
      (name in config ? String(config[name]) : match));
  // A replacement function, not a string: in a replacement string `$$` collapses
  // to `$`, which silently mangles injected JavaScript.
  return extraHead ? resolved.replace('</head>', () => `${extraHead}\n</head>`) : resolved;
}

/**
 * Loads pure-logic source files into the current realm and returns the named
 * functions from them.
 *
 * Apps Script files share one global scope and carry no module exports, so unit
 * tests cannot simply require() them. Evaluating them here keeps the production
 * files free of test-only plumbing, and — unlike the VM context used elsewhere —
 * the values handed back are ordinary Node objects that deepStrictEqual accepts.
 *
 * Only files without any GAS dependency may be loaded this way.
 *
 * @param {string[]} fileNames    File names inside src/, evaluated in order.
 * @param {string[]} exportNames  Names to hand back; constants as well as functions.
 * @returns {Record<string, any>}
 */
function loadPureFunctions(fileNames, exportNames) {
  const code = fileNames
    .map((name) => fs.readFileSync(path.join(SRC, name), 'utf8'))
    .join('\n');
  return vm.runInThisContext(
    `(function () {\n${code}\nreturn { ${exportNames.join(', ')} };\n})()`,
    { filename: 'src/' + fileNames.join('+') }
  );
}

module.exports = {
  createAppContext,
  seedSampleData,
  renderIndexHtml,
  loadPureFunctions,
  ROOT,
  SRC
};
