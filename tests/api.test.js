'use strict';

/**
 * Integration tests for the server API.
 *
 * These load the real src/*.js into a VM context with a temporary JSON database,
 * so they cover the full path from a browser payload down to the stored rows.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createAppContext, seedSampleData, renderIndexHtml, loadPureFunctions
} = require('../dev/app-context');

/** Builds an isolated app instance with an empty database. */
function freshApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mahjong-test-'));
  const app = createAppContext({ dataDir, reset: true });
  const players = ['父', '母', '兄', '妹'].map((name) => app.call('apiAddPlayer', name));
  return { app, players, dataDir };
}

const gamePayload = (players, scores, overrides) =>
  Object.assign({
    gameDate: '2026-08-24',
    ruleId: 'R001',
    entries: scores.map((rawScore, seat) => ({
      seat,
      playerId: players[seat].playerId,
      rawScore,
      chips: 0
    }))
  }, overrides);

test('setup seeds the default rule presets', () => {
  const { app } = freshApp();
  const rules = app.call('apiBootstrap').rules;
  assert.equal(rules.length, 2);
  assert.deepEqual(rules.map((r) => r.playerCount), [4, 3]);
  assert.deepEqual(rules[0].uma, [20, 10, -10, -20]);
});

test('adding an existing player name returns the same record', () => {
  const { app, players } = freshApp();
  const again = app.call('apiAddPlayer', '父');
  assert.equal(again.playerId, players[0].playerId);
  assert.equal(app.call('apiBootstrap').players.length, 4);
});

test('a blank player name is rejected', () => {
  const { app } = freshApp();
  assert.throws(() => app.call('apiAddPlayer', '   '), /名前を入力/);
});

test('submitting a game stores it and it shows up in the day summary', () => {
  const { app, players } = freshApp();
  const saved = app.call('apiSubmitGame', gamePayload(players, [45200, 28700, 17800, 8300], {
    venue: '自宅', paifuId: 'abc-123', note: 'テスト'
  }));

  assert.match(saved.gameId, /^G20260824-001$/);
  assert.deepEqual(saved.warnings, []);

  const day = app.call('apiGetDaySummary', '2026-08-24');
  assert.equal(day.gameCount, 1);
  assert.equal(day.games[0].paifuId, 'abc-123');
  assert.equal(day.games[0].results.length, 4);
  assert.deepEqual(day.games[0].results.map((r) => r.rank), [1, 2, 3, 4]);
  assert.deepEqual(day.summaries.map((s) => s.playerCount), [4]);
  assert.equal(day.summaries[0].players.reduce((sum, p) => sum + p.totalPt, 0), 0);
});

test('a day mixing table sizes is summarised separately but listed together', () => {
  const { app, players } = freshApp();
  const three = app.call('apiSaveRule', {
    name: 'テスト三麻', playerCount: 3, startPoints: 35000, returnPoints: 40000,
    uma: [20, 0, -20], tobiBonus: 10
  });

  app.call('apiSubmitGame', gamePayload(players, [45200, 28700, 17800, 8300]));
  app.call('apiSubmitGame', {
    gameDate: '2026-08-24',
    ruleId: three.ruleId,
    entries: players.slice(0, 3).map((player, seat) => ({
      seat, playerId: player.playerId, rawScore: [50000, 35000, 20000][seat], chips: 0
    }))
  });

  const day = app.call('apiGetDaySummary', '2026-08-24');

  // Four-handed first, and only sizes that were actually played appear.
  assert.deepEqual(day.summaries.map((s) => s.playerCount), [4, 3]);
  assert.deepEqual(day.summaries.map((s) => s.gameCount), [1, 1]);
  assert.equal(day.summaries[0].players.length, 4);
  assert.equal(day.summaries[1].players.length, 3);

  // Each summary is zero-sum on its own, which a mixed one need not be.
  day.summaries.forEach((summary) => {
    assert.ok(Math.abs(summary.players.reduce((sum, p) => sum + p.totalPt, 0)) < 0.005);
  });

  // The list itself stays mixed: it is a record of the day, not an aggregate.
  assert.equal(day.gameCount, 2);
  assert.equal(day.games.length, 2);
});

test('game ids increment per day', () => {
  const { app, players } = freshApp();
  app.call('apiSubmitGame', gamePayload(players, [45200, 28700, 17800, 8300]));
  const second = app.call('apiSubmitGame', gamePayload(players, [32100, 30400, 24500, 13000]));
  const otherDay = app.call('apiSubmitGame',
    gamePayload(players, [32100, 30400, 24500, 13000], { gameDate: '2026-08-25' }));

  assert.equal(second.gameId, 'G20260824-002');
  assert.equal(otherDay.gameId, 'G20260825-001');
});

test('a three-player game uses its own rule and stays zero-sum', () => {
  const { app, players } = freshApp();
  const saved = app.call('apiSubmitGame', {
    gameDate: '2026-08-24',
    ruleId: 'R002',
    entries: [
      { seat: 0, playerId: players[0].playerId, rawScore: 50000, chips: 0 },
      { seat: 1, playerId: players[1].playerId, rawScore: 35000, chips: 0 },
      { seat: 2, playerId: players[2].playerId, rawScore: 20000, chips: 0 }
    ]
  });

  assert.deepEqual(saved.warnings, []);
  assert.equal(saved.results.length, 3);
  assert.equal(saved.results.reduce((sum, r) => sum + r.totalPt, 0), 0);
  assert.equal(app.call('apiGetDaySummary', '2026-08-24').games[0].playerCount, 3);
});

test('a wrong score total is reported as a warning but still saves', () => {
  const { app, players } = freshApp();
  const saved = app.call('apiSubmitGame', gamePayload(players, [45200, 28700, 17800, 8000]));

  assert.equal(saved.warnings.length, 1);
  assert.match(saved.warnings[0], /素点の合計/);
  assert.equal(app.call('apiGetDaySummary', '2026-08-24').gameCount, 1);
});

test('scores that are not multiples of 100 are rejected', () => {
  const { app, players } = freshApp();
  assert.throws(
    () => app.call('apiSubmitGame', gamePayload(players, [45250, 28650, 17800, 8300])),
    /100点単位/
  );
});

test('the same player twice in one game is rejected', () => {
  const { app, players } = freshApp();
  const payload = gamePayload(players, [45200, 28700, 17800, 8300]);
  payload.entries[1].playerId = payload.entries[0].playerId;
  assert.throws(() => app.call('apiSubmitGame', payload), /same player/);
});

test('an unknown rule id is rejected', () => {
  const { app, players } = freshApp();
  assert.throws(
    () => app.call('apiSubmitGame', gamePayload(players, [45200, 28700, 17800, 8300], { ruleId: 'R999' })),
    /ルールが見つかりません/
  );
});

test('previewing does not write anything', () => {
  const { app, players } = freshApp();
  const preview = app.call('apiPreviewGame', gamePayload(players, [45200, 28700, 17800, 8300]));

  assert.equal(preview.results[0].rank, 1);
  assert.equal(app.call('apiGetHistory', {}).total, 0);
});

test('updating a game replaces its rows instead of adding new ones', () => {
  const { app, players } = freshApp();
  const saved = app.call('apiSubmitGame', gamePayload(players, [45200, 28700, 17800, 8300]));

  const updated = app.call('apiUpdateGame', saved.gameId,
    gamePayload(players, [8300, 17800, 28700, 45200], { note: '訂正' }));

  assert.equal(updated.gameId, saved.gameId);
  const day = app.call('apiGetDaySummary', '2026-08-24');
  assert.equal(day.gameCount, 1);
  assert.equal(day.games[0].results.length, 4);
  assert.equal(day.games[0].note, '訂正');
  assert.equal(day.games[0].results[0].playerId, players[3].playerId);
});

test('editing a game to another date moves it in the history', () => {
  const { app, players } = freshApp();
  const saved = app.call('apiSubmitGame', gamePayload(players, [45200, 28700, 17800, 8300]));
  app.call('apiUpdateGame', saved.gameId,
    gamePayload(players, [45200, 28700, 17800, 8300], { gameDate: '2026-08-20' }));

  assert.equal(app.call('apiGetDaySummary', '2026-08-24').gameCount, 0);
  const moved = app.call('apiGetDaySummary', '2026-08-20');
  assert.equal(moved.gameCount, 1);
  assert.equal(moved.games[0].results.length, 4);
});

test('deleting a game hides it from every view but keeps the rows', () => {
  const { app, players } = freshApp();
  const saved = app.call('apiSubmitGame', gamePayload(players, [45200, 28700, 17800, 8300]));
  app.call('apiDeleteGame', saved.gameId);

  assert.equal(app.call('apiGetDaySummary', '2026-08-24').gameCount, 0);
  assert.equal(app.call('apiGetHistory', {}).total, 0);
  assert.equal(app.call('apiGetStats', {}).players.length, 0);

  // Still retrievable by id, so a mistaken deletion is recoverable.
  const game = app.call('apiGetGame', saved.gameId);
  assert.equal(game.deleted, true);
  assert.equal(game.results.length, 4);
});

test('deleting an unknown game reports it', () => {
  const { app } = freshApp();
  assert.throws(() => app.call('apiDeleteGame', 'G20260101-001'), /対局が見つかりません/);
});

test('history filters by period and returns newest first', () => {
  const { app, players } = freshApp();
  ['2026-08-20', '2026-08-22', '2026-08-24'].forEach((gameDate) => {
    app.call('apiSubmitGame', gamePayload(players, [45200, 28700, 17800, 8300], { gameDate }));
  });

  const all = app.call('apiGetHistory', {});
  assert.equal(all.total, 3);
  assert.deepEqual(all.games.map((g) => g.gameDate), ['2026-08-24', '2026-08-22', '2026-08-20']);

  const ranged = app.call('apiGetHistory', { from: '2026-08-21', to: '2026-08-23' });
  assert.equal(ranged.total, 1);
  assert.equal(ranged.games[0].gameDate, '2026-08-22');
});

test('history honours its limit while reporting the full count', () => {
  const { app, players } = freshApp();
  for (let i = 0; i < 5; i++) {
    app.call('apiSubmitGame', gamePayload(players, [45200, 28700, 17800, 8300]));
  }
  const page = app.call('apiGetHistory', { limit: 2 });
  assert.equal(page.total, 5);
  assert.equal(page.games.length, 2);
});

test('statistics cover one table size at a time', () => {
  const { app, players } = freshApp();
  const three = app.call('apiSaveRule', {
    name: 'テスト三麻', playerCount: 3, startPoints: 35000, returnPoints: 40000,
    uma: [20, 0, -20], tobiBonus: 10
  });

  app.call('apiSubmitGame', gamePayload(players, [45200, 28700, 17800, 8300]));
  app.call('apiSubmitGame', {
    gameDate: '2026-08-24',
    ruleId: three.ruleId,
    entries: players.slice(0, 3).map((player, seat) => ({
      seat, playerId: player.playerId, rawScore: [50000, 35000, 20000][seat], chips: 0
    }))
  });

  // Mixing the two would average an uma of 20/10/-10/-20 with one of 20/0/-20
  // and a placing that tops out at 3 with one that tops out at 4.
  const four = app.call('apiGetStats', {});
  assert.equal(four.playerCount, 4);
  assert.equal(four.gameCount, 1);
  assert.equal(four.players.length, 4);

  const threeHanded = app.call('apiGetStats', { playerCount: 3 });
  assert.equal(threeHanded.playerCount, 3);
  assert.equal(threeHanded.gameCount, 1);
  assert.equal(threeHanded.players.length, 3);

  // Anything but 3 means four-handed, so a missing or odd value cannot quietly
  // produce a mixed aggregate.
  assert.equal(app.call('apiGetStats', { playerCount: 0 }).playerCount, 4);
  assert.equal(app.call('apiGetStats', { playerCount: 5 }).playerCount, 4);
});

test('a recent-games count replaces the date range', () => {
  const { app, players } = freshApp();
  const scores = [45200, 28700, 17800, 8300];
  for (let n = 0; n < 5; n += 1) {
    const payload = gamePayload(players, scores);
    payload.gameDate = `2026-08-${20 + n}`;
    app.call('apiSubmitGame', payload);
  }

  assert.equal(app.call('apiGetStats', {}).gameCount, 5);

  // The newest two, whatever their dates.
  const recent = app.call('apiGetStats', { recent: 2 });
  assert.equal(recent.recent, 2);
  assert.equal(recent.gameCount, 2);

  // Dates are ignored while a count is in force, rather than combining into an
  // intersection nobody asked for.
  const both = app.call('apiGetStats', { recent: 2, from: '2026-08-20', to: '2026-08-20' });
  assert.equal(both.gameCount, 2);

  // Asking for more than there are is not an error.
  assert.equal(app.call('apiGetStats', { recent: 99 }).gameCount, 5);
  assert.equal(app.call('apiGetStats', { recent: 0 }).recent, 0);
});

test('statistics stay zero-sum and expose a cumulative series', () => {
  const { app } = freshApp();
  const inserted = seedSampleData(app, { today: new Date('2026-08-24T12:00:00Z') });
  assert.equal(inserted, 6);

  const stats = app.call('apiGetStats', { withSeries: true });
  assert.equal(stats.gameCount, 6);
  assert.equal(stats.players.length, 4);
  // Math.abs, because a float sum that lands on zero can land on -0, and
  // strict equality separates the two for no reason that matters here.
  assert.ok(Math.abs(stats.players.reduce((sum, p) => sum + p.totalPt, 0)) < 0.005);
  assert.equal(stats.seriesLabels.length, 6);
  assert.deepEqual(Object.keys(stats.series).sort(), ['avgPt', 'avgRank', 'totalPt']);
  Object.values(stats.series).forEach((metric) =>
    Object.values(metric).forEach((line) => assert.equal(line.length, 6)));

  // Each series is ordered oldest first, so its last value is where the player
  // ended up -- which is what the table shows.
  stats.players.forEach((player) => {
    const last = (metric) => {
      const line = stats.series[metric][player.playerId];
      return line[line.length - 1];
    };
    assert.equal(last('totalPt'), player.totalPt);
    assert.equal(last('avgPt'), player.avgPt);
    assert.equal(last('avgRank'), player.avgRank);
  });
});

test('chip imbalance is warned about', () => {
  const { app, players } = freshApp();
  const payload = gamePayload(players, [45200, 28700, 17800, 8300]);
  payload.entries[0].chips = 2;
  const saved = app.call('apiSubmitGame', payload);

  assert.equal(saved.warnings.length, 1);
  assert.match(saved.warnings[0], /チップの合計/);
});

test('index.html resolves its includes and leaves no template tags', () => {
  const html = renderIndexHtml();
  assert.ok(html.includes('<style>'), 'css.html should be inlined');
  assert.ok(html.includes('google.script.run'), 'js.html should be inlined');
  assert.ok(!html.includes('<?'), 'no unresolved template tag should remain');
});

test('both headings come from APP_TITLE', () => {
  // The title used to be typed out in three places, so changing it meant finding
  // all of them. Config.js is now the only copy; this keeps it that way.
  const { APP_TITLE } = loadPureFunctions(['Config.js'], ['APP_TITLE']);
  const headings = renderIndexHtml().match(/<h1>([^<]*)<\/h1>/g) || [];
  assert.equal(headings.length, 2);
  headings.forEach((heading) => assert.equal(heading, `<h1>${APP_TITLE}</h1>`));
});

test('every function the UI calls exists on the server', () => {
  const { app } = freshApp();
  const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'js.html'), 'utf8');
  const called = new Set();
  const pattern = /call\(\s*'(\w+)'/g;
  let match;
  while ((match = pattern.exec(js)) !== null) called.add(match[1]);

  assert.ok(called.size >= 8, `expected several API calls, found ${called.size}`);
  for (const name of called) {
    assert.ok(app.apiNames.includes(name), `js.html calls missing server function: ${name}`);
  }
});

// --------------------------------------------------------------- rule presets

test('rules can be created with an independent player count, oka and uma', () => {
  const { app } = freshApp();
  const saved = app.call('apiSaveRule', {
    name: '三麻 ウマ10-30 オカなし',
    playerCount: 3,
    startPoints: 35000,
    returnPoints: 35000,
    uma: [30, 0, -30],
    tobiBonus: 0
  });

  assert.equal(saved.ruleId, 'R003');
  assert.equal(saved.active, true);
  assert.deepEqual(saved.uma, [30, 0, -30]);

  const listed = app.call('apiListRules', true).find((r) => r.ruleId === 'R003');
  assert.equal(listed.returnPoints, 35000);
  assert.equal(listed.tobiBonus, 0);
});

test('a rule with no oka still scores to zero', () => {
  const { app, players } = freshApp();
  const rule = app.call('apiSaveRule', {
    name: 'オカなし四麻',
    playerCount: 4,
    startPoints: 25000,
    returnPoints: 25000,
    uma: [20, 10, -10, -20],
    tobiBonus: 0
  });

  const saved = app.call('apiSubmitGame',
    gamePayload(players, [45200, 28700, 17800, 8300], { ruleId: rule.ruleId }));

  assert.equal(saved.results[0].okaPt, 0);
  assert.equal(saved.results[0].totalPt, 20.2 + 20);
  assert.equal(saved.results.reduce((sum, r) => sum + r.totalPt, 0), 0);
});

test('rule validation rejects the mistakes that break scoring', () => {
  const { app } = freshApp();
  const base = {
    name: 'テスト', playerCount: 4, startPoints: 25000, returnPoints: 30000,
    uma: [20, 10, -10, -20], tobiBonus: 10
  };
  const reject = (overrides, pattern) =>
    assert.throws(() => app.call('apiSaveRule', { ...base, ...overrides }), pattern);

  reject({ name: '  ' }, /ルール名を入力/);
  reject({ playerCount: 5 }, /人数は3人または4人/);
  reject({ uma: [20, 10, -10] }, /ウマは4人分/);
  reject({ uma: [30, 10, -10, -20] }, /ウマの合計を0/);
  reject({ returnPoints: 20000 }, /返し点は配給原点以上/);
  reject({ startPoints: 25050 }, /100点単位/);
  reject({ tobiBonus: -5 }, /飛び賞は0以上/);
  reject({ ruleId: 'R999' }, /ルールが見つかりません/);
});

test('editing a rule updates it in place', () => {
  const { app } = freshApp();
  const before = app.call('apiListRules', true).length;
  const updated = app.call('apiSaveRule', {
    ruleId: 'R001',
    name: '四麻 ウマ20-30',
    playerCount: 4,
    startPoints: 25000,
    returnPoints: 30000,
    uma: [30, 20, -20, -30],
    tobiBonus: 5
  });

  assert.equal(updated.ruleId, 'R001');
  assert.deepEqual(updated.uma, [30, 20, -20, -30]);
  assert.equal(app.call('apiListRules', true).length, before);
});

test('deactivating a rule hides it from the entry form but keeps it listed', () => {
  const { app } = freshApp();
  app.call('apiSetRuleActive', 'R002', false);

  assert.deepEqual(app.call('apiBootstrap').rules.map((r) => r.ruleId), ['R001']);
  assert.equal(app.call('apiListRules', true).length, 2);
  assert.equal(app.call('apiListRules', true).find((r) => r.ruleId === 'R002').active, false);

  app.call('apiSetRuleActive', 'R002', true);
  assert.equal(app.call('apiBootstrap').rules.length, 2);
});

test('the last active rule cannot be deactivated', () => {
  const { app } = freshApp();
  app.call('apiSetRuleActive', 'R002', false);
  assert.throws(() => app.call('apiSetRuleActive', 'R001', false), /1つもなくなる/);
});

test('editing a preset does not rescore games already recorded', () => {
  const { app, players } = freshApp();
  const saved = app.call('apiSubmitGame', gamePayload(players, [45200, 28700, 17800, 8300]));
  const before = app.call('apiGetDaySummary', '2026-08-24').games[0].results
    .map((row) => row.totalPt);

  app.call('apiSaveRule', {
    ruleId: 'R001',
    name: '四麻 ウマ20-30',
    playerCount: 4,
    startPoints: 25000,
    returnPoints: 30000,
    uma: [30, 20, -20, -30],
    tobiBonus: 10
  });

  const after = app.call('apiGetDaySummary', '2026-08-24').games[0].results
    .map((row) => row.totalPt);
  assert.deepEqual(after, before);

  // The game keeps its own copy of the rule it was scored with.
  const game = app.call('apiGetGame', saved.gameId);
  assert.deepEqual(game.rule.uma, [20, 10, -10, -20]);
  assert.equal(game.ruleName, '四麻 25000/30000 ウマ10-20 トビ10');
});

test('resubmitting an edited game with its own rule keeps the original scoring', () => {
  const { app, players } = freshApp();
  const saved = app.call('apiSubmitGame', gamePayload(players, [45200, 28700, 17800, 8300]));
  app.call('apiSaveRule', {
    ruleId: 'R001',
    name: '四麻 ウマ20-30',
    playerCount: 4,
    startPoints: 25000,
    returnPoints: 30000,
    uma: [30, 20, -20, -30],
    tobiBonus: 10
  });

  const game = app.call('apiGetGame', saved.gameId);
  const updated = app.call('apiUpdateGame', saved.gameId,
    gamePayload(players, [45200, 28700, 17800, 8300], { rule: game.rule, note: '素点だけ訂正' }));

  assert.equal(updated.results[0].umaPt, 20);
  assert.equal(updated.results[0].totalPt, 55.2);
});

test('resubmitting without a rule adopts the current preset', () => {
  const { app, players } = freshApp();
  const saved = app.call('apiSubmitGame', gamePayload(players, [45200, 28700, 17800, 8300]));
  app.call('apiSaveRule', {
    ruleId: 'R001',
    name: '四麻 ウマ20-30',
    playerCount: 4,
    startPoints: 25000,
    returnPoints: 30000,
    uma: [30, 20, -20, -30],
    tobiBonus: 10
  });

  const updated = app.call('apiUpdateGame', saved.gameId,
    gamePayload(players, [45200, 28700, 17800, 8300]));

  assert.equal(updated.results[0].umaPt, 30);
  assert.equal(app.call('apiGetGame', saved.gameId).ruleName, '四麻 ウマ20-30');
});

test('a game scored with a since-deactivated rule still reads back correctly', () => {
  const { app, players } = freshApp();
  const saved = app.call('apiSubmitGame', gamePayload(players, [45200, 28700, 17800, 8300]));
  app.call('apiSetRuleActive', 'R001', false);

  const game = app.call('apiGetGame', saved.gameId);
  assert.equal(game.rule.playerCount, 4);
  assert.deepEqual(game.rule.uma, [20, 10, -10, -20]);
  assert.equal(app.call('apiGetDaySummary', '2026-08-24').gameCount, 1);
});

// -------------------------------------------------------------- passcode gate

test('with no passcode set the app is open', () => {
  const { app } = freshApp();
  assert.deepEqual(app.call('apiAuthStatus'), { required: false });
  assert.equal(app.call('apiBootstrap').passcodeRequired, false);
  assert.deepEqual(app.call('apiVerifyPasscode', 'anything'), { ok: true, required: false });
});

test('setting a passcode closes every guarded endpoint', () => {
  const { app, players } = freshApp();
  app.call('apiSetPasscode', 'kazoku2026');

  assert.equal(app.call('apiAuthStatus').required, true);
  assert.throws(() => app.call('apiBootstrap'), /AUTH_REQUIRED/);
  assert.throws(() => app.call('apiBootstrap', 'wrong'), /AUTH_REQUIRED/);
  assert.throws(() => app.call('apiGetHistory', {}), /AUTH_REQUIRED/);
  assert.throws(() => app.call('apiGetStats', {}), /AUTH_REQUIRED/);
  assert.throws(() => app.call('apiListRules', true), /AUTH_REQUIRED/);
  assert.throws(() => app.call('apiAddPlayer', '祖父'), /AUTH_REQUIRED/);
  assert.throws(
    () => app.call('apiSubmitGame', gamePayload(players, [45200, 28700, 17800, 8300])),
    /AUTH_REQUIRED/);

  // The right passcode gets straight back in.
  assert.equal(app.call('apiBootstrap', 'kazoku2026').passcodeRequired, true);
  assert.equal(
    app.call('apiSubmitGame', gamePayload(players, [45200, 28700, 17800, 8300]), 'kazoku2026')
      .results.length,
    4);
});

test('the passcode check stays open so the login screen can use it', () => {
  const { app } = freshApp();
  app.call('apiSetPasscode', 'kazoku2026');

  assert.deepEqual(app.call('apiAuthStatus'), { required: true });
  assert.deepEqual(app.call('apiVerifyPasscode', 'kazoku2026'), { ok: true, required: true });
  assert.deepEqual(app.call('apiVerifyPasscode', 'nope'), { ok: false, required: true });
});

test('changing the passcode needs the current one', () => {
  const { app } = freshApp();
  app.call('apiSetPasscode', 'kazoku2026');

  assert.throws(() => app.call('apiSetPasscode', 'atarashii', 'wrong'), /AUTH_REQUIRED/);
  app.call('apiSetPasscode', 'atarashii', 'kazoku2026');
  assert.deepEqual(app.call('apiVerifyPasscode', 'atarashii'), { ok: true, required: true });
});

test('the gate cannot be switched off through the API', () => {
  const { app } = freshApp();
  app.call('apiSetPasscode', 'kazoku2026');

  // An empty value used to clear the passcode, which reopened anonymous writes
  // to anyone holding the URL. Turning the gate off is now an editor-only act.
  assert.throws(() => app.call('apiSetPasscode', '', 'kazoku2026'), /空にできません/);
  assert.throws(() => app.call('apiSetPasscode', '    ', 'kazoku2026'), /空にできません/);
  assert.equal(app.call('apiAuthStatus').required, true);
});

test('a too short passcode is rejected', () => {
  const { app } = freshApp();
  assert.throws(() => app.call('apiSetPasscode', 'abc'), /6文字以上/);
  assert.throws(() => app.call('apiSetPasscode', 'abcde'), /6文字以上/);
  assert.throws(() => app.call('apiSetPasscode', 'x'.repeat(61)), /60文字以内/);
  assert.equal(app.call('apiAuthStatus').required, false);
});

test('setup mints a passcode so a deployed instance is never open', () => {
  const { app } = freshApp();
  assert.equal(app.call('apiAuthStatus').required, false);

  const minted = app.call('ensurePasscode_');
  assert.equal(minted.length, 12);
  assert.equal(app.call('apiAuthStatus').required, true);
  assert.deepEqual(app.call('apiVerifyPasscode', minted), { ok: true, required: true });

  // Running it again leaves the existing passcode alone.
  assert.equal(app.call('ensurePasscode_'), '');
  assert.deepEqual(app.call('apiVerifyPasscode', minted), { ok: true, required: true });
});
