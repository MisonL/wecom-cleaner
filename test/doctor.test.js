import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { runDoctor } from '../src/doctor.js';
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

test('runDoctor 在健康场景下返回 pass', async (t) => {
  const root = await makeTempDir('wecom-doctor-pass-');
  t.after(async () => removeDir(root));

  const target = resolveRuntimeTarget();
  const projectRoot = path.join(root, 'project');
  const dataRoot = path.join(root, 'ContainerData');
  const profilesRoot = path.join(dataRoot, 'Documents', 'Profiles');
  const stateRoot = path.join(root, 'state');
  const recycleRoot = path.join(stateRoot, 'recycle-bin');
  const indexPath = path.join(stateRoot, 'index.jsonl');
  const externalRoot = path.join(root, 'WXWork_Data_Custom');

  await ensureFile(
    path.join(profilesRoot, 'acc001', 'io_data.json'),
    JSON.stringify({
      user_info: toBase64Utf8('姓名: 张三'),
      corp_info: toBase64Utf8('企业: 示例企业'),
    })
  );
  await ensureFile(path.join(externalRoot, 'WXWork Files', 'Caches', 'Files', '2024-01', 'a.bin'), 'a');
  await ensureDir(recycleRoot);
  await ensureFile(indexPath, '');

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
      indexPath,
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
