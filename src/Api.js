/**
 * Functions called from the browser through google.script.run.
 *
 * Every return value must be plain JSON-serialisable data: Date objects and
 * class instances do not survive the google.script.run boundary.
 */

/**
 * One player's input for a game, as sent by the browser.
 * @typedef {Object} EntryInput
 * @property {number} seat
 * @property {string} playerId
 * @property {number} rawScore
 * @property {number} [chips]
 */

/**
 * A game submission from the browser.
 * @typedef {Object} GameInput
 * @property {string} gameDate
 * @property {string} ruleId
 * @property {RuleConfig} [rule]
 *   An explicit rule to score with, used when editing a game so that a preset
 *   changed since it was recorded does not silently rewrite its result. When
 *   absent the current preset named by ruleId is used.
 * @property {string} [venue]
 * @property {string} [paifuId]
 * @property {string} [note]
 * @property {string} [recordedBy]
 * @property {EntryInput[]} entries
 */

/**
 * Builds a playerId to name lookup.
 * @returns {Record<string, string>}
 */
function buildPlayerNameMap_() {
  /** @type {Record<string, string>} */
  var map = {};
  repoListPlayers(true).forEach(function (player) { map[player.playerId] = player.name; });
  return map;
}

/**
 * Normalises a rule coming from the browser and rejects the mistakes that would
 * make a game unscoreable.
 *
 * Messages are in Japanese because they are shown directly in the rule editor.
 *
 * @param {Record<string, any>} input
 * @returns {RuleConfig & {active: boolean}}
 */
function parseRuleInput_(input) {
  if (!input) throw new Error('ルールの入力がありません。');

  var name = String(input.name || '').trim();
  if (!name) throw new Error('ルール名を入力してください。');
  if (name.length > 40) throw new Error('ルール名は40文字以内で入力してください。');

  var playerCount = normalizeNumber(input.playerCount);
  if (playerCount !== 3 && playerCount !== 4) {
    throw new Error('人数は3人または4人を選んでください。');
  }

  var startPoints = normalizeNumber(input.startPoints);
  var returnPoints = normalizeNumber(input.returnPoints);
  if (startPoints <= 0) throw new Error('配給原点は1以上で入力してください。');
  if (startPoints % 100 !== 0 || returnPoints % 100 !== 0) {
    throw new Error('配給原点と返し点は100点単位で入力してください。');
  }
  if (returnPoints < startPoints) {
    throw new Error('返し点は配給原点以上で入力してください（同額ならオカなしです）。');
  }

  var uma = (Array.isArray(input.uma) ? input.uma : parseUma(input.uma))
    .map(function (value) { return normalizeNumber(value); });
  if (uma.length !== playerCount) {
    throw new Error('ウマは' + playerCount + '人分を入力してください。');
  }
  var umaSum = uma.reduce(function (a, b) { return a + b; }, 0);
  if (roundPt(umaSum) !== 0) {
    throw new Error('ウマの合計を0にしてください（現在 ' + roundPt(umaSum) + '）。');
  }

  var tobiBonus = normalizeNumber(input.tobiBonus);
  if (tobiBonus < 0) throw new Error('飛び賞は0以上で入力してください。');

  return {
    ruleId: String(input.ruleId || '').trim(),
    name: name,
    playerCount: playerCount,
    startPoints: startPoints,
    returnPoints: returnPoints,
    uma: uma,
    tobiBonus: tobiBonus,
    active: input.active === undefined ? true : !!input.active
  };
}

/**
 * Picks the rule a submission should be scored with.
 *
 * An explicit `rule` wins, so editing an old game keeps the rule it was recorded
 * under even if the preset has changed in the meantime.
 *
 * The snapshot may carry its own numbers, but its ruleId still has to name a
 * real preset: a game pointing at an id that was never in the Rules sheet reads
 * as a dangling reference everywhere it is later joined.
 *
 * @param {GameInput} input
 * @returns {RuleConfig}
 */
function resolveRule_(input) {
  if (input.rule && input.rule.playerCount) {
    var snapshot = parseRuleInput_(
      Object.assign({}, input.rule, { ruleId: input.rule.ruleId || input.ruleId }));
    if (snapshot.ruleId) repoGetRule(snapshot.ruleId);
    return snapshot;
  }
  return repoGetRule(input.ruleId);
}

/**
 * Normalises and validates a submission coming from the browser.
 * @param {GameInput} input
 * @returns {{game: GameInput, rule: RuleConfig, entries: PlayerEntry[]}}
 */
function parseGameInput_(input) {
  if (!input || !input.entries) throw new Error('入力データが不正です。');
  var rule = resolveRule_(input);
  var gameDate = normalizeDateKey(input.gameDate) || todayKey();

  // Results rows are joined back to Players by id on every screen, so an id that
  // matches no player would show up as a blank name that nothing can repair.
  /** @type {Record<string, boolean>} */
  var knownPlayers = {};
  repoListPlayers(true).forEach(function (player) { knownPlayers[player.playerId] = true; });

  var entries = input.entries.map(function (entry) {
    if (!entry.playerId) throw new Error('プレイヤーが選択されていない席があります。');
    var playerId = String(entry.playerId);
    if (!knownPlayers[playerId]) throw new Error('プレイヤーが見つかりません: ' + playerId);
    var rawScore = normalizeNumber(entry.rawScore);
    if (rawScore % 100 !== 0) throw new Error('素点は100点単位で入力してください: ' + rawScore);
    return {
      seat: normalizeNumber(entry.seat),
      playerId: playerId,
      rawScore: rawScore,
      chips: normalizeNumber(entry.chips)
    };
  });

  return {
    game: {
      gameDate: gameDate,
      ruleId: rule.ruleId,
      venue: String(input.venue || ''),
      paifuId: String(input.paifuId || '').trim(),
      note: String(input.note || ''),
      recordedBy: String(input.recordedBy || ''),
      entries: input.entries
    },
    rule: rule,
    entries: entries
  };
}

/**
 * The rule columns stored on a game.
 *
 * Presets can be edited at any time, so each game keeps its own copy of the rule
 * it was scored with. Without this, changing the uma would retroactively change
 * what every past game meant.
 *
 * @param {RuleConfig} rule
 * @returns {Record<string, any>}
 */
function ruleSnapshot_(rule) {
  return {
    ruleId: rule.ruleId || '',
    ruleName: rule.name || '',
    playerCount: rule.playerCount,
    startPoints: rule.startPoints,
    returnPoints: rule.returnPoints,
    uma: formatUma(rule.uma),
    tobiBonus: rule.tobiBonus
  };
}

/**
 * Rebuilds the rule a game was scored with from its stored columns.
 * @param {GameRecord} game
 * @returns {RuleConfig}
 */
function ruleFromGame_(game) {
  return {
    ruleId: game.ruleId,
    name: game.ruleName || game.ruleId,
    playerCount: game.playerCount,
    startPoints: game.startPoints,
    returnPoints: game.returnPoints,
    uma: parseUma(game.uma),
    tobiBonus: game.tobiBonus
  };
}

/**
 * Turns computed results into Results sheet rows.
 * @param {string} gameId
 * @param {string} gameDate
 * @param {ComputedResult[]} computed
 * @returns {Record<string, any>[]}
 */
function buildResultRows_(gameId, gameDate, computed) {
  return computed.map(function (result) {
    return {
      resultId: gameId + '-' + result.seat,
      gameId: gameId,
      gameDate: gameDate,
      seat: result.seat,
      playerId: result.playerId,
      rawScore: result.rawScore,
      rank: result.rank,
      scorePt: result.scorePt,
      umaPt: result.umaPt,
      okaPt: result.okaPt,
      tobiPt: result.tobiPt,
      totalPt: result.totalPt,
      chips: result.chips,
      tobi: result.tobi,
      deleted: false
    };
  });
}

/**
 * Joins games with their results and player names for display.
 * @param {GameRecord[]} games
 * @param {Record<string, any>[]} results
 * @param {Record<string, string>} nameMap
 * @returns {Record<string, any>[]}
 */
function joinGames_(games, results, nameMap) {
  /** @type {Record<string, any[]>} */
  var byGame = {};
  results.forEach(function (row) {
    if (!byGame[row.gameId]) byGame[row.gameId] = [];
    byGame[row.gameId].push(Object.assign({}, row, { name: nameMap[row.playerId] || row.playerId }));
  });
  return games.map(function (game) {
    var rows = (byGame[game.gameId] || []).slice().sort(function (a, b) { return a.rank - b.rank; });
    return Object.assign({}, game, { results: rows });
  });
}

/**
 * Attaches display names to aggregated stats.
 * @param {PlayerStats[]} stats
 * @param {Record<string, string>} nameMap
 * @returns {Record<string, any>[]}
 */
function withNames_(stats, nameMap) {
  return stats.map(function (row) {
    return Object.assign({}, row, { name: nameMap[row.playerId] || row.playerId });
  });
}

/**
 * Returns everything the UI needs on startup.
 * @returns {Record<string, any>}
 * @param {string} [passcode] パスワード。設定されている場合のみ必要。
 */
function apiBootstrap(passcode) {
  requirePasscode_(passcode);
  var today = todayKey();
  return {
    today: today,
    players: repoListPlayers(false),
    rules: repoListRules(false),
    daySummary: apiGetDaySummary(today, passcode),
    passcodeRequired: apiAuthStatus().required
  };
}

/**
 * Adds a player.
 * @param {string} name
 * @returns {PlayerRecord}
 * @param {string} [passcode] パスワード。設定されている場合のみ必要。
 */
function apiAddPlayer(name, passcode) {
  requirePasscode_(passcode);
  return withLock(function () { return repoAddPlayer(name); });
}

/**
 * Computes ranks and balances without saving, for the confirmation screen.
 * @param {GameInput} input
 * @returns {{results: ComputedResult[], warnings: string[]}}
 * @param {string} [passcode] パスワード。設定されている場合のみ必要。
 */
function apiPreviewGame(input, passcode) {
  requirePasscode_(passcode);
  var parsed = parseGameInput_(input);
  return {
    results: computeGameResults(parsed.entries, parsed.rule),
    warnings: validateGameEntries(parsed.entries, parsed.rule)
  };
}

/**
 * Saves one game.
 * @param {GameInput} input
 * @returns {{gameId: string, results: ComputedResult[], warnings: string[]}}
 * @param {string} [passcode] パスワード。設定されている場合のみ必要。
 */
function apiSubmitGame(input, passcode) {
  requirePasscode_(passcode);
  var parsed = parseGameInput_(input);
  var computed = computeGameResults(parsed.entries, parsed.rule);
  var warnings = validateGameEntries(parsed.entries, parsed.rule);

  return withLock(function () {
    var gameId = repoNextGameId(parsed.game.gameDate, repoListGames({ includeDeleted: true }));
    var timestamp = nowIso();
    var game = /** @type {GameRecord} */ (Object.assign({
      gameId: gameId,
      gameDate: parsed.game.gameDate,
      playedAt: timestamp,
      venue: parsed.game.venue || '',
      paifuId: parsed.game.paifuId || '',
      note: parsed.game.note || '',
      recordedBy: parsed.game.recordedBy || '',
      deleted: false,
      createdAt: timestamp,
      updatedAt: timestamp
    }, ruleSnapshot_(parsed.rule)));
    repoInsertGame(game, buildResultRows_(gameId, game.gameDate, computed));
    return { gameId: gameId, results: computed, warnings: warnings };
  });
}

/**
 * Rewrites an existing game.
 * @param {string} gameId
 * @param {GameInput} input
 * @returns {{gameId: string, results: ComputedResult[], warnings: string[]}}
 * @param {string} [passcode] パスワード。設定されている場合のみ必要。
 */
function apiUpdateGame(gameId, input, passcode) {
  requirePasscode_(passcode);
  var parsed = parseGameInput_(input);
  var computed = computeGameResults(parsed.entries, parsed.rule);
  var warnings = validateGameEntries(parsed.entries, parsed.rule);

  return withLock(function () {
    var existing = repoListGames({ includeDeleted: true }).filter(function (g) {
      return g.gameId === gameId;
    })[0];
    if (!existing) throw new Error('対局が見つかりません: ' + gameId);

    var game = Object.assign({}, existing, {
      gameDate: parsed.game.gameDate,
      venue: parsed.game.venue || '',
      paifuId: parsed.game.paifuId || '',
      note: parsed.game.note || '',
      recordedBy: parsed.game.recordedBy || '',
      updatedAt: nowIso()
    }, ruleSnapshot_(parsed.rule));
    repoReplaceGame(game, buildResultRows_(gameId, game.gameDate, computed));
    return { gameId: gameId, results: computed, warnings: warnings };
  });
}

/**
 * Marks a game as deleted. The rows stay in the sheet so a mistake is recoverable.
 * @param {string} gameId
 * @returns {{gameId: string}}
 * @param {string} [passcode] パスワード。設定されている場合のみ必要。
 */
function apiDeleteGame(gameId, passcode) {
  requirePasscode_(passcode);
  return withLock(function () {
    repoSoftDeleteGame(gameId);
    return { gameId: gameId };
  });
}

/**
 * Returns one day's games plus a per-player summary of that day.
 * @param {string} dateKey 'YYYY-MM-DD'
 * @returns {Record<string, any>}
 * @param {string} [passcode] パスワード。設定されている場合のみ必要。
 */
function apiGetDaySummary(dateKey, passcode) {
  requirePasscode_(passcode);
  var date = normalizeDateKey(dateKey) || todayKey();
  var games = repoListGames({ from: date, to: date });
  var results = repoListResults({ gameIds: games.map(function (g) { return g.gameId; }) });
  var nameMap = buildPlayerNameMap_();

  /** @type {Record<string, number>} */
  var playerCountByGame = {};
  games.forEach(function (game) { playerCountByGame[game.gameId] = game.playerCount; });

  return {
    date: date,
    gameCount: games.length,
    players: withNames_(aggregatePlayerStats(results, playerCountByGame), nameMap),
    games: joinGames_(games, results, nameMap)
  };
}

/**
 * Returns games in a period, newest first.
 * @param {{from?: string, to?: string, limit?: number}} [options]
 * @returns {Record<string, any>}
 * @param {string} [passcode] パスワード。設定されている場合のみ必要。
 */
function apiGetHistory(options, passcode) {
  requirePasscode_(passcode);
  var opts = options || {};
  var games = repoListGames({
    from: normalizeDateKey(opts.from || '') || undefined,
    to: normalizeDateKey(opts.to || '') || undefined
  });
  var limit = opts.limit && opts.limit > 0 ? opts.limit : 100;
  var page = games.slice(0, limit);
  var results = repoListResults({ gameIds: page.map(function (g) { return g.gameId; }) });

  return {
    total: games.length,
    games: joinGames_(page, results, buildPlayerNameMap_())
  };
}

/**
 * Returns aggregated statistics for a period.
 * @param {{from?: string, to?: string, withSeries?: boolean}} [options]
 * @returns {Record<string, any>}
 * @param {string} [passcode] パスワード。設定されている場合のみ必要。
 */
function apiGetStats(options, passcode) {
  requirePasscode_(passcode);
  var opts = options || {};
  var from = normalizeDateKey(opts.from || '') || undefined;
  var to = normalizeDateKey(opts.to || '') || undefined;
  var games = repoListGames({ from: from, to: to });
  var results = repoListResults({ gameIds: games.map(function (g) { return g.gameId; }) });
  var nameMap = buildPlayerNameMap_();

  /** @type {Record<string, number>} */
  var playerCountByGame = {};
  games.forEach(function (game) { playerCountByGame[game.gameId] = game.playerCount; });

  /** @type {Record<string, any>} */
  var response = {
    from: from || '',
    to: to || '',
    gameCount: games.length,
    players: withNames_(aggregatePlayerStats(results, playerCountByGame), nameMap)
  };
  if (opts.withSeries) {
    var ordered = games.slice().reverse().map(function (game) { return game.gameId; });
    response.series = buildSeries(results, ordered);
    response.seriesLabels = ordered;
  }
  return response;
}

/**
 * Returns one game in the shape the edit form expects.
 * @param {string} gameId
 * @param {string} [passcode] パスワード。設定されている場合のみ必要。
 * @returns {Record<string, any>}
 */
function apiGetGame(gameId, passcode) {
  requirePasscode_(passcode);
  var game = repoListGames({ includeDeleted: true }).filter(function (g) {
    return g.gameId === gameId;
  })[0];
  if (!game) throw new Error('対局が見つかりません: ' + gameId);
  var results = repoListResults({ gameIds: [gameId], includeDeleted: true })
    .sort(function (a, b) { return a.seat - b.seat; });
  // The rule travels with the game so the edit form can resubmit it unchanged.
  return Object.assign({}, game, { results: results, rule: ruleFromGame_(game) });
}

/**
 * Lists rule presets for the rule editor.
 * @param {boolean} [includeInactive]
 * @returns {(RuleConfig & {active: boolean})[]}
 * @param {string} [passcode] パスワード。設定されている場合のみ必要。
 */
function apiListRules(includeInactive, passcode) {
  requirePasscode_(passcode);
  return repoListRules(!!includeInactive);
}

/**
 * Creates or updates a rule preset.
 *
 * Past games are unaffected: each one stores the rule it was scored with.
 *
 * @param {Record<string, any>} input Without ruleId a new preset is created.
 * @returns {RuleConfig & {active: boolean}}
 * @param {string} [passcode] パスワード。設定されている場合のみ必要。
 */
function apiSaveRule(input, passcode) {
  requirePasscode_(passcode);
  var rule = parseRuleInput_(input);
  return withLock(function () { return repoSaveRule(rule); });
}

/**
 * Shows or hides a preset in the entry form. Presets are never deleted, because
 * games reference them by id.
 *
 * @param {string} ruleId
 * @param {boolean} active
 * @returns {RuleConfig & {active: boolean}}
 * @param {string} [passcode] パスワード。設定されている場合のみ必要。
 */
function apiSetRuleActive(ruleId, active, passcode) {
  requirePasscode_(passcode);
  return withLock(function () {
    if (!active) {
      var remaining = repoListRules(false).filter(function (rule) {
        return rule.ruleId !== ruleId;
      });
      if (!remaining.length) {
        throw new Error('使用中のルールが1つもなくなるため、これは無効にできません。');
      }
    }
    return repoSetRuleActive(ruleId, active);
  });
}
