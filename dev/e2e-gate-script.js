/**
 * In-browser scenario for the passcode gate.
 *
 * Runs against an app that already has a passcode set and a browser with no
 * stored one, which is what a family member's first visit looks like. Injected
 * when the page is requested with `?e2e=gate`.
 */
(function () {
  'use strict';

  var PASSCODE = 'kazoku2026';
  var STORAGE_KEY = 'mahjongPasscode';
  var report = [];

  function check(name, condition, detail) {
    report.push({ name: name, pass: !!condition, detail: String(detail == null ? '' : detail) });
  }

  function $(selector) { return document.querySelector(selector); }
  function $$(selector) { return Array.prototype.slice.call(document.querySelectorAll(selector)); }

  function waitFor(label, predicate, maxPolls) {
    var remaining = maxPolls || 200;
    return new Promise(function (resolve, reject) {
      (function poll() {
        var value = null;
        try { value = predicate(); } catch (error) { value = null; }
        if (value) { resolve(value); return; }
        if (--remaining <= 0) { reject(new Error('timeout: ' + label)); return; }
        setTimeout(poll, 50);
      })();
    });
  }

  function setValue(element, value) {
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function gateShown() { return $('#gate').classList.contains('show'); }

  function finish() {
    var pre = document.createElement('pre');
    pre.id = 'e2e-report';
    pre.textContent = JSON.stringify(report, null, 2);
    document.body.appendChild(pre);
    document.title = report.every(function (r) { return r.pass; }) ? 'E2E:PASS' : 'E2E:FAIL';
    fetch('/e2e-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report)
    });
  }

  function run() {
    try { window.localStorage.removeItem(STORAGE_KEY); } catch (error) { /* ignore */ }

    return waitFor('合言葉画面', gateShown).then(function () {
      check('合言葉が設定されていると入力画面が出る', true);
      check('本体のデータは読み込まれていない',
        $$('#day-summary .game-card').length === 0,
        $$('#day-summary .game-card').length);

      setValue($('#gate-pass'), 'chigau-aikotoba');
      $('#gate-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return waitFor('誤り時のエラー表示', function () {
        return $('#gate-error').style.display !== 'none' && textOf('#gate-error');
      });
    }).then(function (message) {
      check('間違った合言葉は弾かれる', /違います/.test(message), message);
      check('弾かれた後も入力画面のまま', gateShown());

      setValue($('#gate-pass'), PASSCODE);
      $('#gate-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return waitFor('認証後のアプリ起動', function () {
        return !gateShown() && $$('#seat-grid .seat-row').length === 4;
      });
    }).then(function () {
      check('正しい合言葉でアプリが開く', true);
      check('認証後にデータが読み込まれる', $$('#day-summary .game-card').length > 0,
        $$('#day-summary .game-card').length);

      var stored = '';
      try { stored = window.localStorage.getItem(STORAGE_KEY) || ''; } catch (error) { /* ignore */ }
      check('合言葉が端末に記憶される', stored === PASSCODE, stored ? '保存あり' : '保存なし');

      // The settings tab should now report the gate as active.
      $('[data-tab="settings"]').click();
      return waitFor('設定タブ', function () { return textOf('#passcode-state'); });
    }).then(function (stateText) {
      check('設定タブに設定済みと表示される', /設定済み/.test(stateText), stateText);
      check('解除ボタンが表示される', $('#btn-passcode-clear').style.display !== 'none');
    });
  }

  function textOf(selector) {
    var el = $(selector);
    return el ? el.textContent : '';
  }

  run().then(finish, function (error) {
    check('シナリオ完走', false, error && error.message);
    finish();
  });
})();
