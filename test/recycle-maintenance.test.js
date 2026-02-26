import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { appendJsonLine, pathExists, readJsonLines } from '../src/utils.js';
import {
  collectRecycleStats,
  maintainRecycleBin,
  normalizeRecycleRetention,
  selectBatchesForMaintenance,
} from '../src/recycle-maintenance.js';
import { ensureFile, makeTempDir, removeDir } from './helpers/temp.js';

const DAY_MS = 24 * 3600 * 1000;
const GB = 1024 * 1024 * 1024;

async function createBatch({ recycleRoot, indexPath, batchId, ageDays = 1, sizeBytes = 1024 }) {
  const recyclePath = path.join(recycleRoot, batchId, '0001_item');
  const payloadPath = path.join(recyclePath, 'payload.bin');
  await ensureFile(payloadPath, '');
  await fs.truncate(payloadPath, sizeBytes);

  await appendJsonLine(indexPath, {
    action: 'cleanup',
    status: 'success',
    batchId,
    scope: 'cleanup_monthly',
    sourcePath: `/source/${batchId}`,
    recyclePath,
    sizeBytes,
    time: Date.now() - ageDays * DAY_MS,
  });
}

test('normalizeRecycleRetention 能兜底并规范字段', () => {
  const normalized = normalizeRecycleRetention(
    {
      enabled: true,
      maxAgeDays: 'bad',
      minKeepBatches: 0,
      sizeThresholdGB: '3',
      lastRunAt: '123',
    },
    {
      enabled: false,
      maxAgeDays: 40,
      minKeepBatches: 6,
      sizeThresholdGB: 8,
      lastRunAt: 0,
    }
  );

  assert.equal(normalized.enabled, true);
  assert.equal(normalized.maxAgeDays, 40);
  assert.equal(normalized.minKeepBatches, 6);
  assert.equal(normalized.sizeThresholdGB, 3);
  assert.equal(normalized.lastRunAt, 123);
});

test('selectBatchesForMaintenance 会按年龄与容量联合挑选候选批次', () => {
  const now = Date.now();
  const batches = [
    { batchId: 'new', firstTime: now - DAY_MS, totalBytes: 9 * GB },
    { batchId: 'mid', firstTime: now - 5 * DAY_MS, totalBytes: 9 * GB },
    { batchId: 'old', firstTime: now - 45 * DAY_MS, totalBytes: 1 * GB },
  ];
  const policy = normalizeRecycleRetention({
    enabled: true,
    maxAgeDays: 30,
    minKeepBatches: 1,
    sizeThresholdGB: 10,
  });

  const selected = selectBatchesForMaintenance(batches, policy, now);
  assert.equal(selected.candidates.length, 2);
  assert.equal(selected.keepRecent.length, 1);
  assert.equal(selected.keepRecent[0].batchId, 'new');
  assert.equal(
    selected.candidates.some((item) => item.batchId === 'old' && item.selectedBy === 'age'),
    true
  );
  assert.equal(
    selected.candidates.some((item) => item.batchId === 'mid' && item.selectedBy === 'size'),
    true
  );
  assert.equal(selected.estimatedAfterBytes <= selected.thresholdBytes, true);
});

test('maintainRecycleBin 支持 disabled/no-candidate/dry-run/real 清理路径', async (t) => {
  const root = await makeTempDir('wecom-recycle-maintain-');
  t.after(async () => removeDir(root));

  const recycleRoot = path.join(root, 'recycle-bin');
  const indexPath = path.join(root, 'index.jsonl');

  await createBatch({
    recycleRoot,
    indexPath,
    batchId: 'batch-new',
    ageDays: 1,
    sizeBytes: 2048,
  });
  await createBatch({
    recycleRoot,
    indexPath,
    batchId: 'batch-old',
    ageDays: 60,
    sizeBytes: 4096,
  });

  const disabledResult = await maintainRecycleBin({
    indexPath,
    recycleRoot,
    policy: {
      enabled: false,
      maxAgeDays: 30,
      minKeepBatches: 0,
      sizeThresholdGB: 1,
    },
    dryRun: true,
  });
  assert.equal(disabledResult.status, 'skipped_disabled');

  const noCandidateResult = await maintainRecycleBin({
    indexPath,
    recycleRoot,
    policy: {
      enabled: true,
      maxAgeDays: 365,
      minKeepBatches: 20,
      sizeThresholdGB: 20,
    },
    dryRun: true,
  });
  assert.equal(noCandidateResult.status, 'skipped_no_candidate');

  const dryRunResult = await maintainRecycleBin({
    indexPath,
    recycleRoot,
    policy: {
      enabled: true,
      maxAgeDays: 30,
      minKeepBatches: 1,
      sizeThresholdGB: 20,
    },
    dryRun: true,
  });
  assert.equal(dryRunResult.status, 'dry_run');
  assert.equal(dryRunResult.deletedBatches >= 1, true);
  assert.equal(await pathExists(path.join(recycleRoot, 'batch-old')), true);

  const realResult = await maintainRecycleBin({
    indexPath,
    recycleRoot,
    policy: {
      enabled: true,
      maxAgeDays: 30,
      minKeepBatches: 1,
      sizeThresholdGB: 20,
    },
    dryRun: false,
  });
  assert.equal(realResult.status, 'success');
  assert.equal(realResult.deletedBatches >= 1, true);
  assert.equal(await pathExists(path.join(recycleRoot, 'batch-old')), false);

  const stats = await collectRecycleStats({ indexPath, recycleRoot });
  assert.equal(stats.totalBatches >= 0, true);

  const rows = await readJsonLines(indexPath);
  const maintainRows = rows.filter((row) => row.action === 'recycle_maintain');
  assert.equal(maintainRows.length >= 4, true);
  assert.equal(
    maintainRows.some((row) => row.status === 'dry_run'),
    true
  );
  assert.equal(
    maintainRows.some((row) => row.status === 'success'),
    true
  );
});
