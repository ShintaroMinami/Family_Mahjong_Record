/**
 * Pure scoring logic for a single game (hanchan).
 *
 * This file must stay free of any SpreadsheetApp / GAS dependency so that it can
 * be unit-tested with plain Node.js (see tests/domain.test.js).
 */

/**
 * A rule preset.
 * @typedef {Object} RuleConfig
 * @property {string} ruleId
 * @property {string} name
 * @property {number} playerCount   Number of players: 3 or 4.
 * @property {number} startPoints   Points each player starts with (e.g. 25000).
 * @property {number} returnPoints  Points used as the zero line (e.g. 30000).
 * @property {number[]} uma         Rank points by rank, e.g. [20, 10, -10, -20].
 * @property {number} tobiBonus     Points paid by a bankrupt player to the winner. 0 disables it.
 */

/**
 * One player's raw input for a game.
 * @typedef {Object} PlayerEntry
 * @property {number} seat        0 = East (first dealer), 1 = South, 2 = West, 3 = North.
 * @property {string} playerId
 * @property {number} rawScore    Final score in points.
 * @property {number} [chips]     Chips exchanged. Positive means received.
 */

/**
 * One player's computed result.
 * @typedef {PlayerEntry & {
 *   rank: number, scorePt: number, umaPt: number, okaPt: number,
 *   tobiPt: number, totalPt: number, chips: number, tobi: boolean
 * }} ComputedResult
 */

/** Decimal places kept for point values. Avoids float noise such as 0.30000000000000004. */
var PT_PRECISION = 2;

/**
 * Rounds a point value to PT_PRECISION, killing binary floating point noise.
 * @param {number} value
 * @returns {number}
 */
function roundPt(value) {
  var factor = Math.pow(10, PT_PRECISION);
  return Math.round(value * factor) / factor;
}

/**
 * Validates a rule preset and throws when it cannot produce a zero-sum game.
 * @param {RuleConfig} rule
 * @returns {void}
 */
function validateRule(rule) {
  if (rule.playerCount !== 3 && rule.playerCount !== 4) {
    throw new Error('playerCount must be 3 or 4: ' + rule.playerCount);
  }
  if (rule.uma.length !== rule.playerCount) {
    throw new Error('uma must have ' + rule.playerCount + ' entries, got ' + rule.uma.length);
  }
  var umaSum = rule.uma.reduce(function (a, b) { return a + b; }, 0);
  if (roundPt(umaSum) !== 0) {
    throw new Error('uma must sum to 0, got ' + umaSum);
  }
  if (rule.returnPoints < rule.startPoints) {
    throw new Error('returnPoints must be >= startPoints');
  }
}

/**
 * Sorts entries into finishing order.
 *
 * Ties are broken by seat: the player closer to the first dealer (smaller seat
 * number) takes the higher rank, which is the standard Japanese rule.
 *
 * @param {PlayerEntry[]} entries
 * @returns {PlayerEntry[]} A new array, best first.
 */
function rankEntries(entries) {
  return entries.slice().sort(function (a, b) {
    if (b.rawScore !== a.rawScore) return b.rawScore - a.rawScore;
    return a.seat - b.seat;
  });
}

/**
 * Computes ranks and point balances for one game.
 *
 * The result always satisfies `sum(totalPt) === 0`; raw scores are deliberately
 * not rounded to 1000-point units because that would break the zero sum.
 *
 * @param {PlayerEntry[]} entries One entry per player.
 * @param {RuleConfig} rule
 * @returns {ComputedResult[]} Results in finishing order (rank 1 first).
 */
function computeGameResults(entries, rule) {
  validateRule(rule);
  if (entries.length !== rule.playerCount) {
    throw new Error('expected ' + rule.playerCount + ' entries, got ' + entries.length);
  }
  var seats = entries.map(function (e) { return e.seat; });
  if (new Set(seats).size !== entries.length) {
    throw new Error('seat numbers must be unique');
  }
  var playerIds = entries.map(function (e) { return e.playerId; });
  if (new Set(playerIds).size !== entries.length) {
    throw new Error('the same player cannot appear twice in one game');
  }
  entries.forEach(function (e) {
    if (!isFinite(e.rawScore)) throw new Error('rawScore must be a number: ' + e.rawScore);
  });

  var ordered = rankEntries(entries);
  var oka = (rule.returnPoints - rule.startPoints) * rule.playerCount / 1000;
  var tobiCount = ordered.filter(function (e) { return e.rawScore < 0; }).length;

  return ordered.map(function (entry, index) {
    var rank = index + 1;
    var isTobi = entry.rawScore < 0;
    var tobiPt = 0;
    if (rule.tobiBonus > 0) {
      if (isTobi) tobiPt -= rule.tobiBonus;
      if (rank === 1) tobiPt += rule.tobiBonus * tobiCount;
    }
    var scorePt = roundPt((entry.rawScore - rule.returnPoints) / 1000);
    var umaPt = rule.uma[index];
    var okaPt = rank === 1 ? oka : 0;
    return {
      seat: entry.seat,
      playerId: entry.playerId,
      rawScore: entry.rawScore,
      rank: rank,
      scorePt: scorePt,
      umaPt: umaPt,
      okaPt: okaPt,
      tobiPt: tobiPt,
      totalPt: roundPt(scorePt + umaPt + okaPt + tobiPt),
      chips: entry.chips || 0,
      tobi: isTobi
    };
  });
}

/**
 * Checks a game for the mistakes that actually happen when typing scores in.
 *
 * These are warnings, not errors: the caller may still save the game, because
 * a house rule or a manual chip adjustment can legitimately break the sums.
 *
 * @param {PlayerEntry[]} entries
 * @param {RuleConfig} rule
 * @returns {string[]} Human readable warnings in Japanese. Empty when all is well.
 */
function validateGameEntries(entries, rule) {
  var warnings = [];
  var expected = rule.startPoints * rule.playerCount;
  var actual = entries.reduce(function (sum, e) { return sum + e.rawScore; }, 0);
  if (actual !== expected) {
    warnings.push('素点の合計が ' + actual.toLocaleString() + ' 点です（' +
      expected.toLocaleString() + ' 点であるべきで、差は ' +
      (actual - expected).toLocaleString() + ' 点）');
  }
  var chipSum = entries.reduce(function (sum, e) { return sum + (e.chips || 0); }, 0);
  if (chipSum !== 0) {
    warnings.push('チップの合計が ' + chipSum + ' 枚です（0 であるべきです）');
  }
  return warnings;
}

