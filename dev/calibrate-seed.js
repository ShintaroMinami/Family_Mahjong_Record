#!/usr/bin/env node
/**
 * Measures the sample data generator, so its skill spread can be set against a
 * target rather than guessed at.
 *
 * Scores are generated directly here rather than through apiSubmitGame: seeding
 * a database writes the whole JSON file per game, which makes the sample sizes
 * this needs take minutes instead of a second.
 *
 * Usage:
 *   node dev/calibrate-seed.js [--games 20000] [--steps 1500,2000,2500]
 */

'use strict';

const {
  mulberry32, randomScores, skillOf, SKILL_ORDER, SKILL_STEP
} = require('./app-context');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const GAMES = Number(flag('--games', 20000));
const STEPS = flag('--steps', String(SKILL_STEP)).split(',').map(Number);

/**
 * Plays out the generator and reports what the resulting statistics look like.
 *
 * @param {number} step
 * @returns {{rank: Record<string, number>, sigma: number, tobi: number}}
 */
function measure(step) {
  const random = mulberry32(20260825);
  const played = {};
  const rankSum = {};
  const scores = [];
  let tobi = 0;
  SKILL_ORDER.forEach((name) => { played[name] = 0; rankSum[name] = 0; });

  for (let index = 0; index < GAMES; index += 1) {
    // Four-handed only: the placing targets are stated on a 1-4 scale.
    const table = [];
    for (let i = 0; i < 4; i += 1) table.push(SKILL_ORDER[(index + i) % SKILL_ORDER.length]);

    const raw = randomScores(random, table.map(skillOf), 100000, step);
    raw.forEach((score) => { scores.push(score); if (score < 0) tobi += 1; });

    const order = table
      .map((name, seat) => ({ name, score: raw[seat], seat }))
      .sort((a, b) => (b.score - a.score) || (a.seat - b.seat));
    order.forEach((entry, place) => {
      played[entry.name] += 1;
      rankSum[entry.name] += place + 1;
    });
  }

  const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  const variance = scores.reduce((sum, score) => sum + (score - mean) ** 2, 0) / scores.length;

  const rank = {};
  SKILL_ORDER.forEach((name) => { rank[name] = rankSum[name] / played[name]; });
  return { rank, sigma: Math.sqrt(variance), tobi: tobi / scores.length };
}

console.log(`${GAMES.toLocaleString()} 半荘（四人麻雀）\n`);
console.log(['step'.padEnd(6), ...SKILL_ORDER.map((n) => n.padStart(6))].join(' '),
  '   幅   素点SD   トビ率');
STEPS.forEach((step) => {
  const { rank, sigma, tobi } = measure(step);
  const spread = rank[SKILL_ORDER[SKILL_ORDER.length - 1]] - rank[SKILL_ORDER[0]];
  console.log(
    [String(step).padEnd(6), ...SKILL_ORDER.map((n) => rank[n].toFixed(3).padStart(6))].join(' '),
    spread.toFixed(3).padStart(6),
    Math.round(sigma).toLocaleString().padStart(8),
    (tobi * 100).toFixed(1).padStart(6) + '%'
  );
});
