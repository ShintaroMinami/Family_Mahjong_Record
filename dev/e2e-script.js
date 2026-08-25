/**
 * In-browser end-to-end scenario.
 *
 * The local server injects this when the page is requested with `?e2e=1`. It
 * drives the real UI, then writes a JSON report into a pre#e2e-report element so a
 * headless Chrome run can be checked with --dump-dom, no automation library
 * required.
 */
(function () {
  'use strict';

  var report = [];

  /** Uncaught page errors, surfaced in the report so a broken UI is obvious. */
  var pageErrors = [];
  window.addEventListener('error', function (event) {
    pageErrors.push(event.message + ' @' + (event.filename || '?') + ':' + event.lineno);
  });
  window.addEventListener('unhandledrejection', function (event) {
    pageErrors.push('unhandled rejection: ' +
      (event.reason && event.reason.message ? event.reason.message : String(event.reason)));
  });

  function check(name, condition, detail) {
    report.push({ name: name, pass: !!condition, detail: String(detail == null ? '' : detail) });
  }

  function $(selector) { return document.querySelector(selector); }
  function $$(selector) { return Array.prototype.slice.call(document.querySelectorAll(selector)); }

  /**
   * Resolves once `predicate` returns truthy.
   *
   * The budget is counted in polls rather than milliseconds: headless Chrome is
   * driven with --virtual-time-budget, which fast-forwards Date.now() and would
   * blow a wall-clock deadline long before a fetch could come back.
   */
  function waitFor(label, predicate, describe, maxPolls) {
    var remaining = maxPolls || 200;
    return new Promise(function (resolve, reject) {
      (function poll() {
        var value = null;
        var failure = '';
        try { value = predicate(); } catch (error) { failure = error.message; }
        if (value) { resolve(value); return; }
        if (--remaining <= 0) {
          var state = '';
          try { state = describe ? describe() : ''; } catch (error) { state = 'describe failed: ' + error.message; }
          reject(new Error('timeout: ' + label +
            (state ? ' [' + state + ']' : '') +
            (failure ? ' {predicate: ' + failure + '}' : '')));
          return;
        }
        setTimeout(poll, 50);
      })();
    });
  }

  function setValue(element, value) {
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function click(element) { element.click(); }

  function textOf(selector) {
    var el = $(selector);
    return el ? el.textContent : '';
  }

  /**
   * Returns the visible form controls that stick out of their own card.
   *
   * iOS sizes date inputs and selects differently from text inputs, so a row of
   * mixed controls is where the layout breaks first.
   */
  function overflowingFields() {
    return $$('.panel.active input, .panel.active select').filter(function (el) {
      var card = el.closest('.card');
      if (!card || !el.offsetParent) return false;
      var box = el.getBoundingClientRect();
      var bounds = card.getBoundingClientRect();
      return box.right > bounds.right + 1 || box.left < bounds.left - 1;
    }).map(function (el) { return el.id || el.className; });
  }

  /** Checks that two controls ended up the same height. */
  function sameHeight(selectorA, selectorB) {
    var a = $(selectorA).getBoundingClientRect().height;
    var b = $(selectorB).getBoundingClientRect().height;
    return { ok: Math.abs(a - b) < 1, detail: Math.round(a) + 'px / ' + Math.round(b) + 'px' };
  }

  /** Asserts the active panel has no control spilling out of its card. */
  function checkNoOverflow(label) {
    var overflowing = overflowingFields();
    check(label + 'の入力欄がカード内に収まる', overflowing.length === 0, overflowing.join(', '));
  }

  /**
   * Publishes the report.
   *
   * It is posted back to the dev server, which is what the test runner waits on;
   * the element and the title are there for eyeballing the run in a real browser.
   */
  function finish() {
    var passed = report.every(function (r) { return r.pass; });
    var pre = document.createElement('pre');
    pre.id = 'e2e-report';
    pre.textContent = JSON.stringify(report, null, 2);
    document.body.appendChild(pre);
    document.title = passed ? 'E2E:PASS' : 'E2E:FAIL';
    fetch('/e2e-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report)
    });
  }

  function run() {
    // Auto-accept the confirmation dialogs the update and delete flows use.
    window.confirm = function () { return true; };

    var gamesBefore = 0;

    return waitFor('初期表示', function () {
      return $$('#seat-grid .seat-row').length === 4 && $('#in-rule').options.length > 0;
    }, function () {
      var grid = $('#seat-grid');
      var rule = $('#in-rule');
      return 'seatRows=' + (grid ? grid.children.length : 'no-grid') +
        ' ruleOptions=' + (rule ? rule.children.length : 'no-select') +
        ' toast=' + textOf('#toast') +
        ' errors=' + JSON.stringify(pageErrors);
    }).then(function () {
      check('初期表示: 4席が描画される', $$('#seat-grid .seat-row').length === 4);
      check('初期表示: ルールが読み込まれる', $('#in-rule').options.length === 2,
        $('#in-rule').options.length);
      check('初期表示: プレイヤーが選択肢に出る',
        $('#seat-grid .in-player').options.length >= 5,
        $('#seat-grid .in-player').options.length);
      check('初期表示: 日付が入る', /^\d{4}-\d{2}-\d{2}$/.test($('#in-date').value), $('#in-date').value);

      var pair = sameHeight('#in-date', '#in-rule');
      check('登録: 日付とルールの高さが揃う', pair.ok, pair.detail);
      checkNoOverflow('登録');

      var root = document.documentElement;
      check('モバイル幅で横スクロールが出ない',
        root.scrollWidth <= root.clientWidth + 1,
        'scrollWidth=' + root.scrollWidth + ' clientWidth=' + root.clientWidth +
        ' innerWidth=' + window.innerWidth + ' dpr=' + window.devicePixelRatio);
      check('タブバーが画面幅に収まる',
        $('nav.tabbar').getBoundingClientRect().width <= root.clientWidth + 1,
        Math.round($('nav.tabbar').getBoundingClientRect().width));

      gamesBefore = ($$('#day-summary .game-card') || []).length;

      // --- fill in one game -------------------------------------------------
      var rows = $$('#seat-grid .seat-row');
      var scores = [45200, 28700, 17800, 8300];
      rows.forEach(function (row, seat) {
        var select = row.querySelector('.in-player');
        setValue(select, select.options[seat + 1].value);
        setValue(row.querySelector('.in-score'), String(scores[seat]));
      });

      check('素点合計が一致すると sum-ok になる', $('#score-sum').className === 'sum-ok',
        $('#score-sum').className + ' / ' + textOf('#score-sum'));
      // Values are in the fields now, which is when a too-narrow column shows up.
      checkNoOverflow('入力後の登録');

      click($('#btn-preview'));
      return waitFor('計算結果', function () { return $('#preview-area table'); });
    }).then(function () {
      var firstRow = $('#preview-area tbody tr');
      check('計算結果に4行出る', $$('#preview-area tbody tr').length === 4);
      // 45200点 → 素点15.2pt + ウマ20 + オカ20 = 55.2pt
      check('1位の収支が +55.2', firstRow.lastElementChild.textContent.trim() === '+55.2',
        firstRow.lastElementChild.textContent);
      check('計算結果に警告が出ない', $$('#preview-area .warn').length === 0);

      // --- submit -----------------------------------------------------------
      click($('#btn-submit'));
      return waitFor('登録完了トースト', function () {
        return /登録しました/.test(textOf('#toast')) ? textOf('#toast') : null;
      });
    }).then(function (toast) {
      check('登録するとgameIdが返る', /G\d{8}-\d{3}/.test(toast), toast);
      return waitFor('日別集計の更新', function () {
        return $$('#day-summary .game-card').length === gamesBefore + 1;
      });
    }).then(function () {
      check('日別集計に対局が追加される', $$('#day-summary .game-card').length === gamesBefore + 1);
      check('登録後にフォームがクリアされる',
        $$('#seat-grid .in-score').every(function (input) { return input.value === ''; }));

      // --- validation -------------------------------------------------------
      click($('#btn-preview'));
      return waitFor('未入力エラー', function () {
        return /プレイヤーが未選択/.test(textOf('#toast')) ? textOf('#toast') : null;
      });
    }).then(function (toast) {
      check('未入力のまま計算するとエラーになる', /プレイヤーが未選択/.test(toast), toast);

      // --- today tab --------------------------------------------------------
      click($('[data-tab="today"]'));
      check('今日タブが開く', $('#panel-today').classList.contains('active'));
      check('日別サマリに合計行がある', $$('#day-summary table tbody tr').length > 0);
      checkNoOverflow('今日');

      // --- history tab ------------------------------------------------------
      click($('[data-tab="history"]'));
      return waitFor('履歴の読み込み', function () { return $$('#history-list .game-card').length > 0; });
    }).then(function () {
      check('履歴に対局が並ぶ', $$('#history-list .game-card').length > 0,
        $$('#history-list .game-card').length);
      var histPair = sameHeight('#hist-from', '#hist-to');
      check('履歴: 開始と終了の高さが揃う', histPair.ok, histPair.detail);
      checkNoOverflow('履歴');
      check('履歴に編集ボタンがある', $$('#history-list [data-edit]').length > 0);

      // --- edit flow --------------------------------------------------------
      var targetId = $('#history-list [data-edit]').getAttribute('data-edit');
      click($('#history-list [data-edit]'));
      return waitFor('編集フォームの読み込み', function () {
        return $('#entry-title').textContent.indexOf(targetId) >= 0;
      }).then(function () { return targetId; });
    }).then(function (targetId) {
      check('編集で登録タブに切り替わる', $('#panel-entry').classList.contains('active'));
      check('編集フォームに素点が入る',
        $$('#seat-grid .in-score').every(function (input) { return input.value !== ''; }));
      check('編集中は更新ボタンになる', $('#btn-submit').textContent.indexOf('更新') >= 0,
        $('#btn-submit').textContent);

      var firstScore = $('#seat-grid .in-score');
      var others = $$('#seat-grid .in-score').slice(1);
      setValue(firstScore, String(Number(firstScore.value) + 1000));
      setValue(others[0], String(Number(others[0].value) - 1000));
      check('編集後も素点合計が一致する', $('#score-sum').className === 'sum-ok', textOf('#score-sum'));

      click($('#btn-submit'));
      return waitFor('更新完了', function () {
        return /更新しました/.test(textOf('#toast'));
      }).then(function () { return targetId; });
    }).then(function (targetId) {
      check('更新が成功する', true);
      check('更新後に編集モードが解除される',
        $('#btn-submit').textContent.indexOf('登録') >= 0, $('#btn-submit').textContent);

      // --- delete flow ------------------------------------------------------
      click($('[data-tab="history"]'));
      return waitFor('履歴の再読み込み', function () { return $$('#history-list .game-card').length > 0; })
        .then(function () {
          var before = $$('#history-list .game-card').length;
          click($('#history-list [data-delete]'));
          return waitFor('削除完了', function () { return /削除しました/.test(textOf('#toast')); })
            .then(function () { return before; });
        });
    }).then(function (before) {
      click($('[data-tab="history"]'));
      // The history panel reloads lazily, so force it.
      click($('#btn-hist-load'));
      return waitFor('削除の反映', function () {
        return $$('#history-list .game-card').length === before - 1;
      }).then(function () {
        check('削除すると履歴から消える', true, before + ' → ' + $$('#history-list .game-card').length);
      });
    }).then(function () {
      // --- stats tab --------------------------------------------------------
      click($('[data-tab="stats"]'));
      return waitFor('統計の読み込み', function () { return $('#stats-body table'); });
    }).then(function () {
      check('統計テーブルが描画される', $$('#stats-body table tbody tr').length > 0);
      var statsPair = sameHeight('#stats-from', '#stats-to');
      check('統計: 開始と終了の高さが揃う', statsPair.ok, statsPair.detail);
      checkNoOverflow('統計');
      check('累積グラフが描画される', $$('#stats-body svg polyline').length > 0,
        $$('#stats-body svg polyline').length);
      check('凡例が出る', $$('#stats-body .legend span').length > 0);

      // --- switching what the chart plots ------------------------------------
      check('既定のグラフは累積収支', chartTitle().indexOf('累積収支') === 0, chartTitle());
      check('0の基準線が引かれる', $$('#stats-body svg line').length === 1);
      var byTotalPoints = polylinePoints();

      click($('#stats-body button[data-metric="avgRank"]'));
      check('平順のグラフに切り替わる', chartTitle().indexOf('平均着順') === 0, chartTitle());
      check('線の形が変わる', polylinePoints() !== byTotalPoints);
      check('平順では0の基準線を引かない', $$('#stats-body svg line').length === 0);
      check('平順は上が良い順位になる', axisLabels()[0] < axisLabels()[1],
        axisLabels().join(' / '));

      click($('#stats-body button[data-metric="chips"]'));
      check('チップのグラフに切り替わる', chartTitle().indexOf('チップ') === 0, chartTitle());

      click($('#stats-body button[data-metric="totalPt"]'));
      check('累積収支に戻せる', polylinePoints() === byTotalPoints, chartTitle());
      check('選択中のグラフに印が付く',
        $('#stats-body button[data-metric="totalPt"]').className.indexOf('active') >= 0);

      // --- sorting the statistics tables ------------------------------------
      check('既定は連対率の降順', sortedOn('連対率', 1) === '▼', sortedOn('連対率', 1));
      var byDefault = names();
      check('連対率が高い順に並ぶ',
        descending(column('連対率', 1)), column('連対率', 1).join(' '));

      click(header('平順'));
      check('平順は昇順から始まる', sortedOn('平順') === '▲', sortedOn('平順'));
      check('平順が小さい順に並ぶ', ascending(column('平順')), column('平順').join(' '));
      check('連対率の印が消える', sortedOn('連対率', 1) === '', sortedOn('連対率', 1));
      check('詳細テーブルも同じ順になる',
        names(1).join() === names(0).join(), names(0).join() + ' / ' + names(1).join());

      click(header('平順'));
      check('もう一度押すと降順になる', sortedOn('平順') === '▼', sortedOn('平順'));
      check('平順が大きい順に並ぶ', descending(column('平順')), column('平順').join(' '));

      check('名前の見出しは並べ替えの対象外', !header('名前').getAttribute('data-sort'));

      var detailHeads = headers(1).map(function (th) {
        return th.textContent.replace(/[▼▲]/g, '').trim();
      });
      check('詳細は5項目を並べる',
        detailHeads.join(',') === '名前,連対率,トップ率,ラス率,トビ率,平均素点',
        detailHeads.join(','));

      click(header('トビ率', 1));
      check('詳細の見出しでも並べ替えられる',
        descending(column('トビ率', 1)), column('トビ率', 1).join(' '));

      click(header('合計'));
      check('合計でも並べ替えられる', descending(column('合計')), column('合計').join(' '));

      click(header('連対率', 1));
      check('既定の並びに戻せる', names().join() === byDefault.join(), names().join(' '));

      // --- add player -------------------------------------------------------
      click($('[data-tab="entry"]'));
      var before = $('#seat-grid .in-player').options.length;
      setValue($('#in-new-player'), 'テスト太郎');
      click($('#btn-add-player'));
      return waitFor('プレイヤー追加', function () {
        return $('#seat-grid .in-player').options.length === before + 1;
      }).then(function () { check('プレイヤーを追加できる', true); });
    }).then(function () {
      // --- rule editor -------------------------------------------------------
      click($('[data-tab="settings"]'));
      return waitFor('ルール一覧の読み込み', function () {
        return $$('#rule-list .rule-item').length > 0;
      });
    }).then(function () {
      check('ルールが一覧表示される', $$('#rule-list .rule-item').length === 2,
        $$('#rule-list .rule-item').length);
      checkNoOverflow('設定');

      click($('#btn-rule-new'));
      check('新規ルールのフォームが開く', $('#rule-editor').style.display !== 'none');
      check('既定は4人で、ウマ欄が4つ出る', $$('#rule-uma .rule-uma').length === 4);

      click($('#rule-player-count [data-count="3"]'));
      check('3人を選ぶとウマ欄が3つになる', $$('#rule-uma .rule-uma').length === 3,
        $$('#rule-uma .rule-uma').length);
      check('3人の既定値が入る', $('#rule-start').value === '35000', $('#rule-start').value);

      // オカなし・ウマ 30-0-30 の三麻を作る
      setValue($('#rule-name'), 'E2E 三麻 オカなし');
      setValue($('#rule-return'), '35000');
      check('返し点を原点と同じにするとオカなしと表示される',
        /オカなし/.test(textOf('#rule-oka')), textOf('#rule-oka'));

      var umaInputs = $$('#rule-uma .rule-uma');
      setValue(umaInputs[0], '30');
      setValue(umaInputs[1], '0');
      setValue(umaInputs[2], '-10');
      check('ウマの合計が0でないと警告が出る',
        $('#rule-uma-sum').className.indexOf('ng') >= 0, textOf('#rule-uma-sum'));

      setValue(umaInputs[2], '-30');
      check('ウマの合計が0になると警告が消える',
        $('#rule-uma-sum').className.indexOf('ng') < 0, textOf('#rule-uma-sum'));

      click($('#btn-rule-save'));
      return waitFor('ルール保存', function () {
        return $$('#rule-list .rule-item').length === 3;
      });
    }).then(function () {
      check('ルールを追加できる', true);
      check('保存後にフォームが閉じる', $('#rule-editor').style.display === 'none');

      click($('[data-tab="entry"]'));
      var names = Array.prototype.map.call($('#in-rule').options, function (o) { return o.textContent; });
      check('追加したルールが登録画面に出る', names.indexOf('E2E 三麻 オカなし') >= 0, names.join(' / '));

      setValue($('#in-rule'), $$('#in-rule option').filter(function (o) {
        return o.textContent === 'E2E 三麻 オカなし';
      })[0].value);
      return waitFor('三麻の席数', function () { return $$('#seat-grid .seat-row').length === 3; });
    }).then(function () {
      check('三麻ルールを選ぶと3席になる', $$('#seat-grid .seat-row').length === 3);
      check('三麻の素点合計の目標が105,000になる',
        textOf('#score-sum').indexOf('105,000') >= 0, textOf('#score-sum'));

      // ---- accent themes ----
      click($('[data-tab="settings"]'));
      var before = headerColour();
      click($('#accent-choice button[data-choice="red"]'));
      return waitFor('配色の反映', function () {
        return headerColour() !== before;
      }).then(function () { return before; });
    }).then(function (before) {
      check('配色を選ぶとヘッダーの色が変わる', headerColour() !== before,
        before + ' → ' + headerColour());
      check('選んだ配色が端末に記憶される',
        window.localStorage.getItem('mahjongAccent') === 'red');
      check('選択中の配色に印が付く',
        $('#accent-choice button[data-choice="red"]').className.indexOf('active') >= 0);

      // The labels are four katakana wide in a three-column grid, which is the
      // tightest text in the app.
      var clipped = $$('#accent-choice button').filter(function (button) {
        return button.scrollWidth > button.clientWidth + 1;
      }).map(function (button) { return button.textContent; });
      check('配色ボタンのラベルが切れない', clipped.length === 0, clipped.join(', '));

      var red = headerColour();
      click($('#accent-choice button[data-choice="green"]'));
      return waitFor('既定色へ戻す', function () { return headerColour() !== red; });
    }).then(function () {
      check('既定色を選び直せる',
        window.localStorage.getItem('mahjongAccent') === 'green' &&
        document.documentElement.getAttribute('data-accent') === 'green');

      // ---- tab icon styles ----
      // Written without assuming which style Config.js defaults to, so that
      // changing DEFAULT_ICONS does not turn this red.
      var initial = document.documentElement.getAttribute('data-icons');
      check('既定のスタイルが最初の描画から効いている', matches(initial), initial);

      click($('#icons-choice button[data-choice="emoji"]'));
      return waitFor('絵文字へ切替', function () { return matches('emoji'); });
    }).then(function () {
      check('絵文字にできる', matches('emoji'));

      click($('#icons-choice button[data-choice="line"]'));
      return waitFor('アイコンへ切替', function () { return matches('line'); });
    }).then(function () {
      check('アイコンにすると絵文字と入れ替わる', matches('line'));
      check('アイコンの選択が端末に記憶される',
        window.localStorage.getItem('mahjongIcons') === 'line');

      click($('#icons-choice button[data-choice="text"]'));
      return waitFor('文字のみへ切替', function () { return matches('text'); });
    }).then(function () {
      check('文字のみにすると両方消える', matches('text'));

      check('文字のみでもタブ名が切れない', clippedTabs().length === 0, clippedTabs().join(', '));

      // Headless Chrome will not go below ~485px wide, so the narrow phones the
      // family actually holds are checked by shrinking the bar itself.
      var nav = $('nav.tabbar');
      var original = nav.style.width;
      nav.style.width = '320px';
      var narrow = clippedTabs();
      nav.style.width = original;
      check('320px幅の端末でもタブ名が切れない', narrow.length === 0, narrow.join(', '));
    });
  }

  // --- statistics chart helpers ---

  /** @returns {string} The chart card's heading. */
  function chartTitle() {
    var svg = $('#stats-body svg.chart');
    return svg ? svg.closest('.card').querySelector('h2').textContent : '';
  }

  /** @returns {string} Every plotted line's points, joined, for comparison. */
  function polylinePoints() {
    return $$('#stats-body svg polyline').map(function (line) {
      return line.getAttribute('points');
    }).join('|');
  }

  /** @returns {number[]} The two axis labels, top one first. */
  function axisLabels() {
    return $$('#stats-body svg text')
      .sort(function (a, b) { return Number(a.getAttribute('y')) - Number(b.getAttribute('y')); })
      .map(function (text) { return parseFloat(text.textContent); });
  }

  // --- statistics table helpers ---

  /**
   * The statistics tab draws two tables. Everything below takes an optional
   * index so a column is always looked up within one of them -- counting header
   * cells across both would point at the wrong cell in the body.
   *
   * @param {number} [table] 0 for the totals, 1 for the detail table.
   * @returns {?HTMLElement}
   */
  function statsTable(table) {
    return $$('#stats-body table')[table || 0];
  }

  /** @param {number} [table] @returns {HTMLElement[]} That table's header cells. */
  function headers(table) {
    var target = statsTable(table);
    return target ? Array.prototype.slice.call(target.querySelectorAll('th')) : [];
  }

  /** @param {string} label @param {number} [table] @returns {?HTMLElement} */
  function header(label, table) {
    return headers(table).filter(function (th) {
      return th.textContent.indexOf(label) === 0;
    })[0];
  }

  /** @returns {string} '▼', '▲' or '' when the column is not sorted on. */
  function sortedOn(label, table) {
    var th = header(label, table);
    if (!th) return 'missing:' + label;
    var arrow = th.textContent.replace(label, '').trim();
    return th.className.indexOf('sorted') >= 0 ? arrow : '';
  }

  /** @param {number} [table] @returns {string[]} The name column, in order. */
  function names(table) {
    var target = statsTable(table);
    if (!target) return [];
    return Array.prototype.map.call(
      target.querySelectorAll('tbody tr td:first-child'),
      function (td) { return td.textContent; });
  }

  /** @returns {number[]} That column's values, in row order. */
  function column(label, table) {
    var index = headers(table).indexOf(header(label, table));
    return Array.prototype.map.call(
      statsTable(table).querySelectorAll('tbody tr'),
      function (tr) { return parseFloat(tr.cells[index].textContent.replace(/[^0-9.+-]/g, '')); });
  }

  function ascending(values) {
    return values.every(function (v, i) { return i === 0 || values[i - 1] <= v; });
  }

  function descending(values) {
    return values.every(function (v, i) { return i === 0 || values[i - 1] >= v; });
  }

  /** @returns {string[]} Labels of tabs whose content does not fit their cell. */
  function clippedTabs() {
    return $$('nav.tabbar button').filter(function (button) {
      return button.scrollWidth > button.clientWidth + 1;
    }).map(function (button) { return button.textContent.trim(); });
  }

  /**
   * Whether the tab bar is showing exactly what the named style calls for.
   * @param {string} style
   * @returns {boolean}
   */
  function matches(style) {
    if (style === 'emoji') return shown('.icon-emoji') && !shown('.icon-line');
    if (style === 'line') return shown('.icon-line') && !shown('.icon-emoji');
    if (style === 'text') return !shown('.icon-line') && !shown('.icon-emoji');
    return false;
  }

  /**
   * Whether the first tab's icon of the given kind is actually rendered.
   * @param {string} selector
   * @returns {boolean}
   */
  function shown(selector) {
    var icon = $('nav.tabbar button ' + selector);
    return !!icon && window.getComputedStyle(icon).display !== 'none';
  }

  /** @returns {string} The header's computed background colour. */
  function headerColour() {
    return window.getComputedStyle($('header')).backgroundColor;
  }

  run().then(finish, function (error) {
    check('シナリオ完走', false, error && error.message);
    finish();
  });
})();
