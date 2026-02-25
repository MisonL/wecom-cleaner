import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { listRestorableBatches, restoreBatch } from '../src/restore.js';
import { appendJsonLine, ensureDir, pathExists, readJsonLines } from '../src/utils.js';
import { ensureFile, makeTempDir, removeDir } from './helpers/temp.js';

async function buildBatchFixture(root, strategy) {
  const profileRoot = path.join(root, 'Profiles');
  const recycleRoot = path.join(root, 'state', 'recycle-bin');
  const indexPath = path.join(root, 'state', 'index.jsonl');

  const sourcePath = path.join(profileRoot, 'acc001', 'Caches', 'Files', `${strategy}-case`);
  const recyclePath = path.join(recycleRoot, `batch-${strategy}`, '0001_case');

  await ensureFile(path.join(sourcePath, 'payload.txt'), `sentinel-${strategy}`);
  await ensureFile(path.join(recyclePath, 'payload.txt'), `original-${strategy}`);

  const entry = {
    action: 'cleanup',
    time: Date.now(),
    scope: 'cleanup_monthly',
    batchId: `batch-${strategy}`,
    sourcePath,
    recyclePath,
    accountId: 'acc001',
    accountShortId: 'acc001',
    userName: '用户A',
    corpName: '企业A',
    categoryKey: 'files',
    categoryLabel: '聊天文件',
    monthKey: '2024-01',
    sizeBytes: 16,
    status: 'success',
    dryRun: false,
  };

  await appendJsonLine(indexPath, entry);

  return {
    batch: {
      batchId: entry.batchId,
      firstTime: entry.time,
      totalBytes: entry.sizeBytes,
      entries: [entry],
    },
    profileRoot,
    recycleRoot,
    indexPath,
    sourcePath,
    recyclePath,
  };
}

test('listRestorableBatches 能过滤已恢复与缺失项', async (t) => {
  const root = await makeTempDir('wecom-restore-list-');
  t.after(async () => removeDir(root));

  const recycleRoot = path.join(root, 'recycle-bin');
  const indexPath = path.join(root, 'index.jsonl');
  const activeRecycle = path.join(recycleRoot, 'batch-2', '0001_keep');
  const restoredRecycle = path.join(recycleRoot, 'batch-1', '0001_done');

  await ensureFile(path.join(activeRecycle, 'payload.txt'), 'keep');
  await ensureFile(path.join(restoredRecycle, 'payload.txt'), 'restored');

  await appendJsonLine(indexPath, {
    action: 'cleanup',
    status: 'success',
    batchId: 'batch-1',
    sourcePath: '/tmp/a',
    recyclePath: restoredRecycle,
    sizeBytes: 1,
    time: Date.now() - 10,
  });

  await appendJsonLine(indexPath, {
    action: 'restore',
    status: 'success',
    batchId: 'batch-1',
    sourcePath: '/tmp/a',
    recyclePath: restoredRecycle,
    time: Date.now() - 5,
  });

  await appendJsonLine(indexPath, {
    action: 'cleanup',
    status: 'success',
    batchId: 'batch-2',
    sourcePath: '/tmp/b',
    recyclePath: activeRecycle,
    sizeBytes: 2,
    time: Date.now(),
  });

  const batches = await listRestorableBatches(indexPath, { recycleRoot });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].batchId, 'batch-2');
  assert.equal(batches[0].entries.length, 1);
});

test('restoreBatch 冲突策略: skip/overwrite/rename', async (t) => {
  const root = await makeTempDir('wecom-restore-conflict-');
  t.after(async () => removeDir(root));

  for (const strategy of ['skip', 'overwrite', 'rename']) {
    const fixture = await buildBatchFixture(root, strategy);

    const summary = await restoreBatch({
      batch: fixture.batch,
      indexPath: fixture.indexPath,
      profileRoot: fixture.profileRoot,
      recycleRoot: fixture.recycleRoot,
      governanceRoot: null,
      onConflict: async () => ({ action: strategy, applyToAll: false }),
    });

    if (strategy === 'skip') {
      assert.equal(summary.skipCount, 1);
      assert.equal(await pathExists(fixture.recyclePath), true);
      const sourceText = await fs.readFile(path.join(fixture.sourcePath, 'payload.txt'), 'utf-8');
      assert.equal(sourceText, 'sentinel-skip');
    }

    if (strategy === 'overwrite') {
      assert.equal(summary.successCount, 1);
      assert.equal(await pathExists(fixture.recyclePath), false);
      const sourceText = await fs.readFile(path.join(fixture.sourcePath, 'payload.txt'), 'utf-8');
      assert.equal(sourceText, 'original-overwrite');
    }

    if (strategy === 'rename') {
      assert.equal(summary.successCount, 1);
      const sentinelText = await fs.readFile(path.join(fixture.sourcePath, 'payload.txt'), 'utf-8');
      assert.equal(sentinelText, 'sentinel-rename');

      const parent = path.dirname(fixture.sourcePath);
      const all = await fs.readdir(parent);
      const renamed = all.find((item) => item.startsWith(`${path.basename(fixture.sourcePath)}.restored-`));
      assert.ok(renamed);
      const renamedText = await fs.readFile(path.join(parent, renamed, 'payload.txt'), 'utf-8');
      assert.equal(renamedText, 'original-rename');
    }
  }
});

test('restoreBatch 会拦截越界恢复并写入审计', async (t) => {
  const root = await makeTempDir('wecom-restore-invalid-');
  t.after(async () => removeDir(root));

  const profileRoot = path.join(root, 'Profiles');
  const recycleRoot = path.join(root, 'state', 'recycle-bin');
  const indexPath = path.join(root, 'state', 'index.jsonl');

  await fs.mkdir(profileRoot, { recursive: true });
  const recyclePath = path.join(recycleRoot, 'batch-invalid', '0001_case');
  await ensureDir(recyclePath);
  await ensureFile(path.join(recyclePath, 'payload.txt'), 'invalid');

  const outsideSource = path.join(root, 'outside', 'payload');
  const batch = {
    batchId: 'batch-invalid',
    firstTime: Date.now(),
    totalBytes: 1,
    entries: [
      {
        batchId: 'batch-invalid',
        scope: 'cleanup_monthly',
        sourcePath: outsideSource,
        recyclePath,
        sizeBytes: 1,
      },
    ],
  };

  const summary = await restoreBatch({
    batch,
    indexPath,
    profileRoot,
    recycleRoot,
    governanceRoot: null,
  });

  assert.equal(summary.skipCount, 1);

  const rows = await readJsonLines(indexPath);
  const record = rows.find((row) => row.action === 'restore' && row.status === 'skipped_invalid_path');
  assert.ok(record);
  assert.equal(record.invalid_reason, 'source_outside_profile_root');
});
