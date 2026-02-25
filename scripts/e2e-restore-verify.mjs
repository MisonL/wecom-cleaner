#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { executeCleanup } from '../src/cleanup.js';
import { listRestorableBatches, restoreBatch } from '../src/restore.js';
import { appendJsonLine, ensureDir, pathExists, readJsonLines } from '../src/utils.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`缺少环境变量: ${name}`);
  }
  return String(value).trim();
}

async function writeCaseDir(accountRoot, caseName, marker) {
  const dir = path.join(accountRoot, 'Caches', 'Files', caseName);
  await fs.rm(dir, { recursive: true, force: true });
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, 'payload.txt'), marker, 'utf-8');
  return dir;
}

async function prepareUiBatch({ profileRoot, uiStateRoot }) {
  const accountRoot = path.join(profileRoot, 'acc001');
  const caseName = `restore-ui-${Date.now()}`;
  const src = await writeCaseDir(accountRoot, caseName, 'restore-ui');
  const indexPath = path.join(uiStateRoot, 'index.jsonl');
  const recycleRoot = path.join(uiStateRoot, 'recycle-bin');

  const result = await executeCleanup({
    targets: [
      {
        path: src,
        accountId: 'acc001',
        accountShortId: 'acc001',
        userName: 'e2e-user',
        corpName: 'e2e-corp',
        categoryKey: 'files',
        categoryLabel: '聊天文件',
        monthKey: null,
        sizeBytes: 1,
      },
    ],
    recycleRoot,
    indexPath,
    dryRun: false,
  });

  assert(result.successCount === 1, 'prepare-ui: 预置批次失败');
  console.log(`prepare_restore_ui_batch=${result.batchId}`);
}

async function prepareUiConflictBatch({ profileRoot, uiStateRoot }) {
  const accountRoot = path.join(profileRoot, 'acc001');
  const caseName = `restore-ui-conflict-${Date.now()}`;
  const sourceDir = await writeCaseDir(accountRoot, caseName, 'restore-ui-conflict-original');
  const indexPath = path.join(uiStateRoot, 'index.jsonl');
  const recycleRoot = path.join(uiStateRoot, 'recycle-bin');

  const cleanup = await executeCleanup({
    targets: [
      {
        path: sourceDir,
        accountId: 'acc001',
        accountShortId: 'acc001',
        userName: 'e2e-user',
        corpName: 'e2e-corp',
        categoryKey: 'files',
        categoryLabel: '聊天文件',
        monthKey: null,
        sizeBytes: 1,
      },
    ],
    recycleRoot,
    indexPath,
    dryRun: false,
    scope: 'cleanup_monthly',
  });

  assert(cleanup.successCount === 1, 'prepare-ui-conflict: cleanup 失败');
  await writeCaseDir(accountRoot, caseName, 'restore-ui-conflict-sentinel');

  console.log(`prepare_restore_ui_conflict_batch=${cleanup.batchId}`);
}

async function runConflictCase({ strategy, accountRoot, profileRoot, recycleRoot, indexPath }) {
  const caseName = `restore-${strategy}-${Date.now()}`;
  const sourceDir = await writeCaseDir(accountRoot, caseName, `original-${strategy}`);

  const cleanup = await executeCleanup({
    targets: [
      {
        path: sourceDir,
        accountId: 'acc001',
        accountShortId: 'acc001',
        userName: 'e2e-user',
        corpName: 'e2e-corp',
        categoryKey: 'files',
        categoryLabel: '聊天文件',
        monthKey: null,
        sizeBytes: 1,
      },
    ],
    recycleRoot,
    indexPath,
    dryRun: false,
    scope: 'cleanup_monthly',
  });

  assert(cleanup.successCount === 1, `${strategy}: cleanup successCount 应为 1`);

  const batch = (await listRestorableBatches(indexPath, { recycleRoot })).find(
    (item) => item.batchId === cleanup.batchId
  );
  assert(batch && batch.entries.length === 1, `${strategy}: 未找到可恢复批次`);
  const recyclePath = batch.entries[0].recyclePath;

  await writeCaseDir(accountRoot, caseName, `sentinel-${strategy}`);

  const restore = await restoreBatch({
    batch,
    indexPath,
    onConflict: async () => ({ action: strategy, applyToAll: false }),
    profileRoot,
    extraProfileRoots: [],
    recycleRoot,
    governanceRoot: null,
    extraGovernanceRoots: [],
  });

  if (strategy === 'skip') {
    assert(restore.successCount === 0 && restore.skipCount === 1, 'skip: 恢复统计不符合预期');
    assert(await pathExists(recyclePath), 'skip: recyclePath 应保留');
    const sourceText = await fs.readFile(path.join(sourceDir, 'payload.txt'), 'utf-8');
    assert(sourceText === 'sentinel-skip', 'skip: 源目录内容被意外覆盖');
  }

  if (strategy === 'overwrite') {
    assert(restore.successCount === 1 && restore.skipCount === 0, 'overwrite: 恢复统计不符合预期');
    assert(!(await pathExists(recyclePath)), 'overwrite: recyclePath 应被消费');
    const sourceText = await fs.readFile(path.join(sourceDir, 'payload.txt'), 'utf-8');
    assert(sourceText === 'original-overwrite', 'overwrite: 源目录未恢复为原始内容');
  }

  if (strategy === 'rename') {
    assert(restore.successCount === 1 && restore.skipCount === 0, 'rename: 恢复统计不符合预期');
    const sentinelText = await fs.readFile(path.join(sourceDir, 'payload.txt'), 'utf-8');
    assert(sentinelText === 'sentinel-rename', 'rename: 原路径内容被意外覆盖');
    const parent = path.dirname(sourceDir);
    const base = path.basename(sourceDir);
    const names = await fs.readdir(parent);
    const renamed = names.find((item) => item.startsWith(`${base}.restored-`));
    assert(Boolean(renamed), 'rename: 未找到重命名恢复目录');
    const renamedText = await fs.readFile(path.join(parent, renamed, 'payload.txt'), 'utf-8');
    assert(renamedText === 'original-rename', 'rename: 重命名目录内容不正确');
  }

  return cleanup.batchId;
}

async function runInvalidPathCase({ profileRoot, recycleRoot, indexPath }) {
  const batchId = `restore-invalid-${Date.now()}`;
  const recyclePath = path.join(recycleRoot, batchId, '0001_invalid');
  await ensureDir(recyclePath);
  await fs.writeFile(path.join(recyclePath, 'payload.txt'), 'invalid-case', 'utf-8');

  await appendJsonLine(indexPath, {
    action: 'cleanup',
    time: Date.now(),
    scope: 'cleanup_monthly',
    batchId,
    sourcePath: '/tmp/outside-profile-root-path',
    recyclePath,
    accountId: 'acc001',
    accountShortId: 'acc001',
    userName: 'e2e-user',
    corpName: 'e2e-corp',
    categoryKey: 'files',
    categoryLabel: '聊天文件',
    monthKey: null,
    sizeBytes: 1,
    status: 'success',
    dryRun: false,
  });

  const batch = (await listRestorableBatches(indexPath, { recycleRoot })).find(
    (item) => item.batchId === batchId
  );
  assert(batch && batch.entries.length === 1, 'invalid: 未找到批次');

  const restore = await restoreBatch({
    batch,
    indexPath,
    onConflict: async () => ({ action: 'skip', applyToAll: false }),
    profileRoot,
    extraProfileRoots: [],
    recycleRoot,
    governanceRoot: null,
    extraGovernanceRoots: [],
  });

  assert(restore.skipCount === 1 && restore.successCount === 0, 'invalid: 恢复统计不符合预期');

  const rows = await readJsonLines(indexPath);
  const row = rows
    .filter((item) => item.action === 'restore' && item.batchId === batchId)
    .find((item) => item.status === 'skipped_invalid_path');

  assert(Boolean(row), 'invalid: 未写入 skipped_invalid_path 审计记录');
  assert(
    row.invalid_reason === 'source_outside_profile_root' || row.invalid_reason === 'source_path_unresolvable',
    `invalid: invalid_reason 不符合预期: ${row.invalid_reason}`
  );

  return batchId;
}

async function runFullRestoreVerification({ profileRoot, stateRoot }) {
  const accountRoot = path.join(profileRoot, 'acc001');
  const recycleRoot = path.join(stateRoot, 'custom-recycle');
  const indexPath = path.join(stateRoot, 'index.jsonl');

  await ensureDir(recycleRoot);

  const skipBatchId = await runConflictCase({
    strategy: 'skip',
    accountRoot,
    profileRoot,
    recycleRoot,
    indexPath,
  });

  const overwriteBatchId = await runConflictCase({
    strategy: 'overwrite',
    accountRoot,
    profileRoot,
    recycleRoot,
    indexPath,
  });

  const renameBatchId = await runConflictCase({
    strategy: 'rename',
    accountRoot,
    profileRoot,
    recycleRoot,
    indexPath,
  });

  const invalidBatchId = await runInvalidPathCase({
    profileRoot,
    recycleRoot,
    indexPath,
  });

  console.log(`restore_conflict_skip=PASS batch=${skipBatchId}`);
  console.log(`restore_conflict_overwrite=PASS batch=${overwriteBatchId}`);
  console.log(`restore_conflict_rename=PASS batch=${renameBatchId}`);
  console.log(`restore_invalid_path=PASS batch=${invalidBatchId}`);
}

async function main() {
  const profileRoot = requiredEnv('E2E_PROFILE_ROOT');
  const stateRoot = requiredEnv('E2E_STATE_ROOT');
  const prepareUi = process.argv.includes('--prepare-ui');
  const prepareUiConflict = process.argv.includes('--prepare-ui-conflict');

  if (prepareUi) {
    const uiStateRoot = process.env.E2E_UI_STATE_ROOT
      ? path.resolve(process.env.E2E_UI_STATE_ROOT)
      : path.join(stateRoot, 'state-restore-ui');
    await ensureDir(uiStateRoot);
    await prepareUiBatch({ profileRoot, uiStateRoot });
    return;
  }

  if (prepareUiConflict) {
    const uiStateRoot = process.env.E2E_UI_STATE_ROOT
      ? path.resolve(process.env.E2E_UI_STATE_ROOT)
      : path.join(stateRoot, 'state-restore-ui-conflict');
    await ensureDir(uiStateRoot);
    await prepareUiConflictBatch({ profileRoot, uiStateRoot });
    return;
  }

  await runFullRestoreVerification({ profileRoot, stateRoot });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`restore_verify_failed: ${message}`);
  process.exit(1);
});
