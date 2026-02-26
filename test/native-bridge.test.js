import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
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
  const script = buildFakeNativeScript(mode);

  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, script, 'utf-8');
  await fs.chmod(filePath, 0o755).catch(() => {});
}

function buildFakeNativeScript(mode = 'ok') {
  return `#!/usr/bin/env node
if (process.argv.includes('--ping')) {
  if (${mode === 'ok'}) {
    process.stdout.write(JSON.stringify({ ok: true, engine: 'zig' }));
    process.exit(0);
  }
  if (${mode === 'hang'}) {
    setTimeout(() => {}, 60_000);
    return;
  }
  process.stdout.write('bad');
  process.exit(1);
}
process.exit(0);
`;
}

function sha256Of(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function withEnv(overrides, fn) {
  const oldEnv = {};
  for (const [key, value] of Object.entries(overrides || {})) {
    oldEnv[key] = process.env[key];
    if (value === null || value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('server address unavailable');
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${addr.port}`,
  };
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
        version: '1.0.0',
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

test('detectNativeCore 在探针超时时快速回退 Node', async (t) => {
  const root = await makeTempDir('wecom-native-probe-timeout-');
  t.after(async () => removeDir(root));

  const target = resolveRuntimeTarget();
  const bundledPath = path.join(root, 'native', 'bin', target.targetTag, target.binaryName);
  await writeFakeNativeBinary(bundledPath, 'hang');

  const oldAutoRepair = process.env.WECOM_CLEANER_NATIVE_AUTO_REPAIR;
  const oldProbeTimeout = process.env.WECOM_CLEANER_NATIVE_PROBE_TIMEOUT_MS;
  process.env.WECOM_CLEANER_NATIVE_AUTO_REPAIR = 'false';
  process.env.WECOM_CLEANER_NATIVE_PROBE_TIMEOUT_MS = '500';

  try {
    const startedAt = Date.now();
    const result = await detectNativeCore(root, {
      stateRoot: path.join(root, 'state'),
      allowAutoRepair: false,
    });
    const elapsed = Date.now() - startedAt;

    assert.equal(result.nativeCorePath, null);
    assert.equal(elapsed < 3000, true);
  } finally {
    if (oldAutoRepair === undefined) {
      delete process.env.WECOM_CLEANER_NATIVE_AUTO_REPAIR;
    } else {
      process.env.WECOM_CLEANER_NATIVE_AUTO_REPAIR = oldAutoRepair;
    }
    if (oldProbeTimeout === undefined) {
      delete process.env.WECOM_CLEANER_NATIVE_PROBE_TIMEOUT_MS;
    } else {
      process.env.WECOM_CLEANER_NATIVE_PROBE_TIMEOUT_MS = oldProbeTimeout;
    }
  }
});

test('detectNativeCore 在缓存核心校验通过时优先使用缓存核心', async (t) => {
  const root = await makeTempDir('wecom-native-cache-hit-');
  t.after(async () => removeDir(root));

  const target = resolveRuntimeTarget();
  const stateRoot = path.join(root, 'state');
  const cachePath = path.join(stateRoot, 'native-cache', target.targetTag, target.binaryName);
  await writeFakeNativeBinary(cachePath, 'ok');
  const digest = sha256Of(await fs.readFile(cachePath));

  const manifestPath = path.join(root, 'native', 'manifest.json');
  await ensureDir(path.dirname(manifestPath));
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        version: '1.0.0',
        targets: {
          [target.targetTag]: {
            binaryName: target.binaryName,
            sha256: digest,
          },
        },
      },
      null,
      2
    ),
    'utf-8'
  );

  const result = await detectNativeCore(root, { stateRoot });
  assert.equal(result.nativeCorePath, cachePath);
  assert.match(result.repairNote || '', /已使用本地缓存/);
});

test('detectNativeCore 自动修复可下载并恢复核心', async (t) => {
  const root = await makeTempDir('wecom-native-repair-success-');
  t.after(async () => removeDir(root));

  const target = resolveRuntimeTarget();
  const stateRoot = path.join(root, 'state');
  const binaryScript = buildFakeNativeScript('ok');
  const digest = sha256Of(binaryScript);

  const { server, baseUrl } = await startServer((req, res) => {
    if (req.url === `/${target.targetTag}/${target.binaryName}`) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(binaryScript);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const manifestPath = path.join(root, 'native', 'manifest.json');
  await ensureDir(path.dirname(manifestPath));
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        version: '1.0.0',
        targets: {
          [target.targetTag]: {
            binaryName: target.binaryName,
            sha256: digest,
          },
        },
      },
      null,
      2
    ),
    'utf-8'
  );

  const result = await withEnv(
    {
      WECOM_CLEANER_NATIVE_AUTO_REPAIR: 'true',
      WECOM_CLEANER_NATIVE_BASE_URL: baseUrl,
      WECOM_CLEANER_NATIVE_DOWNLOAD_TIMEOUT_MS: '2000',
    },
    async () => detectNativeCore(root, { stateRoot })
  );

  const expectedPath = path.join(stateRoot, 'native-cache', target.targetTag, target.binaryName);
  assert.equal(result.nativeCorePath, expectedPath);
  assert.match(result.repairNote || '', /Zig核心已恢复/);
});

test('detectNativeCore 自动修复优先使用 manifest target.url', async (t) => {
  const root = await makeTempDir('wecom-native-repair-manifest-url-');
  t.after(async () => removeDir(root));

  const target = resolveRuntimeTarget();
  const stateRoot = path.join(root, 'state');
  const binaryScript = buildFakeNativeScript('ok');
  const digest = sha256Of(binaryScript);
  const requestedUrls = [];

  const { server, baseUrl } = await startServer((req, res) => {
    requestedUrls.push(String(req.url || '/'));
    if (req.url === '/binary-by-url') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(binaryScript);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const manifestPath = path.join(root, 'native', 'manifest.json');
  await ensureDir(path.dirname(manifestPath));
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        version: '9.9.9',
        baseUrl: `${baseUrl}/should-not-use`,
        targets: {
          [target.targetTag]: {
            binaryName: target.binaryName,
            sha256: digest,
            url: `${baseUrl}/binary-by-url`,
          },
        },
      },
      null,
      2
    ),
    'utf-8'
  );

  const result = await withEnv(
    {
      WECOM_CLEANER_NATIVE_AUTO_REPAIR: 'true',
      WECOM_CLEANER_NATIVE_BASE_URL: null,
      WECOM_CLEANER_NATIVE_DOWNLOAD_TIMEOUT_MS: '2000',
    },
    async () => detectNativeCore(root, { stateRoot })
  );

  const expectedPath = path.join(stateRoot, 'native-cache', target.targetTag, target.binaryName);
  assert.equal(result.nativeCorePath, expectedPath);
  assert.equal(requestedUrls.includes('/binary-by-url'), true);
  assert.equal(
    requestedUrls.some((item) => item.includes('/should-not-use')),
    false
  );
});

test('detectNativeCore 自动修复关闭且 manifest 目标存在时返回空 repairNote', async (t) => {
  const root = await makeTempDir('wecom-native-repair-disabled-');
  t.after(async () => removeDir(root));

  const target = resolveRuntimeTarget();
  const manifestPath = path.join(root, 'native', 'manifest.json');
  await ensureDir(path.dirname(manifestPath));
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        version: '1.0.0',
        targets: {
          [target.targetTag]: {
            binaryName: target.binaryName,
            sha256: 'd457132f3118f18844f010840b2af5955c750baa0ff28d96315f84fdd899df1b',
          },
        },
      },
      null,
      2
    ),
    'utf-8'
  );

  const result = await withEnv(
    {
      WECOM_CLEANER_NATIVE_AUTO_REPAIR: 'false',
    },
    async () => detectNativeCore(root, { stateRoot: path.join(root, 'state'), allowAutoRepair: false })
  );
  assert.equal(result.nativeCorePath, null);
  assert.equal(result.repairNote, null);
});

test('detectNativeCore 在缺少 manifest 目标时给出可读回退说明', async (t) => {
  const root = await makeTempDir('wecom-native-manifest-missing-target-');
  t.after(async () => removeDir(root));

  const manifestPath = path.join(root, 'native', 'manifest.json');
  await ensureDir(path.dirname(manifestPath));
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        version: '1.0.0',
        targets: {},
      },
      null,
      2
    ),
    'utf-8'
  );

  const result = await withEnv(
    {
      WECOM_CLEANER_NATIVE_AUTO_REPAIR: 'true',
    },
    async () => detectNativeCore(root, { stateRoot: path.join(root, 'state') })
  );

  assert.equal(result.nativeCorePath, null);
  assert.match(result.repairNote || '', /缺少可信核心清单/);
});

test('detectNativeCore 会合并缓存校验失败与下载失败的提示', async (t) => {
  const root = await makeTempDir('wecom-native-repair-combined-note-');
  t.after(async () => removeDir(root));

  const target = resolveRuntimeTarget();
  const stateRoot = path.join(root, 'state');
  const cachePath = path.join(stateRoot, 'native-cache', target.targetTag, target.binaryName);
  await writeFakeNativeBinary(cachePath, 'ok');

  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end(`missing:${req.url || '/'}`);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const manifestPath = path.join(root, 'native', 'manifest.json');
  await ensureDir(path.dirname(manifestPath));
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        version: '1.0.0',
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

  const result = await withEnv(
    {
      WECOM_CLEANER_NATIVE_AUTO_REPAIR: 'true',
      WECOM_CLEANER_NATIVE_BASE_URL: baseUrl,
    },
    async () => detectNativeCore(root, { stateRoot })
  );

  assert.equal(result.nativeCorePath, null);
  assert.match(result.repairNote || '', /本地缓存校验失败/);
  assert.match(result.repairNote || '', /下载失败/);
});

test('detectNativeCore 默认下载地址会跟随 manifest 版本标签', async (t) => {
  const root = await makeTempDir('wecom-native-default-version-base-url-');
  t.after(async () => removeDir(root));

  const target = resolveRuntimeTarget();
  const stateRoot = path.join(root, 'state');
  const binaryScript = buildFakeNativeScript('ok');
  const digest = sha256Of(binaryScript);

  const manifestPath = path.join(root, 'native', 'manifest.json');
  await ensureDir(path.dirname(manifestPath));
  await fs.writeFile(
    manifestPath,
    JSON.stringify(
      {
        version: '2.3.4',
        targets: {
          [target.targetTag]: {
            binaryName: target.binaryName,
            sha256: digest,
          },
        },
      },
      null,
      2
    ),
    'utf-8'
  );

  const oldFetch = globalThis.fetch;
  const requestedUrls = [];
  globalThis.fetch = async (input) => {
    requestedUrls.push(String(input));
    return new Response(binaryScript, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
      },
    });
  };
  t.after(() => {
    globalThis.fetch = oldFetch;
  });

  const result = await withEnv(
    {
      WECOM_CLEANER_NATIVE_AUTO_REPAIR: 'true',
      WECOM_CLEANER_NATIVE_BASE_URL: null,
    },
    async () => detectNativeCore(root, { stateRoot })
  );

  assert.equal(requestedUrls.length, 1);
  assert.equal(
    requestedUrls[0].includes(`/v2.3.4/native/bin/${target.targetTag}/${target.binaryName}`),
    true
  );
  assert.equal(
    result.nativeCorePath,
    path.join(stateRoot, 'native-cache', target.targetTag, target.binaryName)
  );
});
