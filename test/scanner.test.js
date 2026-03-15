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
  const manualSubPath = path.join(manualRoot, 'WXWork Files', 'File');
  const autoRoot = path.join(root, 'Auto-Storage-Root');
  const autoImageOnlyRoot = path.join(root, 'Desktop', 'Auto-Image-Only-Root');
  const fakeRoot = path.join(root, 'Fake-Storage-Root');

  await ensureFile(path.join(profilesRoot, 'placeholder.txt'), 'ok');
  await ensureFile(path.join(builtInRoot, 'WXWork Files', 'Caches', 'Files', '2024-01', 'a.txt'), 'a');
  await ensureFile(path.join(manualRoot, 'WXWork Files', 'Caches', 'Files', '2024-02', 'a.txt'), 'a');
  await ensureFile(path.join(manualRoot, 'WXWork Files', 'File', '2024-02', 'saved.docx'), 'a');
  await ensureFile(path.join(autoRoot, 'WXWork Files', 'Caches', 'Files', '2024-03', 'a.txt'), 'a');
  await ensureFile(path.join(autoImageOnlyRoot, 'WXWork Files', 'Image', '2024-04', 'saved.png'), 'a');
  await ensureFile(path.join(fakeRoot, 'WXWork Files', 'Caches', 'OtherAppCache', 'a.txt'), 'a');

  const first = await detectExternalStorageRoots({
    profilesRoot,
    configuredRoots: [manualSubPath],
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
  assert.equal(first.roots.includes(path.resolve(autoImageOnlyRoot)), true);
  assert.equal(first.roots.includes(path.resolve(fakeRoot)), false);
  assert.equal(first.meta.fromCache, false);
  assert.equal(first.meta.sourceCounts.builtin >= 1, true);
  assert.equal(first.meta.sourceCounts.configured >= 1, true);
  assert.equal(first.meta.sourceCounts.auto >= 1, true);
  assert.equal(first.meta.autoRejectedRootCount, 0);

  const second = await detectExternalStorageRoots({
    profilesRoot,
    configuredRoots: [manualSubPath],
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
  await ensureFile(path.join(externalRoot, 'WXWork Files', 'File', '2024-04', 'saved.docx'), 'saved-file');
  await ensureFile(path.join(externalRoot, 'WXWork Files', 'Image', '2024-04', 'saved.png'), 'saved-image');
  await ensureFile(
    path.join(dataRoot, 'Library', 'Application Support', 'WXDrive', 'crashDumps', 'dump.log'),
    'dump'
  );
  await ensureFile(
    path.join(dataRoot, 'Library', 'Application Support', 'WXDrive', 'sqlite3', 'meta.db'),
    'meta'
  );
  await ensureFile(
    path.join(dataRoot, 'Library', 'Application Support', 'Wedoc', 'cache', 'doc.bin'),
    'doc-cache'
  );
  await ensureFile(
    path.join(dataRoot, 'Library', 'Application Support', 'WeMail', 'cache', 'mail.bin'),
    'mail-cache'
  );
  await ensureFile(
    path.join(dataRoot, 'Library', 'Application Support', 'WeMail', 'sqlite', 'mail.db'),
    'mail-db'
  );
  await ensureFile(
    path.join(dataRoot, 'Library', 'Application Support', 'WeMail', 'load_encrypted'),
    'encrypted'
  );
  await ensureFile(
    path.join(dataRoot, 'Library', 'Application Support', 'WXWork', 'VoipRecords', 'call.log'),
    'call'
  );
  await ensureFile(
    path.join(dataRoot, 'Library', 'Application Support', 'CrashReporter', 'crash.plist'),
    'crash'
  );
  await ensureFile(path.join(dataRoot, 'Documents', 'VoipNNModel', 'model.bin'), 'model');
  await ensureFile(path.join(dataRoot, 'Documents', 'Network', 'netcontext', 'meta.bin'), 'network');
  await ensureFile(path.join(dataRoot, 'Documents', 'local_storage_index.db'), 'index-db');
  await ensureFile(path.join(dataRoot, 'Documents', 'local_en', 'lang.dat'), 'lang');
  await ensureFile(
    path.join(dataRoot, 'Library', 'Application Support', 'CEF', 'User Data', 'State'),
    'cef-state'
  );
  await ensureFile(path.join(dataRoot, 'Library', 'WebKit', 'WebsiteData', 'wk.data'), 'wk');
  await ensureFile(path.join(dataRoot, 'Library', 'HTTPStorages', 'http.data'), 'http');
  await ensureFile(path.join(dataRoot, 'Library', 'Preferences', 'prefs.plist'), 'prefs');
  await ensureFile(path.join(dataRoot, 'Library', 'WecomPrivate', 'private.dat'), 'private');
  await ensureFile(path.join(dataRoot, 'Library', 'Cookies', 'cookies.bin'), 'cookie');
  await ensureFile(
    path.join(dataRoot, 'Library', 'Application Support', 'com.tencent.WeWorkMac', 'state.bin'),
    'state'
  );
  await ensureFile(path.join(dataRoot, 'WeDrive', '企业资料', 'doc.txt'), 'wedrive-doc');
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

  const savedFilesTarget = governance.targets.find(
    (item) => item.targetKey === 'external_wxwork_files_saved_files'
  );
  assert.ok(savedFilesTarget);
  assert.equal(savedFilesTarget.deletable, false);
  assert.equal(savedFilesTarget.tier, 'protected');

  const savedImagesTarget = governance.targets.find(
    (item) => item.targetKey === 'external_wxwork_files_saved_images'
  );
  assert.ok(savedImagesTarget);
  assert.equal(savedImagesTarget.deletable, false);
  assert.equal(savedImagesTarget.tier, 'protected');

  const wxdriveCrash = governance.targets.find((item) => item.targetKey === 'wxdrive_crash_dumps');
  assert.ok(wxdriveCrash);
  assert.equal(wxdriveCrash.deletable, true);
  assert.equal(wxdriveCrash.tier, 'safe');

  const wedocCache = governance.targets.find((item) => item.targetKey === 'wedoc_cache');
  assert.ok(wedocCache);
  assert.equal(wedocCache.deletable, true);
  assert.equal(wedocCache.tier, 'caution');

  const wemailCache = governance.targets.find((item) => item.targetKey === 'wemail_cache');
  assert.ok(wemailCache);
  assert.equal(wemailCache.deletable, true);
  assert.equal(wemailCache.tier, 'caution');

  const wemailSqlite = governance.targets.find((item) => item.targetKey === 'wemail_sqlite');
  assert.ok(wemailSqlite);
  assert.equal(wemailSqlite.deletable, false);
  assert.equal(wemailSqlite.tier, 'protected');

  const voipRecords = governance.targets.find((item) => item.targetKey === 'wxwork_voip_records');
  assert.ok(voipRecords);
  assert.equal(voipRecords.deletable, true);
  assert.equal(voipRecords.tier, 'caution');

  const crashReporter = governance.targets.find((item) => item.targetKey === 'crash_reporter');
  assert.ok(crashReporter);
  assert.equal(crashReporter.deletable, true);
  assert.equal(crashReporter.tier, 'safe');

  const voipModel = governance.targets.find((item) => item.targetKey === 'documents_voip_nn_model');
  assert.ok(voipModel);
  assert.equal(voipModel.deletable, true);
  assert.equal(voipModel.tier, 'caution');

  const networkMeta = governance.targets.find((item) => item.targetKey === 'documents_network');
  assert.ok(networkMeta);
  assert.equal(networkMeta.deletable, true);
  assert.equal(networkMeta.tier, 'caution');

  const localStorageIndex = governance.targets.find(
    (item) => item.targetKey === 'documents_local_storage_index'
  );
  assert.ok(localStorageIndex);
  assert.equal(localStorageIndex.deletable, false);
  assert.equal(localStorageIndex.tier, 'protected');

  const localEn = governance.targets.find((item) => item.targetKey === 'documents_local_en');
  assert.ok(localEn);
  assert.equal(localEn.deletable, false);
  assert.equal(localEn.tier, 'protected');

  const cefUserData = governance.targets.find((item) => item.targetKey === 'cef_user_data');
  assert.ok(cefUserData);
  assert.equal(cefUserData.deletable, false);
  assert.equal(cefUserData.tier, 'protected');

  const websiteData = governance.targets.find((item) => item.targetKey === 'webkit_website_data');
  assert.ok(websiteData);
  assert.equal(websiteData.deletable, true);
  assert.equal(websiteData.tier, 'caution');

  const httpStorages = governance.targets.find((item) => item.targetKey === 'library_http_storages');
  assert.ok(httpStorages);
  assert.equal(httpStorages.deletable, true);
  assert.equal(httpStorages.tier, 'caution');

  const preferences = governance.targets.find((item) => item.targetKey === 'library_preferences');
  assert.ok(preferences);
  assert.equal(preferences.deletable, false);
  assert.equal(preferences.tier, 'protected');

  const wecomPrivate = governance.targets.find((item) => item.targetKey === 'library_wecom_private');
  assert.ok(wecomPrivate);
  assert.equal(wecomPrivate.deletable, false);
  assert.equal(wecomPrivate.tier, 'protected');

  const cookies = governance.targets.find((item) => item.targetKey === 'library_cookies');
  assert.ok(cookies);
  assert.equal(cookies.deletable, false);
  assert.equal(cookies.tier, 'protected');

  const appSupportWeWorkMac = governance.targets.find((item) => item.targetKey === 'appsupport_weworkmac');
  assert.ok(appSupportWeWorkMac);
  assert.equal(appSupportWeWorkMac.deletable, false);
  assert.equal(appSupportWeWorkMac.tier, 'protected');

  const wemailLoadEncrypted = governance.targets.find((item) => item.targetKey === 'wemail_load_encrypted');
  assert.ok(wemailLoadEncrypted);
  assert.equal(wemailLoadEncrypted.deletable, false);
  assert.equal(wemailLoadEncrypted.tier, 'protected');

  const weDriveBusinessRoot = governance.targets.find((item) => item.targetKey === 'wedrive_business_root');
  assert.ok(weDriveBusinessRoot);
  assert.equal(weDriveBusinessRoot.deletable, false);
  assert.equal(weDriveBusinessRoot.tier, 'protected');
});
