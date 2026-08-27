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

/**
 * Evaluation order. src/Store.js is absent on purpose: LocalStore.js defines the
 * same global functions against a JSON file, so nothing above the storage layer
 * can tell the difference.
 */
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
 * @param {{today?: Date, seed?: number, skillStep?: number,
 *   fourPlayer?: number, threePlayer?: number}} [options]
 *   Without fourPlayer/threePlayer the fixed six-game sample is used.
 * @returns {number} Number of games inserted.
 */
function seedSampleData(app, options) {
  if (app.call('apiGetHistory', {}).total > 0) return 0;

  const opts = options || {};
  const fourPlayer = opts.fourPlayer || 0;
  const threePlayer = opts.threePlayer || 0;
  const total = fourPlayer + threePlayer;
  // With no counts asked for, the original six fixed games stand. Tests depend
  // on them down to the individual scores, so they are never generated.
  const generated = total > 0;
  const wanted = generated ? total : 6;

  const today = opts.today || new Date();
  const names = generated ? SKILL_ORDER.slice() : ['父', '母', '兄', '妹'];
  const players = names.map((name) => app.call('apiAddPlayer', name));

  // Seeded rather than random: a chart that looked wrong is worth being able to
  // reproduce. Changing the seed gives an independent sample, which is the only
  // way to tell a quirk of one dataset from a bias in how it is generated.
  const random = mulberry32(opts.seed || 20260825);

  let threeSoFar = 0;
  for (let index = 0; index < wanted; index += 1) {
    // Spread the three-handed games evenly through the run rather than putting
    // them at one end, and without a fixed period: the table is picked by index
    // modulo the five players, so a period sharing a factor with five would sit
    // the same people down every time.
    const wantThree = generated &&
      Math.floor(((index + 1) * threePlayer) / wanted) > threeSoFar;
    if (wantThree) threeSoFar += 1;

    const seats = wantThree ? 3 : 4;
    const table = [];
    for (let i = 0; i < seats; i += 1) {
      table.push(players[(index + i) % players.length]);
    }

    const scores = generated
      ? randomScores(
          random,
          table.map((player) => skillOf(player.name)),
          wantThree ? 105000 : 100000,
          opts.skillStep === undefined ? SKILL_STEP : opts.skillStep)
      : FIXED_SCORE_SETS[index % FIXED_SCORE_SETS.length]
        .map((_score, seat, all) => all[(seat + index % 4) % 4]);

    // Two games a day. The six-game default keeps its original span of three
    // days ending today, so the dates the tests look for do not move.
    const dayOffset = generated
      ? Math.floor((wanted - 1 - index) / 2)
      : 4 - Math.floor(index / 2) * 2;
    const date = new Date(today.getTime() - dayOffset * 86400000);
    app.call('apiSubmitGame', {
      gameDate: date.toISOString().slice(0, 10),
      ruleId: wantThree ? 'R002' : 'R001',
      venue: index % 7 === 0 ? '実家' : '自宅',
      recordedBy: '父',
      entries: table.map((player, seat) => ({
        seat,
        playerId: player.playerId,
        rawScore: scores[seat]
      }))
    });
  }
  return wanted;
}

/**
 * Where a player sits on the seniority ladder, as a signed number of steps
 * either side of the middle. Unknown names are treated as average.
 *
 * @param {string} name
 * @returns {number}
 */
function skillOf(name) {
  const rank = SKILL_ORDER.indexOf(name);
  return rank < 0 ? 0 : (SKILL_ORDER.length - 1) / 2 - rank;
}

/** The original six games, kept exactly as they were so tests do not move. */
const FIXED_SCORE_SETS = [
  [45200, 28700, 17800, 8300],
  [32100, 30400, 24500, 13000],
  [51600, 25300, 15200, 7900],
  [38800, 27100, 22600, 11500],
  [29400, 28900, 26300, 15400],
  [60100, 22800, 18700, -1600]
];

/**
 * A small deterministic PRNG, so a seeded database can be regenerated exactly.
 * @param {number} seed
 * @returns {() => number} Values in [0, 1).
 */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Standard deviation of a player's final score before the table is balanced.
 *
 * Chosen so the finished scores spread about as widely as real hanchan do --
 * roughly a 16,000 point standard deviation around the 25,000 start, which also
 * puts a player below zero about one game in twenty.
 */
const SCORE_SIGMA = { 4: 19000, 3: 25000 };

/**
 * Points of expected score per step of the seniority ladder.
 *
 * Measured, not guessed: at 2,750 the top of the ladder averages 2.20 placings
 * over four-handed games and the bottom 2.80, with the finished scores spread
 * about 16,900 points and a player finishing below zero 6.9% of the time --
 * all in the range real hanchan sit in. `node dev/calibrate-seed.js` re-runs
 * the measurement.
 */
const SKILL_STEP = 2750;

/** Skill order, strongest first. Offsets are steps either side of even. */
const SKILL_ORDER = ['妹', '祖父', '父', '母', '兄'];

/**
 * A standard normal sample, so scores cluster the way real ones do rather than
 * spreading evenly across the range.
 *
 * @param {() => number} random
 * @returns {number}
 */
function gaussian(random) {
  const u = 1 - random();
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Raw scores for one game that add up exactly, in 100-point units.
 *
 * Each player is drawn around a mean shifted by their place on the seniority
 * ladder, then the table is balanced by moving the shared excess off everyone
 * equally. Balancing is what makes skill relative: a strong table pulls every
 * score back down, exactly as points changing hands does.
 *
 * @param {() => number} random
 * @param {number[]} skills One offset per seat, in ladder steps.
 * @param {number} total
 * @param {number} step Points of expected score per ladder step.
 * @returns {number[]}
 */
function randomScores(random, skills, total, step) {
  const seats = skills.length;
  const mean = total / seats;
  const sigma = SCORE_SIGMA[seats];
  const drawn = skills.map((skill) => mean + skill * step + gaussian(random) * sigma);

  const excess = drawn.reduce((sum, score) => sum + score, 0) - total;
  const scores = drawn.map((score) => Math.round((score - excess / seats) / 100) * 100);

  // Rounding leaves the total a few hundred out. Correcting it on a random seat
  // rather than a fixed one keeps the fix from favouring anybody.
  const drift = scores.reduce((sum, score) => sum + score, 0) - total;
  scores[Math.floor(random() * seats)] -= drift;
  return scores;
}

/**
 * Renders index.html the way HtmlService templates do, resolving include() calls.
 * @param {string} [extraHead] Markup injected before </head>.
 * @returns {string}
 */
function renderIndexHtml(extraHead) {
  const template = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  const config = loadPureFunctions(['Config.js'], ['APP_TITLE', 'DEFAULT_ACCENT', 'DEFAULT_ICONS']);
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

/**
 * A value that changes whenever one of the loaded sources changes on disk.
 *
 * index.html and its includes are re-read per request, but the .js files are
 * evaluated into a VM once at startup. Without this the two drift apart after
 * an edit -- the browser gets new front-end code talking to a stale server.
 *
 * @returns {string}
 */
function sourcesFingerprint() {
  return LOAD_ORDER
    .map((file) => `${file}:${fs.statSync(file).mtimeMs}`)
    .join('|');
}

module.exports = {
  createAppContext,
  sourcesFingerprint,
  // Exported for dev/calibrate-seed.js, which measures the generated data
  // without paying for a round trip through the store for every game.
  mulberry32,
  randomScores,
  skillOf,
  SKILL_ORDER,
  SKILL_STEP,
  seedSampleData,
  renderIndexHtml,
  loadPureFunctions,
  ROOT,
  SRC
};
