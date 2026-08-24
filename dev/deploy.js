#!/usr/bin/env node
/**
 * Pushes the sources and updates the live web app in one step.
 *
 * `clasp push` only saves the code into the Apps Script project; a deployed web
 * app keeps serving the version it was created from. Forgetting the second step
 * looks exactly like the code not having changed, so the two belong together.
 *
 * Usage:
 *   node dev/deploy.js ["説明"] [--dry-run]
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CLASP = path.join(ROOT, 'node_modules', '.bin', 'clasp');

/**
 * Where the deployment id is remembered.
 *
 * Kept out of Git: the id *is* the public URL
 * (https://script.google.com/macros/s/<id>/exec), so committing it would publish
 * the app's address.
 */
const CONFIG_PATH = path.join(ROOT, '.clasp-deployment.json');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const description = argv.filter((arg) => !arg.startsWith('--'))[0];

/**
 * Runs clasp and returns its output.
 * @param {string[]} args
 * @returns {string}
 */
function clasp(args) {
  return execFileSync(CLASP, args, { cwd: ROOT, encoding: 'utf8' });
}

/**
 * Reads the remembered deployment id, if any.
 * @returns {string} Empty string when not configured yet.
 */
function readDeploymentId() {
  if (!fs.existsSync(CONFIG_PATH)) return '';
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).deploymentId || '';
  } catch (error) {
    throw new Error(`${path.basename(CONFIG_PATH)} を読み取れません: ${error.message}`);
  }
}

/**
 * Finds the deployment to update by asking Apps Script.
 *
 * The @HEAD entry is the editor's "test deployment" and always serves the latest
 * code, so it is never the one to update.
 *
 * @returns {string}
 */
function discoverDeploymentId() {
  const output = clasp(['deployments']);
  const deployments = Array.from(output.matchAll(/^- (\S+) @(\S+)/gm))
    .map((match) => ({ id: match[1], version: match[2] }))
    .filter((entry) => entry.version !== 'HEAD');

  if (!deployments.length) {
    throw new Error(
      'デプロイが見つかりません。先にGASエディタで「新しいデプロイ」を作成してください。');
  }
  if (deployments.length > 1) {
    const list = deployments.map((entry) => `  ${entry.id} (@${entry.version})`).join('\n');
    throw new Error(
      `デプロイが複数あります。更新したいものを ${path.basename(CONFIG_PATH)} に\n` +
      `{"deploymentId": "..."} の形で記録してください:\n${list}`);
  }
  return deployments[0].id;
}

function main() {
  let deploymentId = readDeploymentId();
  if (!deploymentId) {
    deploymentId = discoverDeploymentId();
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ deploymentId }, null, 2) + '\n');
    console.log(`デプロイIDを ${path.basename(CONFIG_PATH)} に記録しました。`);
  }

  // A timestamp beats no description at all when looking back at the version list.
  // sv-SE formats as 'YYYY-MM-DD HH:mm:ss' in local time, unlike toISOString().
  const label = description || `update ${new Date().toLocaleString('sv-SE').slice(0, 16)}`;

  if (dryRun) {
    console.log(`[dry-run] clasp push -f`);
    console.log(`[dry-run] clasp deploy -i ${deploymentId} -d "${label}"`);
    return;
  }

  console.log('コードをアップロードしています…');
  console.log(clasp(['push', '-f']).trim());

  console.log('\nデプロイを更新しています…');
  console.log(clasp(['deploy', '-i', deploymentId, '-d', label]).trim());

  console.log(`\n完了しました。URLは変わりません:`);
  console.log(`  https://script.google.com/macros/s/${deploymentId}/exec`);
}

try {
  main();
} catch (error) {
  console.error(`\nデプロイに失敗しました: ${error.message}`);
  process.exit(1);
}
