'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadPureFunctions, SRC } = require('../dev/app-context');

const read = (name) => fs.readFileSync(path.join(SRC, name), 'utf8');

/** Accent ids the stylesheet actually defines a palette for. */
function paletteIds() {
  const ids = new Set();
  const pattern = /\[data-accent="(\w+)"\]/g;
  let match;
  while ((match = pattern.exec(read('css.html')))) ids.add(match[1]);
  return ids;
}

/** Accent ids the settings tab offers. */
function offeredIds() {
  const list = read('js.html').match(/var ACCENTS = \[[\s\S]*?\];/);
  assert.ok(list, 'ACCENTS should be a single array literal in js.html');
  return new Set(Array.from(list[0].matchAll(/id: '(\w+)'/g), (m) => m[1]));
}

test('the default accent names a palette that exists', () => {
  // A typo here would silently fall back to green, which is easy to miss when
  // green is what you were changing away from.
  const { DEFAULT_ACCENT } = loadPureFunctions(['Config.js'], ['DEFAULT_ACCENT']);
  assert.ok(
    paletteIds().has(DEFAULT_ACCENT),
    `DEFAULT_ACCENT '${DEFAULT_ACCENT}' has no [data-accent] palette in css.html`
  );
});

test('every offered accent has a palette, and every palette is offered', () => {
  assert.deepEqual([...offeredIds()].sort(), [...paletteIds()].sort());
});

test('every offered accent has a swatch colour', () => {
  const css = read('css.html');
  offeredIds().forEach((id) => {
    assert.match(css, new RegExp(`\\.swatch-${id}\\s*\\{`), `.swatch-${id} is missing`);
  });
});
