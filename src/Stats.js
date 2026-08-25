/**
 * Aggregation helpers.
 *
 * These are pure functions over result rows so they can be unit tested with
 * plain Node.js (see tests/stats.test.js).
 */

/**
 * @typedef {Object} PlayerStats
 * @property {string} playerId
 * @property {number} games       Games played.
 * @property {number} totalPt     Sum of totalPt.
 * @property {number} avgPt       Mean totalPt per game.
 * @property {number} avgRank     Mean finishing rank.
 * @property {number[]} rankCounts Count per rank, index 0 is first place.
 * @property {number} avgRawScore Mean raw score.
 * @property {number} rank1Rate   Share of games finished first, 0..1.
 * @property {number} rank2Rate   Share finished second.
 * @property {number} rank3Rate   Share finished third.
 * @property {number} rank4Rate   Share finished fourth; 0 at a three-player table.
 * @property {number} tobiRate    Share of games ended below zero.
 * @property {number} tobiCount   Games ended below zero.
 * @property {number} chips       Net chips.
 */

/**
 * Rounds to a fixed number of decimals.
 * @param {number} value
 * @param {number} digits
 * @returns {number}
 */
function round(value, digits) {
  var factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

/**
 * Aggregates result rows per player.
 *
 * "Last place" means the highest rank number seen for that player in that game,
 * which is 4 in a four-player game and 3 in a three-player one; the rows carry
 * their own player count so mixed 3/4-player periods aggregate correctly.
 *
 * @param {Record<string, any>[]} results Result rows, each with playerId, rank, totalPt...
 * @returns {PlayerStats[]} Sorted by totalPt, highest first.
 */
function aggregatePlayerStats(results) {
  /** @type {Record<string, PlayerStats & {_rankSum: number, _scoreSum: number}>} */
  var byPlayer = {};

  results.forEach(function (row) {
    var stats = byPlayer[row.playerId];
    if (!stats) {
      stats = byPlayer[row.playerId] = {
        playerId: row.playerId,
        games: 0, totalPt: 0, avgPt: 0, avgRank: 0,
        rankCounts: [0, 0, 0, 0],
        avgRawScore: 0, tobiCount: 0, chips: 0,
        rank1Rate: 0, rank2Rate: 0, rank3Rate: 0, rank4Rate: 0, tobiRate: 0,
        _rankSum: 0, _scoreSum: 0
      };
    }
    stats.games += 1;
    stats.totalPt += row.totalPt;
    stats._rankSum += row.rank;
    stats._scoreSum += row.rawScore;
    stats.chips += row.chips || 0;
    if (row.tobi) stats.tobiCount += 1;
    if (row.rank >= 1 && row.rank <= 4) stats.rankCounts[row.rank - 1] += 1;
  });

  return Object.keys(byPlayer).map(function (playerId) {
    var stats = byPlayer[playerId];
    var games = stats.games;
    return {
      playerId: stats.playerId,
      games: games,
      totalPt: round(stats.totalPt, 1),
      avgPt: round(stats.totalPt / games, 2),
      avgRank: round(stats._rankSum / games, 2),
      rankCounts: stats.rankCounts,
      avgRawScore: Math.round(stats._scoreSum / games),
      // One rate per placing rather than the top/last pair those used to be:
      // with the table size fixed, "last" is just the bottom rate under another
      // name, and the middle placings were not reachable at all.
      rank1Rate: round(stats.rankCounts[0] / games, 3),
      rank2Rate: round(stats.rankCounts[1] / games, 3),
      rank3Rate: round(stats.rankCounts[2] / games, 3),
      rank4Rate: round(stats.rankCounts[3] / games, 3),
      tobiRate: round(stats.tobiCount / games, 3),
      tobiCount: stats.tobiCount,
      chips: stats.chips
    };
  }).sort(function (a, b) { return b.totalPt - a.totalPt; });
}

/** Metrics the statistics chart can plot, in the order they are offered. */
var SERIES_METRICS = ['totalPt', 'avgPt', 'avgRank'];

/**
 * Builds one line per metric per player, ordered by game.
 *
 * Used by the chart on the statistics tab. A player who sat a game out keeps
 * the value they had, so their line stays flat rather than dropping out.
 *
 * The total reads 0 before a player's first game, which is true of it: everyone
 * starts at zero. The averages read null instead -- an average rank of 0 is not
 * a thing, and plotting it would drag the axis somewhere meaningless.
 *
 * @param {Record<string, any>[]} results Result rows.
 * @param {string[]} gameIdsInOrder Game ids, oldest first.
 * @returns {Record<string, Record<string, (number|null)[]>>} Metric, then
 *   playerId, then one value per game.
 */
function buildSeries(results, gameIdsInOrder) {
  /** @type {Record<string, Record<string, Record<string, any>>>} */
  var byGame = {};
  /** @type {Record<string, boolean>} */
  var playerIds = {};
  results.forEach(function (row) {
    if (!byGame[row.gameId]) byGame[row.gameId] = {};
    byGame[row.gameId][row.playerId] = row;
    playerIds[row.playerId] = true;
  });

  /** @type {Record<string, Record<string, (number|null)[]>>} */
  var series = {};
  SERIES_METRICS.forEach(function (metric) { series[metric] = {}; });

  Object.keys(playerIds).forEach(function (playerId) {
    var totalPt = 0;
    var rankSum = 0;
    var games = 0;
    SERIES_METRICS.forEach(function (metric) { series[metric][playerId] = []; });

    gameIdsInOrder.forEach(function (gameId) {
      var row = byGame[gameId] && byGame[gameId][playerId];
      if (row) {
        games++;
        totalPt = round(totalPt + row.totalPt, 1);
        rankSum += row.rank;
      }
      series.totalPt[playerId].push(totalPt);
      series.avgPt[playerId].push(games ? round(totalPt / games, 2) : null);
      series.avgRank[playerId].push(games ? round(rankSum / games, 2) : null);
    });
  });
  return series;
}

