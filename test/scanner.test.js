import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  analyzeCacheFootprint,
  collectAvailableMonths,
  collectCleanupTargets,
  detectExternalStorageRoots,
  discoverAccounts,
  scanSpaceGovernanceTargets,
} from '../src/scanner.js';
import { ensureFile, makeTempDir, removeDir, toBase64Utf8 } from './helpers/temp.js';

async function createAccount(profilesRoot, id, options = {}) {
  const profilePath = path.join(profilesRoot, id);
  await fs.mkdir(profilePath, { recursive: true });

  const ioData = {
    user_info: toBase64Utf8(options.userText || '姓名: 张三\n邮箱: zhangsan@example.com'),
    corp_info: toBase64Utf8(options.corpText || '企业: 示例科技有限公司'),
  };
  await ensureFile(path.join(profilePath, 'io_data.json'), `${JSON.stringify(ioData)}\n`);

  for (const month of options.fileMonths || []) {
    await ensureFile(path.join(profilePath, 'Caches', 'Files', month, 'payload.txt'), `files-${id}-${month}`);
  }
  for (const month of options.imageMonths || []) {
    await ensureFile(
      path.join(profilePath, 'Caches', 'Images', month, 'payload.txt'),
      `images-${id}-${month}`
    );
  }

  await ensureFile(path.join(profilePath, 'Caches', 'Files', 'not-a-month', 'payload.txt'), 'non-month-dir');
  await ensureFile(path.join(profilePath, 'Caches', 'Files', 'root.bin'), 'root-file');

  return profilePath;
}

test('discoverAccounts 能识别账号并应用别名覆盖', async (t) => {
  const root = await makeTempDir('wecom-scanner-accounts-');
  t.after(async () => removeDir(root));

  const profilesRoot = path.join(
    root,
    'Library',
    'Containers',
    'com.tencent.WeWorkMac',
    'Data',
    'Documents',
    'Profiles'
  );

  await createAccount(profilesRoot, 'acc001', { fileMonths: ['2024-01'] });
  await createAccount(profilesRoot, 'acc002', { fileMonths: ['2024-02'] });
  await ensureFile(
    path.join(profilesRoot, 'setting.json'),
    `${JSON.stringify({ CurrentProfile: 'acc002' })}\n`
  );

  const accounts = await discoverAccounts(profilesRoot, {
    acc001: { userName: '别名用户', corpName: '别名企业' },
  });

  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].id, 'acc002');
  const acc001 = accounts.find((item) => item.id === 'acc001');
  assert.equal(acc001.userName, '别名用户');
  assert.equal(acc001.corpName, '别名企业');
});

test('detectExternalStorageRoots 支持内置/手动/自动探测与缓存', async (t) => {
  const root = await makeTempDir('wecom-scanner-external-');
  t.after(async () => removeDir(root));

  const profilesRoot = path.join(
    root,
    'Library',
    'Containers',
    'com.tencent.WeWorkMac',
    'Data',
    'Documents',
    'Profiles'
  );

  const builtInRoot = path.join(root, 'Library', 'Containers', 'com.tencent.WeWorkMac', 'Data', 'Documents');
  const manualRoot = path.join(root, 'Custom-Manual-Storage');
  const autoRoot = path.join(root, 'Auto-Storage-Root');

  await ensureFile(path.join(profilesRoot, 'placeholder.txt'), 'ok');
  await ensureFile(path.join(builtInRoot, 'WXWork Files', 'Caches', 'Files', '2024-01', 'a.txt'), 'a');
  await ensureFile(path.join(manualRoot, 'WXWork Files', 'Caches', 'Files', '2024-02', 'a.txt'), 'a');
  await ensureFile(path.join(autoRoot, 'WXWork Files', 'Caches', 'Files', '2024-03', 'a.txt'), 'a');

  const first = await detectExternalStorageRoots({
    profilesRoot,
    configuredRoots: [manualRoot],
    autoDetect: true,
    searchBaseRoots: [root],
    searchMaxDepth: 6,
    searchVisitLimit: 2000,
    returnMeta: true,
    cacheTtlMs: 30_000,
  });

  assert.equal(first.roots.includes(path.resolve(builtInRoot)), true);
  assert.equal(first.roots.includes(path.resolve(manualRoot)), true);
  assert.equal(first.roots.includes(path.resolve(autoRoot)), true);
  assert.equal(first.meta.fromCache, false);
  assert.equal(first.meta.sourceCounts.builtin >= 1, true);
  assert.equal(first.meta.sourceCounts.configured >= 1, true);
  assert.equal(first.meta.sourceCounts.auto >= 1, true);

  const second = await detectExternalStorageRoots({
    profilesRoot,
    configuredRoots: [manualRoot],
    autoDetect: true,
    searchBaseRoots: [root],
    searchMaxDepth: 6,
    searchVisitLimit: 2000,
    returnMeta: true,
    cacheTtlMs: 30_000,
  });

  assert.equal(second.meta.fromCache, true);
});

test('月份扫描、清理目标扫描、分析汇总与全量治理可工作', async (t) => {
  const root = await makeTempDir('wecom-scanner-flow-');
  t.after(async () => removeDir(root));

  const dataRoot = path.join(root, 'Library', 'Containers', 'com.tencent.WeWorkMac', 'Data');
  const profilesRoot = path.join(dataRoot, 'Documents', 'Profiles');
  const externalRoot = path.join(root, 'My-WeCom-Storage');

  await createAccount(profilesRoot, 'acc001', {
    fileMonths: ['2024-01', '2024-03'],
    imageMonths: ['2024-02'],
  });
  await createAccount(profilesRoot, 'acc002', { fileMonths: ['2024-02'] });

  await ensureFile(
    path.join(externalRoot, 'WXWork Files', 'Caches', 'Files', '2024-04', 'payload.txt'),
    'ext-file'
  );
  await ensureFile(path.join(dataRoot, 'tmp', 'large.bin'), Buffer.alloc(2 * 1024 * 1024));

  const oldTime = new Date(Date.now() - 10 * 24 * 3600 * 1000);
  await fs.utimes(path.join(dataRoot, 'tmp'), oldTime, oldTime);

  const accounts = await discoverAccounts(profilesRoot, {});
  const months = await collectAvailableMonths(accounts, ['acc001'], ['files'], [externalRoot]);
  assert.deepEqual(months, ['2024-01', '2024-03', '2024-04']);

  const cleanupScan = await collectCleanupTargets({
    accounts,
    selectedAccountIds: ['acc001'],
    categoryKeys: ['files'],
    monthFilters: ['2024-01', '2024-04'],
    includeNonMonthDirs: true,
    externalStorageRoots: [externalRoot],
    nativeCorePath: null,
  });

  assert.equal(cleanupScan.targets.length >= 3, true);
  assert.equal(cleanupScan.engineUsed, 'node');

  const analysis = await analyzeCacheFootprint({
    accounts,
    selectedAccountIds: ['acc001'],
    categoryKeys: ['files'],
    externalStorageRoots: [externalRoot],
    nativeCorePath: null,
  });

  assert.equal(analysis.totalBytes > 0, true);
  assert.equal(analysis.accountsSummary.length >= 1, true);
  assert.equal(analysis.categoriesSummary.length >= 1, true);
  assert.equal(
    analysis.monthsSummary.some((row) => row.monthKey === '非月份目录'),
    true
  );

  const governance = await scanSpaceGovernanceTargets({
    accounts,
    selectedAccountIds: [],
    rootDir: profilesRoot,
    externalStorageRoots: [externalRoot],
    nativeCorePath: null,
    autoSuggest: {
      sizeThresholdMB: 1,
      idleDays: 1,
    },
  });

  const tmpTarget = governance.targets.find((item) => item.targetKey === 'container_tmp');
  assert.ok(tmpTarget);
  assert.equal(tmpTarget.suggested, true);

  const externalTarget = governance.targets.find((item) => item.targetKey === 'external_wxwork_files_caches');
  assert.ok(externalTarget);
  assert.equal(externalTarget.tier, 'caution');
});
