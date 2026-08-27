'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPureFunctions } = require('../dev/app-context');

const { aggregatePlayerStats, buildSeries } =
  loadPureFunctions(['Stats.js'], ['aggregatePlayerStats', 'buildSeries']);

const row = (gameId, playerId, rank, totalPt, extra) =>
  Object.assign({ gameId, playerId, rank, totalPt, rawScore: 25000, tobi: false }, extra);

test('aggregates games, points and rank distribution per player', () => {
  const results = [
    row('G1', 'P1', 1, 50, { rawScore: 45000 }),
    row('G1', 'P2', 4, -40, { rawScore: 10000, tobi: false }),
    row('G2', 'P1', 4, -30, { rawScore: 12000 }),
    row('G2', 'P2', 1, 45, { rawScore: 44000 })
  ];
  const stats = aggregatePlayerStats(results);

  const p1 = stats.find((s) => s.playerId === 'P1');
  assert.equal(p1.games, 2);
  assert.equal(p1.totalPt, 20);
  assert.equal(p1.avgPt, 10);
  assert.equal(p1.avgRank, 2.5);
  assert.deepEqual(p1.rankCounts, [1, 0, 0, 1]);
  assert.equal(p1.rank1Rate, 0.5);
  assert.equal(p1.rank4Rate, 0.5);
  assert.equal(p1.rank2Rate, 0);
  assert.equal(p1.avgRawScore, 28500);
});

test('sorts players by total points, highest first', () => {
  const stats = aggregatePlayerStats(
    [row('G1', 'P1', 2, -10), row('G1', 'P2', 1, 10)],
    { G1: 4 }
  );
  assert.deepEqual(stats.map((s) => s.playerId), ['P2', 'P1']);
});

test('a three-player table leaves the fourth-place rate at zero', () => {
  const results = [
    row('G1', 'P1', 1, 35),
    row('G1', 'P2', 2, 0),
    row('G1', 'P3', 3, -35)
  ];
  const stats = aggregatePlayerStats(results);

  // Last place is third here; nobody can finish fourth, so that rate is zero
  // for everyone rather than standing in for last.
  assert.equal(stats.find((s) => s.playerId === 'P3').rank3Rate, 1);
  assert.equal(stats.find((s) => s.playerId === 'P3').rank4Rate, 0);
  assert.equal(stats.find((s) => s.playerId === 'P2').rank3Rate, 0);
});

test('counts bankruptcies', () => {
  const results = [
    row('G1', 'P1', 1, 60),
    row('G1', 'P2', 4, -50, { tobi: true }),
    row('G2', 'P2', 4, -40, { tobi: true })
  ];
  const stats = aggregatePlayerStats(results);

  const p2 = stats.find((s) => s.playerId === 'P2');
  assert.equal(p2.tobiCount, 2);
  assert.equal(p2.tobiRate, 1);
});

test('rates are counted per game played', () => {
  const results = [
    row('G1', 'P1', 1, 50),
    row('G1', 'P2', 2, 10),
    row('G1', 'P3', 3, -20),
    row('G1', 'P4', 4, -40, { tobi: true }),
    row('G2', 'P1', 2, 10),
    row('G2', 'P2', 1, 50),
    row('G2', 'P3', 4, -40, { tobi: true }),
    row('G2', 'P4', 3, -20)
  ];
  const by = {};
  aggregatePlayerStats(results).forEach((p) => { by[p.playerId] = p; });

  // One rate per placing: P1 went 1st then 2nd, P3 went 3rd then 4th.
  assert.equal(by.P1.rank1Rate, 0.5);
  assert.equal(by.P1.rank2Rate, 0.5);
  assert.equal(by.P1.rank4Rate, 0);
  assert.equal(by.P3.rank3Rate, 0.5);
  assert.equal(by.P3.rank4Rate, 0.5);

  // Bankruptcy is a rate as well as a count, so it can be compared across
  // players who have played different numbers of games.
  assert.equal(by.P4.tobiCount, 1);
  assert.equal(by.P4.tobiRate, 0.5);
  assert.equal(by.P1.tobiRate, 0);
});

test('cumulative series carries the total across games a player sat out', () => {
  const results = [
    row('G1', 'P1', 1, 10),
    row('G1', 'P2', 2, -10),
    row('G2', 'P1', 2, -5),
    row('G2', 'P3', 1, 5)
  ];
  const series = buildSeries(results, ['G1', 'G2']).totalPt;

  assert.deepEqual(series.P1, [10, 5]);
  assert.deepEqual(series.P2, [-10, -10]); // sat out G2, value carries over
  assert.deepEqual(series.P3, [0, 5]);     // joined at G2, starts flat at zero
});

test('running averages start at a player\'s first game, not at zero', () => {
  const results = [
    row('G1', 'P1', 1, 10),
    row('G1', 'P2', 2, -10),
    row('G2', 'P1', 2, -5),
    row('G2', 'P3', 1, 5)
  ];
  const series = buildSeries(results, ['G1', 'G2']);

  // An average of 0 is not a value either metric can take, so before the first
  // game there is nothing to plot.
  assert.deepEqual(series.avgPt.P3, [null, 5]);
  assert.deepEqual(series.avgRank.P3, [null, 1]);

  assert.deepEqual(series.avgPt.P1, [10, 2.5]);
  assert.deepEqual(series.avgRank.P1, [1, 1.5]);
  assert.deepEqual(series.avgRank.P2, [2, 2]); // sat out G2, average unchanged
});
