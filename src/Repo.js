/**
 * Repository layer: domain-shaped reads and writes on top of Store.js.
 *
 * Tables are small (a few thousand rows at most for a family), so every query
 * reads the whole table and filters in memory. That keeps the code simple and
 * costs one Sheets round trip regardless of the filter.
 */

/**
 * @typedef {Object} PlayerRecord
 * @property {string} playerId
 * @property {string} name
 * @property {boolean} active
 * @property {string} createdAt
 */

/**
 * @typedef {Object} GameRecord
 * @property {string} gameId
 * @property {string} gameDate
 * @property {string} playedAt
 * @property {string} ruleId
 * @property {string} ruleName
 * @property {number} playerCount
 * @property {number} startPoints
 * @property {number} returnPoints
 * @property {string} uma
 * @property {number} tobiBonus
 * @property {string} venue
 * @property {string} paifuId
 * @property {string} note
 * @property {string} recordedBy
 * @property {boolean} deleted
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * Lists players.
 * @param {boolean} [includeInactive]
 * @returns {PlayerRecord[]}
 */
function repoListPlayers(includeInactive) {
  var players = /** @type {PlayerRecord[]} */ (storeReadTable('Players'));
  return includeInactive ? players : players.filter(function (p) { return p.active; });
}

/**
 * Adds a player, reusing the existing record when the name is already taken.
 * @param {string} name
 * @returns {PlayerRecord}
 */
function repoAddPlayer(name) {
  var trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('名前を入力してください。');
  if (trimmed.length > 20) throw new Error('名前は20文字以内で入力してください。');

  var players = repoListPlayers(true);
  var existing = players.filter(function (p) { return p.name === trimmed; })[0];
  if (existing) {
    if (!existing.active) {
      existing.active = true;
      /** @type {Record<string, any>} */
      var revive = {};
      revive[existing.playerId] = existing;
      storeUpdateRowsByKey('Players', 'playerId', revive);
    }
    return existing;
  }

  var maxNumber = players.reduce(function (max, p) {
    var n = parseInt(String(p.playerId).replace(/^P/, ''), 10);
    return isNaN(n) ? max : Math.max(max, n);
  }, 0);
  var record = {
    playerId: 'P' + ('00' + (maxNumber + 1)).slice(-3),
    name: trimmed,
    active: true,
    createdAt: nowIso()
  };
  storeAppendRows('Players', [record]);
  return record;
}

/**
 * Lists rule presets, parsing the comma separated uma column into an array.
 * @param {boolean} [includeInactive]
 * @returns {(RuleConfig & {active: boolean})[]}
 */
function repoListRules(includeInactive) {
  var rows = storeReadTable('Rules');
  return rows
    .filter(function (row) { return includeInactive || normalizeBoolean(row.active); })
    .map(function (row) {
      return {
        ruleId: row.ruleId,
        name: row.name,
        playerCount: row.playerCount,
        startPoints: row.startPoints,
        returnPoints: row.returnPoints,
        uma: parseUma(row.uma),
        tobiBonus: row.tobiBonus,
        active: normalizeBoolean(row.active)
      };
    });
}

/**
 * Returns one rule preset, including deactivated ones.
 * @param {string} ruleId
 * @returns {RuleConfig & {active: boolean}}
 */
function repoGetRule(ruleId) {
  var rule = repoListRules(true).filter(function (r) { return r.ruleId === ruleId; })[0];
  if (!rule) throw new Error('ルールが見つかりません: ' + ruleId);
  return rule;
}

/**
 * Creates or updates a rule preset.
 *
 * The caller is responsible for validating the rule first; this only persists it.
 *
 * @param {RuleConfig & {active?: boolean}} rule Without ruleId a new preset is created.
 * @returns {RuleConfig & {active: boolean}}
 */
function repoSaveRule(rule) {
  var existing = repoListRules(true);
  var ruleId = String(rule.ruleId || '').trim();

  if (ruleId && !existing.some(function (r) { return r.ruleId === ruleId; })) {
    throw new Error('ルールが見つかりません: ' + ruleId);
  }
  if (!ruleId) {
    var maxNumber = existing.reduce(function (max, r) {
      var n = parseInt(String(r.ruleId).replace(/^R/, ''), 10);
      return isNaN(n) ? max : Math.max(max, n);
    }, 0);
    ruleId = 'R' + ('00' + (maxNumber + 1)).slice(-3);
  }

  var record = {
    ruleId: ruleId,
    name: rule.name,
    playerCount: rule.playerCount,
    startPoints: rule.startPoints,
    returnPoints: rule.returnPoints,
    uma: formatUma(rule.uma),
    tobiBonus: rule.tobiBonus,
    active: rule.active === undefined ? true : !!rule.active
  };

  if (existing.some(function (r) { return r.ruleId === ruleId; })) {
    /** @type {Record<string, any>} */
    var update = {};
    update[ruleId] = record;
    storeUpdateRowsByKey('Rules', 'ruleId', update);
  } else {
    storeAppendRows('Rules', [record]);
  }
  return repoGetRule(ruleId);
}

/**
 * Shows or hides a preset in the entry form. Presets are never deleted, so games
 * that reference one keep a resolvable rule name.
 *
 * @param {string} ruleId
 * @param {boolean} active
 * @returns {RuleConfig & {active: boolean}}
 */
function repoSetRuleActive(ruleId, active) {
  var rule = repoGetRule(ruleId);
  rule.active = !!active;
  return repoSaveRule(rule);
}

/**
 * Builds the next game id for a date, e.g. 'G20260824-003'.
 * @param {string} gameDate 'YYYY-MM-DD'
 * @param {GameRecord[]} existingGames
 * @returns {string}
 */
function repoNextGameId(gameDate, existingGames) {
  var prefix = 'G' + gameDate.replace(/-/g, '') + '-';
  var maxSeq = existingGames.reduce(function (max, game) {
    if (String(game.gameId).indexOf(prefix) !== 0) return max;
    var seq = parseInt(String(game.gameId).slice(prefix.length), 10);
    return isNaN(seq) ? max : Math.max(max, seq);
  }, 0);
  return prefix + ('00' + (maxSeq + 1)).slice(-3);
}

/**
 * Lists games, newest first.
 * @param {{from?: string, to?: string, playerCount?: number,
 *   includeDeleted?: boolean}} [options]
 * @returns {GameRecord[]}
 */
function repoListGames(options) {
  var opts = options || {};
  var games = /** @type {GameRecord[]} */ (storeReadTable('Games'));
  return games
    .filter(function (game) {
      if (!opts.includeDeleted && game.deleted) return false;
      if (opts.from && game.gameDate < opts.from) return false;
      if (opts.to && game.gameDate > opts.to) return false;
      if (opts.playerCount && game.playerCount !== opts.playerCount) return false;
      return true;
    })
    .sort(function (a, b) {
      if (a.gameDate !== b.gameDate) return a.gameDate < b.gameDate ? 1 : -1;
      return a.gameId < b.gameId ? 1 : -1;
    });
}

/**
 * Lists result rows.
 * @param {{from?: string, to?: string, gameIds?: string[], includeDeleted?: boolean}} [options]
 * @returns {Record<string, any>[]}
 */
function repoListResults(options) {
  var opts = options || {};
  /** @type {Record<string, boolean> | null} */
  var wanted = null;
  if (opts.gameIds) {
    wanted = {};
    opts.gameIds.forEach(function (id) { /** @type {Record<string, boolean>} */ (wanted)[id] = true; });
  }
  return storeReadTable('Results').filter(function (row) {
    if (!opts.includeDeleted && row.deleted) return false;
    if (wanted && !wanted[row.gameId]) return false;
    if (opts.from && row.gameDate < opts.from) return false;
    if (opts.to && row.gameDate > opts.to) return false;
    return true;
  });
}

/**
 * Persists a new game together with its result rows.
 * @param {GameRecord} game
 * @param {Record<string, any>[]} results
 * @returns {void}
 */
function repoInsertGame(game, results) {
  storeAppendRows('Games', [game]);
  storeAppendRows('Results', results);
}

/**
 * Replaces an existing game's metadata and result rows.
 * @param {GameRecord} game
 * @param {Record<string, any>[]} results
 * @returns {void}
 */
function repoReplaceGame(game, results) {
  /** @type {Record<string, any>} */
  var update = {};
  update[game.gameId] = game;
  if (!storeUpdateRowsByKey('Games', 'gameId', update)) {
    throw new Error('対局が見つかりません: ' + game.gameId);
  }
  storeDeleteRowsByKey('Results', 'gameId', [game.gameId]);
  storeAppendRows('Results', results);
}

/**
 * Marks a game and its results as deleted without removing any row.
 * @param {string} gameId
 * @returns {void}
 */
function repoSoftDeleteGame(gameId) {
  var game = /** @type {GameRecord[]} */ (storeReadTable('Games'))
    .filter(function (g) { return g.gameId === gameId; })[0];
  if (!game) throw new Error('対局が見つかりません: ' + gameId);
  game.deleted = true;
  game.updatedAt = nowIso();
  /** @type {Record<string, any>} */
  var gameUpdate = {};
  gameUpdate[gameId] = game;
  storeUpdateRowsByKey('Games', 'gameId', gameUpdate);

  /** @type {Record<string, any>} */
  var resultUpdates = {};
  storeReadTable('Results')
    .filter(function (row) { return row.gameId === gameId; })
    .forEach(function (row) {
      row.deleted = true;
      resultUpdates[row.resultId] = row;
    });
  storeUpdateRowsByKey('Results', 'resultId', resultUpdates);
}
