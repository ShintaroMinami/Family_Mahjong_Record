'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPureFunctions } = require('../dev/app-context');

const { computeGameResults, validateGameEntries, validateRule, rankEntries } =
  loadPureFunctions(['Domain.js'], [
    'computeGameResults', 'validateGameEntries', 'validateRule', 'rankEntries'
  ]);

/** Standard 4-player rule: 25000 start / 30000 return, uma 10-20, tobi 10pt. */
const RULE4 = {
  ruleId: 'R001',
  name: '四麻',
  playerCount: 4,
  startPoints: 25000,
  returnPoints: 30000,
  uma: [20, 10, -10, -20],
  tobiBonus: 10
};

/** Standard 3-player rule: 35000 start / 40000 return, uma 10-20. */
const RULE3 = {
  ruleId: 'R002',
  name: '三麻',
  playerCount: 3,
  startPoints: 35000,
  returnPoints: 40000,
  uma: [20, 0, -20],
  tobiBonus: 10
};

const entries = (...scores) =>
  scores.map((rawScore, seat) => ({ seat, playerId: 'P' + seat, rawScore }));

const sumTotal = (results) =>
  Math.round(results.reduce((sum, r) => sum + r.totalPt, 0) * 100) / 100;

test('4-player game: ranks, uma and oka', () => {
  const results = computeGameResults(entries(45000, 30000, 15000, 10000), RULE4);

  assert.deepEqual(results.map((r) => r.rank), [1, 2, 3, 4]);
  assert.deepEqual(results.map((r) => r.playerId), ['P0', 'P1', 'P2', 'P3']);

  // Winner: (45000-30000)/1000 = 15pt, uma +20, oka +20
  assert.equal(results[0].scorePt, 15);
  assert.equal(results[0].umaPt, 20);
  assert.equal(results[0].okaPt, 20);
  assert.equal(results[0].totalPt, 55);

  // Last place: (10000-30000)/1000 = -20pt, uma -20, no oka
  assert.equal(results[3].totalPt, -40);
  assert.equal(sumTotal(results), 0);
});

test('3-player game: oka is 15pt and totals still cancel out', () => {
  const results = computeGameResults(entries(50000, 35000, 20000), RULE3);

  assert.equal(results[0].okaPt, 15);
  assert.equal(results[0].totalPt, 10 + 20 + 15);
  assert.equal(sumTotal(results), 0);
});

test('ties are broken by seat, closer to the first dealer wins', () => {
  // Seats 2 and 1 are tied on 25000; seat 1 must take the higher rank.
  const results = computeGameResults(entries(45000, 25000, 25000, 5000), RULE4);

  assert.deepEqual(results.map((r) => r.seat), [0, 1, 2, 3]);
  assert.equal(results[1].rank, 2);
  assert.equal(results[2].rank, 3);
  assert.equal(sumTotal(results), 0);
});

test('bankruptcy transfers the tobi bonus to the winner', () => {
  const results = computeGameResults(entries(60000, 30000, 15000, -5000), RULE4);

  assert.equal(results[3].tobi, true);
  assert.equal(results[3].tobiPt, -10);
  assert.equal(results[0].tobiPt, 10);
  assert.equal(sumTotal(results), 0);
});

test('two bankruptcies both pay the winner', () => {
  const results = computeGameResults(entries(105000, 5000, -4000, -6000), RULE4);

  assert.equal(results[0].tobiPt, 20);
  assert.equal(sumTotal(results), 0);
});

test('tobiBonus = 0 disables the bonus entirely', () => {
  const rule = Object.assign({}, RULE4, { tobiBonus: 0 });
  const results = computeGameResults(entries(60000, 30000, 15000, -5000), rule);

  assert.deepEqual(results.map((r) => r.tobiPt), [0, 0, 0, 0]);
  assert.equal(sumTotal(results), 0);
});

test('non-round scores stay zero-sum', () => {
  const results = computeGameResults(entries(32700, 28400, 24100, 14800), RULE4);

  assert.equal(results[0].scorePt, 2.7);
  assert.equal(sumTotal(results), 0);
});

test('a game where nobody reaches the return line is still zero-sum', () => {
  const results = computeGameResults(entries(29900, 29800, 20200, 20100), RULE4);
  assert.equal(sumTotal(results), 0);
});

test('validateGameEntries flags a wrong score total', () => {
  const warnings = validateGameEntries(entries(45000, 30000, 15000, 9000), RULE4);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /素点の合計/);
});

test('validateGameEntries flags unbalanced chips', () => {
  const list = entries(45000, 30000, 15000, 10000);
  list[0].chips = 3;
  list[1].chips = -1;
  const warnings = validateGameEntries(list, RULE4);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /チップの合計/);
});

test('validateGameEntries returns nothing for a clean game', () => {
  assert.deepEqual(validateGameEntries(entries(45000, 30000, 15000, 10000), RULE4), []);
});

test('rankEntries does not mutate its input', () => {
  const list = entries(10000, 45000, 30000, 15000);
  const before = list.map((e) => e.playerId);
  rankEntries(list);
  assert.deepEqual(list.map((e) => e.playerId), before);
});

test('a rule whose uma does not cancel out is rejected', () => {
  const rule = Object.assign({}, RULE4, { uma: [30, 10, -10, -20] });
  assert.throws(() => validateRule(rule), /uma must sum to 0/);
});

test('duplicate players in one game are rejected', () => {
  const list = entries(45000, 30000, 15000, 10000);
  list[1].playerId = 'P0';
  assert.throws(() => computeGameResults(list, RULE4), /same player/);
});

test('a wrong number of entries is rejected', () => {
  assert.throws(() => computeGameResults(entries(45000, 30000, 25000), RULE4), /expected 4 entries/);
});
