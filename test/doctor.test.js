import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { runDoctor } from '../src/doctor.js';
import { resolveServicePlistPaths } from '../src/service-manager.js';
import { appendJsonLine, ensureDir } from '../src/utils.js';
import { ensureFile, makeTempDir, removeDir, toBase64Utf8 } from './helpers/temp.js';

const GB = 1024 * 1024 * 1024;

async function exists(targetPath) {
  return fs
    .stat(targetPath)
    .then(() => true)
    .catch(() => false);
}

function resolveRuntimeTarget() {
  const runtimePlatform = process.platform;
  const runtimeArch = process.arch;

  const osTag =
    runtimePlatform === 'win32'
      ? 'windows'
      : runtimePlatform === 'darwin'
        ? 'darwin'
        : runtimePlatform === 'linux'
          ? 'linux'
          : runtimePlatform;

  const archTag =
    runtimeArch === 'x64'
      ? 'x64'
      : runtimeArch === 'arm64'
        ? 'arm64'
        : runtimeArch === 'x86_64'
          ? 'x64'
          : runtimeArch === 'aarch64'
            ? 'arm64'
            : runtimeArch;

  const ext = osTag === 'windows' ? '.exe' : '';
  return {
    targetTag: `${osTag}-${archTag}`,
    binaryName: `wecom-cleaner-core${ext}`,
  };
}

async function writeFakeNativeBinary(filePath, mode = 'ok') {
  const script = `#!/usr/bin/env node
if (process.argv.includes('--ping')) {
  if (${mode === 'ok'}) {
    process.stdout.write(JSON.stringify({ ok: true, engine: 'zig' }));
    process.exit(0);
  }
  if (${mode === 'nonjson'}) {
    process.stdout.write('not-json');
    process.exit(0);
  }
  process.stdout.write('failed');
  process.exit(2);
}
process.exit(0);
`;
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, script, 'utf-8');
  await fs.chmod(filePath, 0o755).catch(() => {});
}

async function writeFakeLaunchctlBin(root) {
  const binDir = path.join(root, 'fake-launchctl-bin');
  const launchctlPath = path.join(binDir, 'launchctl');
  await ensureDir(binDir);
  await fs.writeFile(
    launchctlPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "print" ]]; then
  echo "mock launchctl print: $*" >&2
  exit 0
fi
echo "mock launchctl: $*" >&2
exit 0
`,
    'utf-8'
  );
  await fs.chmod(launchctlPath, 0o755).catch(() => {});
  return binDir;
}

test('runDoctor 在健康场景下返回 pass', async (t) => {
  const root = await makeTempDir('wecom-doctor-pass-');
  t.after(async () => removeDir(root));
  const oldCodexHome = process.env.CODEX_HOME;
  const oldHome = process.env.HOME;
  const oldPath = process.env.PATH;
  process.env.CODEX_HOME = path.join(root, 'codex-home');
  process.env.HOME = root;
  process.env.PATH = `${await writeFakeLaunchctlBin(root)}:${oldPath || ''}`;
  t.after(() => {
    if (oldCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = oldCodexHome;
    }
    if (oldHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = oldHome;
    }
    if (oldPath === undefined) {
      delete process.env.PATH;
      return;
    }
    process.env.PATH = oldPath;
  });

  const target = resolveRuntimeTarget();
  const projectRoot = path.join(root, 'project');
  const dataRoot = path.join(root, 'ContainerData');
  const profilesRoot = path.join(dataRoot, 'Documents', 'Profiles');
  const stateRoot = path.join(root, 'state');
  const recycleRoot = path.join(stateRoot, 'recycle-bin');
  const serviceRecycleRoot = path.join(stateRoot, 'service-recycle-bin');
  const indexPath = path.join(stateRoot, 'index.jsonl');
  const serviceConfigPath = path.join(stateRoot, 'service-config.json');
  const serviceStatePath = path.join(stateRoot, 'service-state.json');
  const externalRoot = path.join(root, 'WXWork_Data_Custom');

  await ensureFile(
    path.join(profilesRoot, 'acc001', 'io_data.json'),
    JSON.stringify({
      user_info: toBase64Utf8('姓名: 张三'),
      corp_info: toBase64Utf8('企业: 示例企业'),
    })
  );
  await ensureFile(path.join(externalRoot, 'WXWork Files', 'Caches', 'Files', '2024-01', 'a.bin'), 'a');
  await ensureFile(path.join(externalRoot, 'WXWork Files', 'File', '2024-01', 'saved.docx'), 'saved');
  await ensureFile(path.join(externalRoot, 'WXWork Files', 'Image', '2024-01', 'saved.png'), 'saved');
  await ensureFile(
    path.join(dataRoot, 'Library', 'Application Support', 'WXDrive', 'sqlite3', 'meta.db'),
    'meta'
  );
  await ensureFile(
    path.join(dataRoot, 'Library', 'Application Support', 'WeMail', 'sqlite', 'mail.db'),
    'mail'
  );
  await ensureFile(
    path.join(dataRoot, 'Library', 'Application Support', 'WeMail', 'load_encrypted'),
    'encrypted'
  );
  await ensureFile(
    path.join(dataRoot, 'Library', 'Application Support', 'CrashReporter', 'crash.plist'),
    'crash'
  );
  await ensureFile(path.join(dataRoot, 'Documents', 'VoipNNModel', 'model.bin'), 'model');
  await ensureFile(path.join(dataRoot, 'Documents', 'local_storage_index.db'), 'index-db');
  await ensureFile(
    path.join(profilesRoot, 'acc001', 'Publishsys', 'pkg', 'component-a', 'tmp', 'archive.zip'),
    'archive'
  );
  await ensureFile(path.join(dataRoot, 'Library', 'HTTPStorages', 'store.bin'), 'http-store');
  await ensureFile(path.join(dataRoot, 'Library', 'WebKit', 'WebsiteData', 'site.bin'), 'wk-site');
  await ensureFile(
    path.join(dataRoot, 'Library', 'Application Support', 'CEF', 'User Data', 'state.json'),
    'cef-state'
  );
  await ensureFile(path.join(dataRoot, 'WeDrive', '企业资料', 'doc.txt'), 'doc');
  await ensureDir(recycleRoot);
  await ensureDir(serviceRecycleRoot);
  await ensureFile(indexPath, '');
  await ensureFile(
    serviceConfigPath,
    JSON.stringify({
      enabled: true,
      retainDays: 180,
      deleteMode: 'service_recycle',
      triggerTimes: ['09:30', '13:30', '18:30'],
    })
  );
  await ensureFile(
    serviceStatePath,
    JSON.stringify({
      lastRunAt: Date.now() - 3600_000,
      lastStatus: 'success',
      lastTriggerSource: 'service_schedule',
    })
  );
  const plistPaths = resolveServicePlistPaths(root);
  await ensureFile(plistPaths.login, 'plist-login');
  await ensureFile(plistPaths.schedule, 'plist-schedule');
  await ensureFile(path.join(process.env.CODEX_HOME, 'skills', 'wecom-cleaner-agent', 'SKILL.md'), '# skill');
  await ensureFile(
    path.join(process.env.CODEX_HOME, 'skills', 'wecom-cleaner-agent', 'version.json'),
    JSON.stringify({
      schemaVersion: 1,
      skillName: 'wecom-cleaner-agent',
      skillVersion: '1.0.0',
      requiredAppVersion: '1.0.0',
    })
  );

  const bundledPath = path.join(projectRoot, 'native', 'bin', target.targetTag, target.binaryName);
  const cachedPath = path.join(stateRoot, 'native-cache', target.targetTag, target.binaryName);
  await writeFakeNativeBinary(bundledPath, 'ok');
  await writeFakeNativeBinary(cachedPath, 'ok');

  await ensureFile(
    path.join(projectRoot, 'native', 'manifest.json'),
    JSON.stringify(
      {
        version: '1.0.0',
        targets: {
          [target.targetTag]: {
            binaryName: target.binaryName,
            sha256: 'demo',
          },
        },
      },
      null,
      2
    )
  );

  const report = await runDoctor({
    config: {
      rootDir: profilesRoot,
      stateRoot,
      recycleRoot,
      serviceRecycleRoot,
      indexPath,
      serviceConfigPath,
      serviceStatePath,
      externalStorageRoots: [externalRoot],
      externalStorageAutoDetect: false,
      recycleRetention: {
        enabled: true,
        maxAgeDays: 30,
        minKeepBatches: 20,
        sizeThresholdGB: 20,
      },
    },
    aliases: {},
    projectRoot,
    appVersion: '1.0.0',
  });

  assert.equal(report.overall, 'pass');
  assert.equal(report.summary.fail, 0);
  assert.equal(report.summary.warn, 0);
  assert.equal(report.metrics.accountCount >= 1, true);
  assert.equal(report.metrics.externalStorageCount >= 1, true);
  assert.equal(report.metrics.serviceInstalled, true);
  assert.equal(report.metrics.externalSavedFileBytes > 0, true);
  assert.equal(report.metrics.externalSavedImageBytes > 0, true);
  assert.equal(report.metrics.publishsysPkgBytes > 0, true);
  assert.equal(report.metrics.publishsysPkgTmpBytes > 0, true);
  assert.equal(report.metrics.publishsysPkgTmpDirCount, 1);
  assert.equal(report.metrics.auxiliarySupportTotalBytes > 0, true);
  assert.equal(report.metrics.auxiliarySupportBytes.wxdrive > 0, true);
  assert.equal(report.metrics.auxiliarySupportBytes.wemail > 0, true);
  assert.equal(report.metrics.auxiliarySupportBytes.cefUserData > 0, true);
  assert.equal(report.metrics.auxiliarySupportBytes.httpStorages > 0, true);
  assert.equal(report.metrics.auxiliarySupportBytes.webkitWebsiteData > 0, true);
  assert.equal(report.metrics.weDriveBusinessDirCount, 1);
  assert.equal(report.metrics.weDriveBusinessBytes > 0, true);
  assert.equal(report.metrics.unmodeledDataRootDirCount, 0);
});

test('runDoctor 在异常场景下返回 fail/warn 并给出建议', async (t) => {
  const root = await makeTempDir('wecom-doctor-warn-');
  t.after(async () => removeDir(root));

  const target = resolveRuntimeTarget();
  const projectRoot = path.join(root, 'project');
  const stateRoot = path.join(root, 'state');
  const recycleRoot = path.join(stateRoot, 'recycle-bin');
  const indexPath = path.join(stateRoot, 'index.jsonl');
  const missingProfilesRoot = path.join(root, 'missing', 'Profiles');

  const bundledPath = path.join(projectRoot, 'native', 'bin', target.targetTag, target.binaryName);
  const cachedPath = path.join(stateRoot, 'native-cache', target.targetTag, target.binaryName);
  await writeFakeNativeBinary(bundledPath, 'nonjson');
  await writeFakeNativeBinary(cachedPath, 'fail');
  await ensureFile(
    path.join(projectRoot, 'native', 'manifest.json'),
    JSON.stringify(
      {
        version: '9.9.9',
        targets: {
          [target.targetTag]: {
            binaryName: target.binaryName,
            sha256: 'demo',
          },
        },
      },
      null,
      2
    )
  );

  const recyclePath = path.join(recycleRoot, 'batch-big', '0001_item');
  const payloadPath = path.join(recyclePath, 'payload.bin');
  await ensureFile(payloadPath, '');
  await fs.truncate(payloadPath, 2 * GB);
  await appendJsonLine(indexPath, {
    action: 'cleanup',
    status: 'success',
    batchId: 'batch-big',
    sourcePath: '/source/big',
    recyclePath,
    sizeBytes: 2 * GB,
    time: Date.now() - 3600_000,
  });

  const report = await runDoctor({
    config: {
      rootDir: missingProfilesRoot,
      stateRoot,
      recycleRoot,
      indexPath,
      externalStorageRoots: [],
      externalStorageAutoDetect: false,
      recycleRetention: {
        enabled: true,
        maxAgeDays: 30,
        minKeepBatches: 1,
        sizeThresholdGB: 1,
      },
    },
    aliases: {},
    projectRoot,
    appVersion: '1.0.0',
  });

  assert.equal(report.overall, 'fail');
  assert.equal(report.summary.fail >= 1, true);
  assert.equal(report.summary.warn >= 1, true);
  assert.equal(report.metrics.recycleOverThreshold, true);
  assert.equal(Array.isArray(report.recommendations), true);
  assert.equal(report.recommendations.length >= 1, true);
});

test('runDoctor 不会在只读巡检时创建缺失回收目录', async (t) => {
  const root = await makeTempDir('wecom-doctor-readonly-');
  t.after(async () => removeDir(root));

  const projectRoot = path.join(root, 'project');
  const profilesRoot = path.join(root, 'ContainerData', 'Documents', 'Profiles');
  const stateRoot = path.join(root, 'state');
  const recycleRoot = path.join(stateRoot, 'recycle-bin');
  const indexPath = path.join(stateRoot, 'index.jsonl');

  await ensureDir(profilesRoot);
  assert.equal(await exists(recycleRoot), false);

  const report = await runDoctor({
    config: {
      rootDir: profilesRoot,
      stateRoot,
      recycleRoot,
      indexPath,
      externalStorageRoots: [],
      externalStorageAutoDetect: false,
      recycleRetention: {
        enabled: true,
        maxAgeDays: 30,
        minKeepBatches: 20,
        sizeThresholdGB: 20,
      },
    },
    aliases: {},
    projectRoot,
    appVersion: '1.0.0',
  });

  assert.equal(Array.isArray(report.checks), true);
  assert.equal(await exists(recycleRoot), false);
});

test('runDoctor 会提示未建模大目录', async (t) => {
  const root = await makeTempDir('wecom-doctor-unmodeled-');
  t.after(async () => removeDir(root));

  const projectRoot = path.join(root, 'project');
  const dataRoot = path.join(root, 'ContainerData');
  const profilesRoot = path.join(dataRoot, 'Documents', 'Profiles');
  const stateRoot = path.join(root, 'state');
  const recycleRoot = path.join(stateRoot, 'recycle-bin');
  const indexPath = path.join(stateRoot, 'index.jsonl');
  const unknownPath = path.join(dataRoot, 'Library', 'Application Support', 'FutureCache', 'payload.bin');

  await ensureDir(profilesRoot);
  await ensureFile(indexPath, '');
  await ensureFile(unknownPath, '');
  await fs.truncate(unknownPath, 256 * 1024 * 1024);

  const report = await runDoctor({
    config: {
      rootDir: profilesRoot,
      stateRoot,
      recycleRoot,
      indexPath,
      externalStorageRoots: [],
      externalStorageAutoDetect: false,
      recycleRetention: {
        enabled: true,
        maxAgeDays: 30,
        minKeepBatches: 20,
        sizeThresholdGB: 20,
      },
    },
    aliases: {},
    projectRoot,
    appVersion: '1.0.0',
  });

  const check = report.checks.find((item) => item.id === 'unmodeled_data_root_dirs');
  assert.ok(check);
  assert.equal(check.status, 'warn');
  assert.match(check.detail, /FutureCache/);
  assert.equal(report.metrics.unmodeledDataRootDirCount, 1);
  assert.equal(report.metrics.unmodeledDataRootBytes, 256 * 1024 * 1024);
});
