/**
 * The settings that belong to your copy rather than to the app.
 *
 * Everything else under src/ works unchanged; this file is the one place to
 * edit before deploying. setup() prints a reminder of what is left to decide.
 */

/**
 * Shown in the browser tab and as the heading on every screen.
 *
 * setup() also names the data spreadsheet after it, so choosing this before the
 * first run saves renaming the file in Drive afterwards.
 */
var APP_TITLE = '家族麻雀 スコア記録';

/**
 * The colour scheme new visitors get before they pick one of their own.
 *
 * Choosing here rather than in css.html keeps every decision in one file; the
 * palettes themselves live in css.html under [data-accent].
 *
 * One of: 'green' (グリーン) 'blue' (ブルー) 'red' (レッド) 'purple' (パープル)
 * 'orange' (オレンジ) 'black' (ブラック). An id no palette defines falls back to
 * green rather than breaking, and tests/config.test.js fails the build if you
 * mistype one.
 */
var DEFAULT_ACCENT = 'green';

/**
 * The tab bar's icon style for people who have not picked one.
 *
 * One of: 'emoji' (絵文字) 'line' (線画アイコン) 'text' (文字のみ). Both icon
 * sets are in the markup and CSS decides which one shows, so switching costs
 * nothing at runtime. An unknown id leaves the emoji showing, since that is
 * what the bare markup renders, and tests/config.test.js catches the typo.
 */
var DEFAULT_ICONS = 'line';
