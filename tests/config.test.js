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

/** @param {string} attribute @returns {Set<string>} Ids css.html has a rule for. */
function styledIds(attribute) {
  const ids = new Set();
  const pattern = new RegExp(`\\[${attribute}="(\\w+)"\\]`, 'g');
  let match;
  while ((match = pattern.exec(read('css.html')))) ids.add(match[1]);
  return ids;
}

/** @param {string} name @returns {Set<string>} Ids the named js.html list offers. */
function listedIds(name) {
  const list = read('js.html').match(new RegExp(`var ${name} = \\[[\\s\\S]*?\\];`));
  assert.ok(list, `${name} should be a single array literal in js.html`);
  return new Set(Array.from(list[0].matchAll(/id: '(\w+)'/g), (m) => m[1]));
}

test('the default icon style names a style that exists', () => {
  const { DEFAULT_ICONS } = loadPureFunctions(['Config.js'], ['DEFAULT_ICONS']);
  assert.ok(
    styledIds('data-icons').has(DEFAULT_ICONS),
    `DEFAULT_ICONS '${DEFAULT_ICONS}' has no [data-icons] rule in css.html`
  );
});

test('every offered icon style is styled, and every styled one is offered', () => {
  assert.deepEqual([...listedIds('ICON_STYLES')].sort(), [...styledIds('data-icons')].sort());
});

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

// --- contrast ---------------------------------------------------------------
//
// --accent is used both as a background carrying --on-accent text and as text
// on --surface. A palette that reads well one way can fail the other, and dark
// mode used to: white on the light accents came out around 2.4:1. These keep a
// new palette from slipping back below the WCAG AA threshold for body text.

const AA = 4.5;

/** @param {string} hex @returns {number} Relative luminance per WCAG 2. */
function luminance(hex) {
  const channels = [1, 3, 5].map((i) => parseInt(hex.substr(i, 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Splits css.html at the dark-mode media query and pulls each half's accents
 * apart, so both colour schemes can be checked with the same assertions.
 *
 * @returns {{scheme: string, accent: Record<string, string>, on: string, surface: string}[]}
 */
function schemes() {
  const css = read('css.html');
  const darkAt = css.indexOf('@media (prefers-color-scheme: dark)');
  assert.ok(darkAt > 0, 'the dark-mode block should exist');

  return [
    { scheme: 'light', css: css.slice(0, darkAt) },
    { scheme: 'dark', css: css.slice(darkAt) }
  ].map(({ scheme, css: part }) => {
    const single = (name) => {
      const found = part.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'));
      assert.ok(found, `--${name} should be defined in the ${scheme} block`);
      return found[1];
    };
    /** @type {Record<string, string>} */
    const accent = {};
    const blocks = /\[data-accent="(\w+)"\][^{]*\{([^}]*)\}/g;
    let match;
    while ((match = blocks.exec(part))) {
      const value = match[2].match(/--accent:\s*(#[0-9a-f]{6})/i);
      assert.ok(value, `[data-accent="${match[1]}"] should set --accent`);
      accent[match[1]] = value[1];
    }
    return { scheme, accent, on: single('on-accent'), surface: single('surface') };
  });
}

test('every palette carries readable text on the accent', () => {
  schemes().forEach(({ scheme, accent, on }) => {
    Object.entries(accent).forEach(([id, colour]) => {
      const ratio = contrast(colour, on);
      assert.ok(ratio >= AA, `${scheme}/${id}: ${on} on ${colour} is ${ratio.toFixed(2)}:1`);
    });
  });
});

test('every palette stays readable as text on a card', () => {
  schemes().forEach(({ scheme, accent, surface }) => {
    Object.entries(accent).forEach(([id, colour]) => {
      const ratio = contrast(colour, surface);
      assert.ok(ratio >= AA, `${scheme}/${id}: ${colour} on ${surface} is ${ratio.toFixed(2)}:1`);
    });
  });
});

test('all six palettes are covered in both colour schemes', () => {
  schemes().forEach(({ scheme, accent }) => {
    assert.deepEqual(Object.keys(accent).sort(), [...paletteIds()].sort(), scheme);
  });
});
