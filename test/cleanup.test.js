import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { executeCleanup } from '../src/cleanup.js';
import { pathExists, readJsonLines } from '../src/utils.js';
import { ensureFile, makeTempDir, removeDir } from './helpers/temp.js';

test('executeCleanup dry-run 不移动文件但记录审计', async (t) => {
  const root = await makeTempDir('wecom-cleanup-dry-');
  t.after(async () => removeDir(root));

  const source = path.join(root, 'source-a');
  const recycleRoot = path.join(root, 'recycle-bin');
  const indexPath = path.join(root, 'index.jsonl');

  await ensureFile(path.join(source, 'payload.txt'), 'hello');

  const result = await executeCleanup({
    targets: [
      {
        path: source,
        accountId: 'acc001',
        accountShortId: 'acc001',
        userName: '用户A',
        corpName: '企业A',
        categoryKey: 'files',
        categoryLabel: '聊天文件',
        monthKey: '2024-01',
        sizeBytes: 5,
      },
    ],
    recycleRoot,
    indexPath,
    dryRun: true,
  });

  assert.equal(result.successCount, 1);
  assert.equal(await pathExists(source), true);

  const rows = await readJsonLines(indexPath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'dry_run');
  assert.equal(rows[0].recyclePath, null);
});

test('executeCleanup 真删模式支持策略跳过、缺失跳过和移动回收', async (t) => {
  const root = await makeTempDir('wecom-cleanup-real-');
  t.after(async () => removeDir(root));

  const sourceSkip = path.join(root, 'source-skip');
  const sourceMove = path.join(root, 'source-move');
  const sourceMissing = path.join(root, 'source-missing');
  const recycleRoot = path.join(root, 'recycle-bin');
  const indexPath = path.join(root, 'index.jsonl');

  await ensureFile(path.join(sourceSkip, 'payload.txt'), 'skip');
  await ensureFile(path.join(sourceMove, 'payload.txt'), 'move');

  const targets = [
    {
      path: sourceSkip,
      accountId: 'acc001',
      accountShortId: 'acc001',
      userName: '用户A',
      corpName: '企业A',
      categoryKey: 'wwsecurity',
      categoryLabel: '受保护截图缓存',
      monthKey: '2024-01',
      sizeBytes: 4,
      tier: 'caution',
    },
    {
      path: sourceMissing,
      accountId: 'acc001',
      accountShortId: 'acc001',
      userName: '用户A',
      corpName: '企业A',
      categoryKey: 'files',
      categoryLabel: '聊天文件',
      monthKey: '2024-01',
      sizeBytes: 1,
    },
    {
      path: sourceMove,
      accountId: 'acc001',
      accountShortId: 'acc001',
      userName: '用户A',
      corpName: '企业A',
      categoryKey: 'files',
      categoryLabel: '聊天文件',
      monthKey: '2024-02',
      sizeBytes: 4,
    },
  ];

  const result = await executeCleanup({
    targets,
    recycleRoot,
    indexPath,
    dryRun: false,
    shouldSkip: async (target) => (target.categoryKey === 'wwsecurity' ? 'skipped_policy_protected' : null),
  });

  assert.equal(result.successCount, 1);
  assert.equal(result.skippedCount, 2);
  assert.equal(result.failedCount, 0);
  assert.equal(result.reclaimedBytes, 4);

  const rows = await readJsonLines(indexPath);
  assert.equal(rows.length, 3);
  assert.equal(
    rows.some((row) => row.status === 'skipped_policy_protected'),
    true
  );
  assert.equal(
    rows.some((row) => row.status === 'skipped_missing_source'),
    true
  );

  const moved = rows.find((row) => row.status === 'success');
  assert.ok(moved);
  assert.equal(await pathExists(sourceMove), false);
  assert.equal(await pathExists(moved.recyclePath), true);

  const movedContent = await fs.readFile(path.join(moved.recyclePath, 'payload.txt'), 'utf-8');
  assert.equal(movedContent, 'move');
});
