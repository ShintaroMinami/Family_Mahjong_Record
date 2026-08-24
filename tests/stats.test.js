'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPureFunctions } = require('../dev/app-context');

const { aggregatePlayerStats, buildCumulativeSeries } =
  loadPureFunctions(['Stats.js'], ['aggregatePlayerStats', 'buildCumulativeSeries']);

const row = (gameId, playerId, rank, totalPt, extra) =>
  Object.assign({ gameId, playerId, rank, totalPt, rawScore: 25000, chips: 0, tobi: false }, extra);

test('aggregates games, points and rank distribution per player', () => {
  const results = [
    row('G1', 'P1', 1, 50, { rawScore: 45000 }),
    row('G1', 'P2', 4, -40, { rawScore: 10000, tobi: false }),
    row('G2', 'P1', 4, -30, { rawScore: 12000 }),
    row('G2', 'P2', 1, 45, { rawScore: 44000 })
  ];
  const stats = aggregatePlayerStats(results, { G1: 4, G2: 4 });

  const p1 = stats.find((s) => s.playerId === 'P1');
  assert.equal(p1.games, 2);
  assert.equal(p1.totalPt, 20);
  assert.equal(p1.avgPt, 10);
  assert.equal(p1.avgRank, 2.5);
  assert.deepEqual(p1.rankCounts, [1, 0, 0, 1]);
  assert.equal(p1.topRate, 0.5);
  assert.equal(p1.lastRate, 0.5);
  assert.equal(p1.avgRawScore, 28500);
});

test('sorts players by total points, highest first', () => {
  const stats = aggregatePlayerStats(
    [row('G1', 'P1', 2, -10), row('G1', 'P2', 1, 10)],
    { G1: 4 }
  );
  assert.deepEqual(stats.map((s) => s.playerId), ['P2', 'P1']);
});

test('last place is rank 3 in a three-player game', () => {
  const results = [
    row('G1', 'P1', 1, 35),
    row('G1', 'P2', 2, 0),
    row('G1', 'P3', 3, -35)
  ];
  const stats = aggregatePlayerStats(results, { G1: 3 });

  assert.equal(stats.find((s) => s.playerId === 'P3').lastRate, 1);
  assert.equal(stats.find((s) => s.playerId === 'P2').lastRate, 0);
});

test('counts bankruptcies and nets chips', () => {
  const results = [
    row('G1', 'P1', 1, 60, { chips: 3 }),
    row('G1', 'P2', 4, -50, { chips: -3, tobi: true }),
    row('G2', 'P2', 4, -40, { chips: 1, tobi: true })
  ];
  const stats = aggregatePlayerStats(results, { G1: 4, G2: 4 });

  const p2 = stats.find((s) => s.playerId === 'P2');
  assert.equal(p2.tobiCount, 2);
  assert.equal(p2.chips, -2);
});

test('cumulative series carries the total across games a player sat out', () => {
  const results = [
    row('G1', 'P1', 1, 10),
    row('G1', 'P2', 2, -10),
    row('G2', 'P1', 2, -5),
    row('G2', 'P3', 1, 5)
  ];
  const series = buildCumulativeSeries(results, ['G1', 'G2']);

  assert.deepEqual(series.P1, [10, 5]);
  assert.deepEqual(series.P2, [-10, -10]); // sat out G2, value carries over
  assert.deepEqual(series.P3, [0, 5]);     // joined at G2, starts flat at zero
});
