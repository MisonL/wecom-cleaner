import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { detectNativeCore } from '../src/native-bridge.js';
import { ensureDir } from '../src/utils.js';
import { makeTempDir, removeDir } from './helpers/temp.js';

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
  process.stdout.write('bad');
  process.exit(1);
}
process.exit(0);
`;

  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, script, 'utf-8');
  await fs.chmod(filePath, 0o755).catch(() => {});
}

test('detectNativeCore 优先使用随包 Zig 核心', async (t) => {
  const root = await makeTempDir('wecom-native-bundled-');
  t.after(async () => removeDir(root));

  const target = resolveRuntimeTarget();
  const bundledPath = path.join(root, 'native', 'bin', target.targetTag, target.binaryName);
  await writeFakeNativeBinary(bundledPath, 'ok');

  const stateRoot = path.join(root, 'state');
  const result = await detectNativeCore(root, { stateRoot });

  assert.equal(result.nativeCorePath, bundledPath);
  assert.equal(result.repairNote, null);
});

test('detectNativeCore 可在关闭自动修复时直接回退 Node', async (t) => {
  const root = await makeTempDir('wecom-native-disable-repair-');
  t.after(async () => removeDir(root));

  const old = process.env.WECOM_CLEANER_NATIVE_AUTO_REPAIR;
  process.env.WECOM_CLEANER_NATIVE_AUTO_REPAIR = 'false';

  try {
    const result = await detectNativeCore(root, { stateRoot: path.join(root, 'state') });
    assert.equal(result.nativeCorePath, null);
  } finally {
    if (old === undefined) {
      delete process.env.WECOM_CLEANER_NATIVE_AUTO_REPAIR;
    } else {
      process.env.WECOM_CLEANER_NATIVE_AUTO_REPAIR = old;
    }
  }
});

test('detectNativeCore 会移除 SHA256 不匹配的缓存核心', async (t) => {
  const root = await makeTempDir('wecom-native-cache-check-');
  t.after(async () => removeDir(root));

  const target = resolveRuntimeTarget();
  const stateRoot = path.join(root, 'state');
  const cachePath = path.join(stateRoot, 'native-cache', target.targetTag, target.binaryName);
  await writeFakeNativeBinary(cachePath, 'ok');

  const manifestPath = path.join(root, 'native', 'manifest.json');
  await ensureDir(path.dirname(manifestPath));
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        version: '0.1.0',
        targets: {
          [target.targetTag]: {
            binaryName: target.binaryName,
            sha256: '0000000000000000000000000000000000000000000000000000000000000000',
          },
        },
      },
      null,
      2
    ),
    'utf-8'
  );

  const old = process.env.WECOM_CLEANER_NATIVE_AUTO_REPAIR;
  process.env.WECOM_CLEANER_NATIVE_AUTO_REPAIR = 'false';

  try {
    const result = await detectNativeCore(root, { stateRoot });
    assert.equal(result.nativeCorePath, null);
    assert.match(result.repairNote || '', /本地缓存校验失败/);

    const stillExists = await fs
      .stat(cachePath)
      .then((s) => s.isFile())
      .catch(() => false);
    assert.equal(stillExists, false);
  } finally {
    if (old === undefined) {
      delete process.env.WECOM_CLEANER_NATIVE_AUTO_REPAIR;
    } else {
      process.env.WECOM_CLEANER_NATIVE_AUTO_REPAIR = old;
    }
  }
});
