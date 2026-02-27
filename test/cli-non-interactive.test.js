import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempDir, removeDir } from './helpers/temp.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const CLI_PATH = path.join(REPO_ROOT, 'src', 'cli.js');

function toBase64(text) {
  return Buffer.from(String(text || ''), 'utf-8').toString('base64');
}

async function prepareFixture(root) {
  const profilesRoot = path.join(root, 'Profiles');
  const accountRoot = path.join(profilesRoot, 'acc001');
  await fs.mkdir(path.join(accountRoot, 'Caches', 'Files', '2024-01'), { recursive: true });
  await fs.writeFile(path.join(accountRoot, 'Caches', 'Files', '2024-01', 'payload.txt'), 'hello', 'utf-8');
  await fs.writeFile(
    path.join(accountRoot, 'io_data.json'),
    JSON.stringify({
      user_info: toBase64('姓名 张三'),
      corp_info: toBase64('企业 示例科技'),
    }),
    'utf-8'
  );
  await fs.writeFile(
    path.join(profilesRoot, 'setting.json'),
    JSON.stringify({ CurrentProfile: 'acc001' }),
    'utf-8'
  );
  return profilesRoot;
}

async function prepareAutoExternalRoot(prefix = 'wecom-cli-auto-root') {
  const parent = path.join(
    os.homedir(),
    'Documents',
    `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  );
  const externalRoot = path.join(parent, 'WXWork_Data');
  const monthDir = path.join(externalRoot, 'WXWork Files', 'Caches', 'Files', '2024-01');
  await fs.mkdir(monthDir, { recursive: true });
  await fs.writeFile(path.join(monthDir, 'external.txt'), 'external', 'utf-8');
  return {
    parent,
    externalRoot: path.resolve(externalRoot),
  };
}

async function startMockUpdateServer() {
  const state = {
    npmHits: 0,
    githubHits: 0,
    unknownHits: 0,
  };

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = requestUrl.pathname;
    const decodedPath = decodeURIComponent(pathname);

    if (decodedPath === '/@mison/wecom-cleaner') {
      state.npmHits += 1;
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'mock_npm_failure' }));
      return;
    }

    if (pathname === '/repos/MisonL/wecom-cleaner/releases/latest') {
      state.githubHits += 1;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ tag_name: 'v9.9.9', prerelease: false, draft: false }));
      return;
    }

    state.unknownHits += 1;
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not_found', path: pathname }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise((resolve) => server.close(() => resolve()));
    throw new Error('mock_server_address_invalid');
  }

  return {
    state,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      WECOM_CLEANER_NATIVE_AUTO_REPAIR: 'false',
      WECOM_CLEANER_AUTO_UPDATE: 'false',
      ...env,
    },
    encoding: 'utf-8',
  });
}

function runCliAsync(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        WECOM_CLEANER_NATIVE_AUTO_REPAIR: 'false',
        WECOM_CLEANER_AUTO_UPDATE: 'false',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => reject(error));
    child.on('close', (code, signal) => {
      resolve({
        status: code,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

async function createMockCurlBin(root) {
  const binDir = path.join(root, 'fake-bin');
  await fs.mkdir(binDir, { recursive: true });
  const curlPath = path.join(binDir, 'curl');
  await fs.writeFile(
    curlPath,
    `#!/usr/bin/env bash
set -euo pipefail
cat <<'MOCK_SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
echo "mock-upgrade-script args: $*" >&2
exit 0
MOCK_SCRIPT
`,
    'utf-8'
  );
  await fs.chmod(curlPath, 0o755);
  return binDir;
}

function assertCommonPayloadEnvelope(payload, action, expectedDryRun) {
  assert.equal(typeof payload, 'object');
  assert.equal(payload.action, action);
  assert.equal(typeof payload.ok, 'boolean');
  assert.equal(Array.isArray(payload.warnings), true);
  assert.equal(Array.isArray(payload.errors), true);
  assert.equal(typeof payload.summary, 'object');
  assert.equal(typeof payload.meta, 'object');
  assert.equal(typeof payload.meta.durationMs, 'number');
  assert.equal(typeof payload.meta.engine, 'string');

  if (expectedDryRun === null) {
    assert.equal(payload.dryRun, null);
    return;
  }
  assert.equal(typeof payload.dryRun, 'boolean');
  if (typeof expectedDryRun === 'boolean') {
    assert.equal(payload.dryRun, expectedDryRun);
  }
}

async function readLastCleanupBatchId(indexPath) {
  const exists = await fs
    .stat(indexPath)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    return null;
  }
  const content = await fs.readFile(indexPath, 'utf-8');
  const lines = String(content || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const row = JSON.parse(lines[i]);
      if (row?.action === 'cleanup' && row?.status === 'success' && row?.batchId) {
        return row.batchId;
      }
    } catch {
      // ignore invalid jsonl row
    }
  }
  return null;
}

async function appendJsonLine(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf-8');
}

test('无交互 JSON 契约：公共字段与类型稳定（关键动作）', async (t) => {
  const root = await makeTempDir('wecom-cli-ni-contract-');
  t.after(async () => removeDir(root));

  const profilesRoot = await prepareFixture(root);
  const stateRoot = path.join(root, 'state');

  const cleanupDryRun = runCli([
    '--cleanup-monthly',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--accounts',
    'all',
    '--months',
    '2024-01',
    '--categories',
    'files',
    '--external-storage-auto-detect',
    'false',
  ]);
  assert.equal(cleanupDryRun.status, 0);
  assertCommonPayloadEnvelope(JSON.parse(String(cleanupDryRun.stdout || '{}')), 'cleanup_monthly', true);

  const analysis = runCli([
    '--analysis-only',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--accounts',
    'all',
    '--external-storage-auto-detect',
    'false',
  ]);
  assert.equal(analysis.status, 0);
  assertCommonPayloadEnvelope(JSON.parse(String(analysis.stdout || '{}')), 'analysis_only', null);

  const governance = runCli([
    '--space-governance',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--accounts',
    'all',
    '--tiers',
    'safe,caution',
    '--external-storage-auto-detect',
    'false',
  ]);
  assert.equal(governance.status, 0);
  assertCommonPayloadEnvelope(JSON.parse(String(governance.stdout || '{}')), 'space_governance', true);

  const recycle = runCli([
    '--recycle-maintain',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--external-storage-auto-detect',
    'false',
  ]);
  assert.equal(recycle.status, 0);
  assertCommonPayloadEnvelope(JSON.parse(String(recycle.stdout || '{}')), 'recycle_maintain', true);

  const doctor = runCli([
    '--doctor',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--external-storage-auto-detect',
    'false',
  ]);
  assert.equal(doctor.status, 0);
  assertCommonPayloadEnvelope(JSON.parse(String(doctor.stdout || '{}')), 'doctor', null);

  const cleanupReal = runCli([
    '--cleanup-monthly',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--accounts',
    'all',
    '--months',
    '2024-01',
    '--categories',
    'files',
    '--external-storage-auto-detect',
    'false',
    '--dry-run',
    'false',
    '--yes',
  ]);
  assert.equal(cleanupReal.status, 0);
  const batchId = await readLastCleanupBatchId(path.join(stateRoot, 'index.jsonl'));
  assert.equal(typeof batchId, 'string');
  assert.equal(Boolean(batchId), true);

  const restore = runCli([
    '--restore-batch',
    batchId,
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--conflict',
    'rename',
    '--external-storage-auto-detect',
    'false',
  ]);
  assert.equal(restore.status, 0);
  assertCommonPayloadEnvelope(JSON.parse(String(restore.stdout || '{}')), 'restore', true);
});

test('无交互 text/json 在无目标场景下结论一致', async (t) => {
  const root = await makeTempDir('wecom-cli-ni-text-json-consistency-');
  t.after(async () => removeDir(root));

  const profilesRoot = await prepareFixture(root);
  const stateRoot = path.join(root, 'state');

  const cleanupJson = runCli([
    '--cleanup-monthly',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--accounts',
    'all',
    '--categories',
    'files',
    '--months',
    '2024-02',
    '--external-storage-auto-detect',
    'false',
  ]);
  assert.equal(cleanupJson.status, 0);
  const cleanupJsonPayload = JSON.parse(String(cleanupJson.stdout || '{}'));
  assert.equal(cleanupJsonPayload.summary.noTarget, true);
  assert.equal(cleanupJsonPayload.summary.matchedTargets, 0);

  const cleanupText = runCli([
    '--cleanup-monthly',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--accounts',
    'all',
    '--categories',
    'files',
    '--months',
    '2024-02',
    '--external-storage-auto-detect',
    'false',
    '--output',
    'text',
  ]);
  assert.equal(cleanupText.status, 0);
  assert.match(String(cleanupText.stdout || ''), /未发现可清理目录/);
  assert.match(String(cleanupText.stdout || ''), /未执行真实删除/);

  const recycleJson = runCli([
    '--recycle-maintain',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--external-storage-auto-detect',
    'false',
  ]);
  assert.equal(recycleJson.status, 0);
  const recycleJsonPayload = JSON.parse(String(recycleJson.stdout || '{}'));
  assert.equal(recycleJsonPayload.summary.candidateCount, 0);

  const recycleText = runCli([
    '--recycle-maintain',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--external-storage-auto-detect',
    'false',
    '--output',
    'text',
  ]);
  assert.equal(recycleText.status, 0);
  assert.match(String(recycleText.stdout || ''), /已跳过（无候选批次）|当前没有需要治理的回收批次/);
});

test('无交互业务失败场景仍返回稳定 JSON 契约（recycle partial_failed）', async (t) => {
  const root = await makeTempDir('wecom-cli-ni-fail-contract-');
  t.after(async () => removeDir(root));

  const profilesRoot = await prepareFixture(root);
  const stateRoot = path.join(root, 'state');
  const recycleRoot = path.join(stateRoot, 'recycle-bin');
  const indexPath = path.join(stateRoot, 'index.jsonl');
  const recyclePathA = path.join(recycleRoot, 'batch-A', '0001_item');
  const recyclePathB = path.join(recycleRoot, 'batch-B', '0002_item');

  await fs.mkdir(path.dirname(path.dirname(recyclePathA)), { recursive: true });
  await fs.mkdir(path.dirname(path.dirname(recyclePathB)), { recursive: true });
  await fs.mkdir(recyclePathA, { recursive: true });
  await fs.mkdir(recyclePathB, { recursive: true });
  await fs.writeFile(path.join(recyclePathA, 'payload.bin'), 'a', 'utf-8');
  await fs.writeFile(path.join(recyclePathB, 'payload.bin'), 'b', 'utf-8');

  await appendJsonLine(indexPath, {
    action: 'cleanup',
    status: 'success',
    batchId: 'mixed-batch',
    scope: 'cleanup_monthly',
    sourcePath: '/source/a',
    recyclePath: recyclePathA,
    sizeBytes: 1,
    time: Date.now() - 90 * 24 * 3600 * 1000,
  });
  await appendJsonLine(indexPath, {
    action: 'cleanup',
    status: 'success',
    batchId: 'mixed-batch',
    scope: 'cleanup_monthly',
    sourcePath: '/source/b',
    recyclePath: recyclePathB,
    sizeBytes: 1,
    time: Date.now() - 90 * 24 * 3600 * 1000,
  });
  await appendJsonLine(indexPath, {
    action: 'cleanup',
    status: 'success',
    batchId: 'keep-recent',
    scope: 'cleanup_monthly',
    sourcePath: '/source/c',
    recyclePath: path.join(recycleRoot, 'keep-recent', '0003_item'),
    sizeBytes: 1,
    time: Date.now(),
  });
  await fs.mkdir(path.join(recycleRoot, 'keep-recent', '0003_item'), { recursive: true });
  await fs.writeFile(path.join(recycleRoot, 'keep-recent', '0003_item', 'payload.bin'), 'c', 'utf-8');

  const result = runCli([
    '--recycle-maintain',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--retention-enabled',
    'true',
    '--retention-max-age-days',
    '30',
    '--retention-min-keep-batches',
    '1',
    '--retention-size-threshold-gb',
    '1',
    '--dry-run',
    'false',
    '--yes',
    '--external-storage-auto-detect',
    'false',
  ]);

  assert.equal(result.status, 1);
  const payload = JSON.parse(String(result.stdout || '{}'));
  assert.equal(payload.action, 'recycle_maintain');
  assert.equal(payload.ok, false);
  assert.equal(payload.summary.status, 'partial_failed');
  assert.equal(payload.summary.failedBatches >= 1, true);
  assert.equal(Array.isArray(payload.errors), true);
  assert.equal(payload.errors.length >= 1, true);
  assert.equal(typeof payload.errors[0].code, 'string');
  assert.equal(typeof payload.errors[0].message, 'string');
  assert.equal(typeof payload.meta.durationMs, 'number');
  assert.equal(typeof payload.meta.engine, 'string');
});

test('无交互 cleanup 默认返回 JSON 且未加 --yes 时强制 dry-run', async (t) => {
  const root = await makeTempDir('wecom-cli-ni-cleanup-');
  t.after(async () => removeDir(root));

  const profilesRoot = await prepareFixture(root);
  const stateRoot = path.join(root, 'state');

  const result = runCli([
    '--cleanup-monthly',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--accounts',
    'all',
    '--categories',
    'files',
    '--months',
    '2024-01',
  ]);

  assert.equal(result.status, 0);
  const payload = JSON.parse(String(result.stdout || '{}'));
  assert.equal(payload.action, 'cleanup_monthly');
  assert.equal(payload.ok, true);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.summary.hasWork, true);
  assert.equal(payload.summary.noTarget, false);
  assert.equal(payload.summary.matchedTargets >= 1, true);
  assert.equal(payload.summary.matchedBytes >= 1, true);
  assert.equal(payload.summary.successCount >= 1, true);
  assert.equal(payload.summary.accountCount, 1);
  assert.equal(payload.summary.categoryCount, 1);
  assert.equal(payload.summary.monthCount, 1);
  assert.equal(payload.summary.rootPathCount >= 1, true);
  assert.equal(typeof payload.summary.matchedMonthStart, 'string');
  assert.equal(typeof payload.summary.matchedMonthEnd, 'string');
  assert.equal(Array.isArray(payload.data?.report?.matched?.categoryStats), true);
  assert.equal(Array.isArray(payload.data?.report?.matched?.monthStats), true);
  assert.equal(Array.isArray(payload.data?.report?.matched?.rootStats), true);
  assert.equal(Array.isArray(payload.data?.report?.matched?.topPaths), true);
  assert.equal(Array.isArray(payload.data?.report?.executed?.byCategory), true);
  assert.equal(Array.isArray(payload.data?.report?.executed?.byMonth), true);
  assert.equal(Array.isArray(payload.data?.report?.executed?.byRoot), true);
  assert.equal(Array.isArray(payload.data?.report?.executed?.topPaths), true);

  const sourcePath = path.join(profilesRoot, 'acc001', 'Caches', 'Files', '2024-01');
  const exists = await fs
    .stat(sourcePath)
    .then(() => true)
    .catch(() => false);
  assert.equal(exists, true);
});

test('无交互 cleanup 在无命中目标时返回 noTarget 且不生成批次', async (t) => {
  const root = await makeTempDir('wecom-cli-ni-cleanup-empty-');
  t.after(async () => removeDir(root));

  const profilesRoot = await prepareFixture(root);
  const stateRoot = path.join(root, 'state');

  const result = runCli([
    '--cleanup-monthly',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--accounts',
    'all',
    '--categories',
    'files',
    '--months',
    '2024-02',
  ]);

  assert.equal(result.status, 0);
  const payload = JSON.parse(String(result.stdout || '{}'));
  assert.equal(payload.action, 'cleanup_monthly');
  assert.equal(payload.ok, true);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.summary.hasWork, false);
  assert.equal(payload.summary.noTarget, true);
  assert.equal(payload.summary.matchedTargets, 0);
  assert.equal(payload.summary.matchedBytes, 0);
  assert.equal(payload.summary.reclaimedBytes, 0);
  assert.equal(payload.summary.successCount, 0);
  assert.equal(payload.summary.skippedCount, 0);
  assert.equal(payload.summary.failedCount, 0);
  assert.equal(payload.summary.batchId, null);
  assert.equal(payload.summary.monthCount, 1);
  assert.equal(payload.summary.rootPathCount, 0);
  assert.equal(payload.summary.matchedMonthStart, null);
  assert.equal(payload.summary.matchedMonthEnd, null);
  assert.equal(payload.data?.report?.matched?.totalTargets, 0);
  assert.equal(payload.data?.report?.executed, null);
});

test('无交互 cleanup 默认 external-roots-source=all，会自动纳入探测到的外部目录', async (t) => {
  const root = await makeTempDir('wecom-cli-ni-cleanup-auto-root-');
  t.after(async () => removeDir(root));

  const profilesRoot = await prepareFixture(root);
  const stateRoot = path.join(root, 'state');
  const autoExternal = await prepareAutoExternalRoot('wecom-cli-auto-source');
  t.after(async () => removeDir(autoExternal.parent));

  const result = runCli([
    '--cleanup-monthly',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--accounts',
    'all',
    '--categories',
    'files',
    '--months',
    '2024-01',
  ]);

  assert.equal(result.status, 0);
  const payload = JSON.parse(String(result.stdout || '{}'));
  assert.equal(payload.action, 'cleanup_monthly');
  assert.equal(payload.ok, true);
  assert.equal(Array.isArray(payload.data?.selectedExternalRoots), true);
  assert.equal(payload.data.selectedExternalRoots.includes(autoExternal.externalRoot), true);
  assert.equal(payload.summary.externalRootCount >= 1, true);
});

test('无交互真实执行必须显式 --yes，否则退出码为 3', async (t) => {
  const root = await makeTempDir('wecom-cli-ni-confirm-');
  t.after(async () => removeDir(root));

  const profilesRoot = await prepareFixture(root);
  const stateRoot = path.join(root, 'state');

  const result = runCli([
    '--cleanup-monthly',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--accounts',
    'all',
    '--categories',
    'files',
    '--months',
    '2024-01',
    '--dry-run',
    'false',
  ]);

  assert.equal(result.status, 3);
  assert.match(String(result.stderr || ''), /确认错误/);
});

test('带参数但缺少动作时返回参数错误', async (t) => {
  const root = await makeTempDir('wecom-cli-ni-usage-');
  t.after(async () => removeDir(root));

  const profilesRoot = await prepareFixture(root);
  const stateRoot = path.join(root, 'state');

  const result = runCli(['--root', profilesRoot, '--state-root', stateRoot]);
  assert.equal(result.status, 2);
  assert.match(String(result.stderr || ''), /必须指定一个动作参数/);
});

test('无交互 doctor 默认 JSON 输出', async (t) => {
  const root = await makeTempDir('wecom-cli-ni-doctor-');
  t.after(async () => removeDir(root));

  const profilesRoot = await prepareFixture(root);
  const stateRoot = path.join(root, 'state');
  await fs.mkdir(stateRoot, { recursive: true });

  const result = runCli(['--doctor', '--root', profilesRoot, '--state-root', stateRoot]);

  assert.equal(result.status, 0);
  const payload = JSON.parse(String(result.stdout || '{}'));
  assert.equal(payload.action, 'doctor');
  assert.equal(payload.ok, true);
  assert.equal(typeof payload.summary.overall, 'string');
});

test('无交互兼容 --mode 可映射动作并输出迁移 warning', async (t) => {
  const root = await makeTempDir('wecom-cli-ni-mode-compat-');
  t.after(async () => removeDir(root));

  const profilesRoot = await prepareFixture(root);
  const stateRoot = path.join(root, 'state');
  await fs.mkdir(stateRoot, { recursive: true });

  const result = runCli(['--mode', 'doctor', '--root', profilesRoot, '--state-root', stateRoot]);

  assert.equal(result.status, 0);
  const payload = JSON.parse(String(result.stdout || '{}'));
  assert.equal(payload.action, 'doctor');
  assert.equal(Array.isArray(payload.warnings), true);
  assert.equal(
    payload.warnings.some((item) => String(item).includes('--mode 已进入兼容模式')),
    true
  );
});

test('--interactive 可在带参数时进入交互模式并按 --mode 直达功能', async (t) => {
  const root = await makeTempDir('wecom-cli-interactive-override-');
  t.after(async () => removeDir(root));

  const profilesRoot = await prepareFixture(root);
  const stateRoot = path.join(root, 'state');
  await fs.mkdir(stateRoot, { recursive: true });

  const result = runCli([
    '--interactive',
    '--mode',
    'doctor',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--external-storage-auto-detect',
    'false',
  ]);

  assert.equal(result.status, 0);
  assert.equal(String(result.stdout || '').includes('系统自检'), true);
  assert.equal(String(result.stderr || '').includes('必须指定一个动作参数'), false);
});

test('CLI 支持 --help 并返回无交互动作说明', () => {
  const result = runCli(['--help']);
  assert.equal(result.status, 0);
  const output = String(result.stdout || '');
  assert.match(output, /用法：/);
  assert.match(output, /--cleanup-monthly/);
  assert.match(output, /--doctor/);
  assert.match(output, /--check-update/);
  assert.match(output, /--upgrade <npm\|github-script>/);
  assert.match(output, /--sync-skills/);
  assert.match(output, /--run-task preview\|execute\|preview-execute-verify/);
  assert.match(output, /--scan-debug off\|summary\|full/);
});

test('无交互 --check-update 在 npm 失败时回退 GitHub 并保留错误痕迹', async (t) => {
  const mockServer = await startMockUpdateServer();
  t.after(async () => {
    await mockServer.close();
  });

  const result = await runCliAsync(['--check-update'], {
    WECOM_CLEANER_UPDATE_NPM_REGISTRY_URL: mockServer.baseUrl,
    WECOM_CLEANER_UPDATE_GITHUB_API_BASE_URL: mockServer.baseUrl,
  });

  assert.equal(result.status, 0);
  const payload = JSON.parse(String(result.stdout || '{}'));
  assert.equal(payload.action, 'check_update');
  assert.equal(payload.ok, true);
  assert.equal(payload.summary.checked, true);
  assert.equal(payload.summary.source, 'github');
  assert.match(String(payload.summary.sourceChain || ''), /回退|GitHub/);
  assert.equal(payload.summary.latestVersion, '9.9.9');
  assert.equal(payload.data?.update?.sourceUsed, 'github');
  assert.equal(typeof payload.summary.skillsStatus, 'string');
  assert.equal(typeof payload.summary.skillsMatched, 'boolean');
  assert.equal(typeof payload.data?.skills?.status, 'string');
  assert.equal(Array.isArray(payload.data?.userFacingSummary?.scopeNotes), true);
  assert.equal(
    payload.data.userFacingSummary.scopeNotes.some(
      (item) => String(item).includes('回退') || String(item).includes('GitHub')
    ),
    true
  );
  assert.equal(mockServer.state.npmHits >= 1, true);
  assert.equal(mockServer.state.githubHits >= 1, true);
  assert.equal(Array.isArray(payload.warnings), true);
  assert.equal(
    payload.warnings.some((item) => String(item).includes('更新检查回退')),
    true
  );
  assert.equal(Array.isArray(payload.errors), true);
  assert.equal(payload.errors.length, 0);
});

test('CLI 支持 --version 并输出版本号', () => {
  const result = runCli(['--version']);
  assert.equal(result.status, 0);
  assert.match(String(result.stdout || '').trim(), /^\d+\.\d+\.\d+$/);
});

test('无交互 --upgrade 未确认时返回确认错误', () => {
  const result = runCli(['--upgrade', 'npm', '--upgrade-version', '1.2.1']);
  assert.equal(result.status, 3);
  assert.match(String(result.stderr || ''), /确认错误/);
});

test('无交互 --upgrade github-script 关闭 skills 同步时透传参数', async (t) => {
  const root = await makeTempDir('wecom-cli-upgrade-sync-flag-');
  t.after(async () => removeDir(root));

  const fakeBin = await createMockCurlBin(root);
  const codexHome = path.join(root, 'codex-home');
  const stateRoot = path.join(root, 'state');

  const result = runCli(
    [
      '--upgrade',
      'github-script',
      '--upgrade-version',
      '9.9.9',
      '--upgrade-yes',
      '--upgrade-sync-skills',
      'false',
      '--state-root',
      stateRoot,
    ],
    {
      CODEX_HOME: codexHome,
      PATH: `${fakeBin}:${process.env.PATH || ''}`,
    }
  );

  assert.equal(result.status, 0);
  const payload = JSON.parse(String(result.stdout || '{}'));
  assert.equal(payload.action, 'upgrade');
  assert.equal(payload.ok, true);
  assert.equal(payload.summary.method, 'github-script');
  assert.equal(payload.summary.skillSyncEnabled, false);
  assert.equal(payload.summary.skillSyncStatus, 'disabled');
  assert.match(String(payload.summary.command || ''), /--sync-skills false/);
});

test('无交互 --sync-skills 支持预演与真实同步', async (t) => {
  const root = await makeTempDir('wecom-cli-sync-skills-');
  t.after(async () => removeDir(root));

  const codexHome = path.join(root, 'codex-home');
  const dryRun = runCli(['--sync-skills', '--dry-run', 'true'], {
    CODEX_HOME: codexHome,
  });
  assert.equal(dryRun.status, 0);
  const dryPayload = JSON.parse(String(dryRun.stdout || '{}'));
  assert.equal(dryPayload.action, 'sync_skills');
  assert.equal(dryPayload.dryRun, true);
  assert.equal(dryPayload.summary.status, 'dry_run');

  const execute = runCli(['--sync-skills', '--dry-run', 'false'], {
    CODEX_HOME: codexHome,
  });
  assert.equal(execute.status, 0);
  const execPayload = JSON.parse(String(execute.stdout || '{}'));
  assert.equal(execPayload.action, 'sync_skills');
  assert.equal(execPayload.ok, true);
  assert.equal(execPayload.summary.skillsMatchedAfter, true);
});

test('无交互 analysis 返回用户报告统计结构', async (t) => {
  const root = await makeTempDir('wecom-cli-ni-analysis-');
  t.after(async () => removeDir(root));

  const profilesRoot = await prepareFixture(root);
  const stateRoot = path.join(root, 'state');

  const result = runCli([
    '--analysis-only',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--accounts',
    'all',
  ]);
  assert.equal(result.status, 0);

  const payload = JSON.parse(String(result.stdout || '{}'));
  assert.equal(payload.action, 'analysis_only');
  assert.equal(payload.ok, true);
  assert.equal(Array.isArray(payload.data?.report?.matched?.categoryStats), true);
  assert.equal(Array.isArray(payload.data?.report?.matched?.monthStats), true);
  assert.equal(Array.isArray(payload.data?.report?.matched?.accountStats), true);
  assert.equal(Array.isArray(payload.data?.report?.matched?.rootStats), true);
  assert.equal(Array.isArray(payload.data?.report?.matched?.topPaths), true);
});

test('无交互 space-governance 返回统一报告结构', async (t) => {
  const root = await makeTempDir('wecom-cli-ni-governance-');
  t.after(async () => removeDir(root));

  const profilesRoot = await prepareFixture(root);
  const stateRoot = path.join(root, 'state');

  const result = runCli([
    '--space-governance',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--accounts',
    'all',
    '--tiers',
    'safe,caution',
  ]);
  assert.equal(result.status, 0);

  const payload = JSON.parse(String(result.stdout || '{}'));
  assert.equal(payload.action, 'space_governance');
  assert.equal(payload.ok, true);
  assert.equal(Array.isArray(payload.data?.report?.matched?.byTier), true);
  assert.equal(Array.isArray(payload.data?.report?.matched?.byTargetType), true);
  assert.equal(Array.isArray(payload.data?.report?.matched?.byAccount), true);
  assert.equal(Array.isArray(payload.data?.report?.matched?.byRoot), true);
  assert.equal(Array.isArray(payload.data?.report?.matched?.topPaths), true);
  if (payload.data?.report?.executed) {
    assert.equal(Array.isArray(payload.data.report.executed.byCategory), true);
    assert.equal(Array.isArray(payload.data.report.executed.byMonth), true);
    assert.equal(Array.isArray(payload.data.report.executed.byRoot), true);
  } else {
    assert.equal(payload.summary.matchedTargets, 0);
  }
});

test('无交互 restore-batch 返回匹配与执行报告结构', async (t) => {
  const root = await makeTempDir('wecom-cli-ni-restore-');
  t.after(async () => removeDir(root));

  const profilesRoot = await prepareFixture(root);
  const stateRoot = path.join(root, 'state');

  const cleanupResult = runCli([
    '--cleanup-monthly',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--accounts',
    'all',
    '--categories',
    'files',
    '--months',
    '2024-01',
    '--dry-run',
    'false',
    '--yes',
  ]);
  assert.equal(cleanupResult.status, 0);

  const indexPath = path.join(stateRoot, 'index.jsonl');
  const batchId = await readLastCleanupBatchId(indexPath);
  assert.equal(typeof batchId, 'string');
  assert.equal(Boolean(batchId), true);

  const restoreResult = runCli([
    '--restore-batch',
    batchId,
    '--conflict',
    'rename',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
  ]);
  assert.equal(restoreResult.status, 0);

  const payload = JSON.parse(String(restoreResult.stdout || '{}'));
  assert.equal(payload.action, 'restore');
  assert.equal(payload.dryRun, true);
  assert.equal(payload.summary.batchId, batchId);
  assert.equal(Array.isArray(payload.data?.report?.matched?.byScope), true);
  assert.equal(Array.isArray(payload.data?.report?.matched?.byCategory), true);
  assert.equal(Array.isArray(payload.data?.report?.matched?.byMonth), true);
  assert.equal(Array.isArray(payload.data?.report?.matched?.byRoot), true);
  assert.equal(Array.isArray(payload.data?.report?.matched?.topEntries), true);
  assert.equal(Array.isArray(payload.data?.report?.executed?.byScope), true);
  assert.equal(Array.isArray(payload.data?.report?.executed?.byCategory), true);
  assert.equal(Array.isArray(payload.data?.report?.executed?.byMonth), true);
  assert.equal(Array.isArray(payload.data?.report?.executed?.byRoot), true);
});

test('无交互 recycle-maintain 返回候选与执行明细结构', async (t) => {
  const root = await makeTempDir('wecom-cli-ni-recycle-');
  t.after(async () => removeDir(root));

  const profilesRoot = await prepareFixture(root);
  const stateRoot = path.join(root, 'state');

  const result = runCli(['--recycle-maintain', '--root', profilesRoot, '--state-root', stateRoot]);
  assert.equal(result.status, 0);

  const payload = JSON.parse(String(result.stdout || '{}'));
  assert.equal(payload.action, 'recycle_maintain');
  assert.equal(payload.ok, true);
  assert.equal(typeof payload.summary.candidateCount, 'number');
  assert.equal(typeof payload.summary.deletedBatches, 'number');
  assert.equal(typeof payload.summary.deletedBytes, 'number');
  assert.equal(Array.isArray(payload.data?.report?.selectedCandidates), true);
  assert.equal(Array.isArray(payload.data?.report?.operations), true);
  assert.equal(typeof payload.data?.report?.before?.totalBatches, 'number');
  assert.equal(typeof payload.data?.report?.after?.totalBatches, 'number');
});

test('无交互 --output text 输出中文任务卡片（覆盖全部动作）', async (t) => {
  const root = await makeTempDir('wecom-cli-ni-text-output-');
  t.after(async () => removeDir(root));

  const profilesRoot = await prepareFixture(root);
  const stateRoot = path.join(root, 'state');

  const cleanupText = runCli([
    '--cleanup-monthly',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--accounts',
    'all',
    '--categories',
    'files',
    '--months',
    '2024-01',
    '--external-storage-auto-detect',
    'false',
    '--output',
    'text',
  ]);
  assert.equal(cleanupText.status, 0);
  assert.match(String(cleanupText.stdout || ''), /任务结论/);
  assert.match(String(cleanupText.stdout || ''), /分类统计（按命中范围）/);
  assert.match(String(cleanupText.stdout || ''), /月份统计（按命中范围）/);

  const analysisText = runCli([
    '--analysis-only',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--accounts',
    'all',
    '--external-storage-auto-detect',
    'false',
    '--output',
    'text',
  ]);
  assert.equal(analysisText.status, 0);
  assert.match(String(analysisText.stdout || ''), /只读分析完成/);
  assert.match(String(analysisText.stdout || ''), /结果统计/);

  const governanceText = runCli([
    '--space-governance',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--accounts',
    'all',
    '--external-storage-auto-detect',
    'false',
    '--output',
    'text',
  ]);
  assert.equal(governanceText.status, 0);
  assert.match(String(governanceText.stdout || ''), /分级统计（按命中范围）/);

  const cleanupExec = runCli([
    '--cleanup-monthly',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--accounts',
    'all',
    '--categories',
    'files',
    '--months',
    '2024-01',
    '--external-storage-auto-detect',
    'false',
    '--dry-run',
    'false',
    '--yes',
  ]);
  assert.equal(cleanupExec.status, 0);
  const batchId = await readLastCleanupBatchId(path.join(stateRoot, 'index.jsonl'));
  assert.equal(typeof batchId, 'string');
  assert.equal(Boolean(batchId), true);

  const restoreText = runCli([
    '--restore-batch',
    batchId,
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--conflict',
    'rename',
    '--external-storage-auto-detect',
    'false',
    '--output',
    'text',
  ]);
  assert.equal(restoreText.status, 0);
  assert.match(String(restoreText.stdout || ''), /作用域统计（按批次命中）/);

  const recycleText = runCli([
    '--recycle-maintain',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--external-storage-auto-detect',
    'false',
    '--output',
    'text',
  ]);
  assert.equal(recycleText.status, 0);
  assert.match(String(recycleText.stdout || ''), /操作分布/);

  const doctorText = runCli([
    '--doctor',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--external-storage-auto-detect',
    'false',
    '--output',
    'text',
  ]);
  assert.equal(doctorText.status, 0);
  assert.match(String(doctorText.stdout || ''), /检查统计/);
});

test('无交互 cleanup 支持 --run-task preview-execute-verify 三阶段协议', async (t) => {
  const root = await makeTempDir('wecom-cli-ni-run-task-');
  t.after(async () => removeDir(root));

  const profilesRoot = await prepareFixture(root);
  const stateRoot = path.join(root, 'state');

  const result = runCli([
    '--cleanup-monthly',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--accounts',
    'all',
    '--categories',
    'files',
    '--months',
    '2024-01',
    '--run-task',
    'preview-execute-verify',
    '--yes',
    '--external-storage-auto-detect',
    'false',
  ]);
  assert.equal(result.status, 0);

  const payload = JSON.parse(String(result.stdout || '{}'));
  assert.equal(payload.action, 'cleanup_monthly');
  assert.equal(payload.summary.runTaskMode, 'preview-execute-verify');
  assert.equal(payload.summary.taskDecision, 'executed_and_verified');
  assert.equal(Array.isArray(payload.data?.taskPhases), true);
  assert.equal(payload.data.taskPhases.length, 3);
  assert.equal(payload.data.taskPhases[0].name, 'preview');
  assert.equal(payload.data.taskPhases[1].name, 'execute');
  assert.equal(payload.data.taskPhases[2].name, 'verify');
  assert.equal(payload.data.taskPhases[1].status, 'completed');
  assert.equal(payload.data.taskPhases[1].stats.successCount >= 1, true);
  assert.equal(typeof payload.data?.taskCard?.conclusion, 'string');
});

test('无交互 cleanup 在 --run-task 三阶段下无命中时自动跳过执行', async (t) => {
  const root = await makeTempDir('wecom-cli-ni-run-task-empty-');
  t.after(async () => removeDir(root));

  const profilesRoot = await prepareFixture(root);
  const stateRoot = path.join(root, 'state');

  const result = runCli([
    '--cleanup-monthly',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--accounts',
    'all',
    '--categories',
    'files',
    '--months',
    '2024-02',
    '--run-task',
    'preview-execute-verify',
    '--yes',
    '--external-storage-auto-detect',
    'false',
  ]);
  assert.equal(result.status, 0);

  const payload = JSON.parse(String(result.stdout || '{}'));
  assert.equal(payload.summary.taskDecision, 'skipped_no_target');
  assert.equal(Array.isArray(payload.data?.taskPhases), true);
  assert.equal(payload.data.taskPhases[1].status, 'skipped');
  assert.equal(payload.data.taskPhases[1].reason, 'no_target');
});

test('无交互 --run-task execute 缺少 --yes 时返回确认错误', async (t) => {
  const root = await makeTempDir('wecom-cli-ni-run-task-confirm-');
  t.after(async () => removeDir(root));

  const profilesRoot = await prepareFixture(root);
  const stateRoot = path.join(root, 'state');

  const result = runCli([
    '--cleanup-monthly',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--accounts',
    'all',
    '--categories',
    'files',
    '--months',
    '2024-01',
    '--run-task',
    'execute',
    '--external-storage-auto-detect',
    'false',
  ]);
  assert.equal(result.status, 3);
  assert.match(String(result.stderr || ''), /确认错误/);
});

test('非破坏性动作仅支持 --run-task preview', async (t) => {
  const root = await makeTempDir('wecom-cli-ni-run-task-analysis-');
  t.after(async () => removeDir(root));

  const profilesRoot = await prepareFixture(root);
  const stateRoot = path.join(root, 'state');

  const result = runCli([
    '--analysis-only',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--run-task',
    'execute',
  ]);
  assert.equal(result.status, 2);
  assert.match(String(result.stderr || ''), /仅支持 --run-task preview/);
});

test('无交互支持 --scan-debug summary/full 输出扫描诊断', async (t) => {
  const root = await makeTempDir('wecom-cli-ni-scan-debug-');
  t.after(async () => removeDir(root));

  const profilesRoot = await prepareFixture(root);
  const stateRoot = path.join(root, 'state');

  const summaryResult = runCli([
    '--cleanup-monthly',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--accounts',
    'all',
    '--categories',
    'files',
    '--months',
    '2024-01',
    '--scan-debug',
    'summary',
    '--external-storage-auto-detect',
    'false',
  ]);
  assert.equal(summaryResult.status, 0);
  const summaryPayload = JSON.parse(String(summaryResult.stdout || '{}'));
  assert.equal(summaryPayload.data?.scanDebug?.level, 'summary');
  assert.equal(typeof summaryPayload.data?.scanDebug?.summary?.matchedTargets, 'number');
  assert.equal(summaryPayload.data?.scanDebug?.full, undefined);

  const fullResult = runCli([
    '--cleanup-monthly',
    '--root',
    profilesRoot,
    '--state-root',
    stateRoot,
    '--accounts',
    'all',
    '--categories',
    'files',
    '--months',
    '2024-01',
    '--scan-debug',
    'full',
    '--external-storage-auto-detect',
    'false',
  ]);
  assert.equal(fullResult.status, 0);
  const fullPayload = JSON.parse(String(fullResult.stdout || '{}'));
  assert.equal(fullPayload.data?.scanDebug?.level, 'full');
  assert.equal(Array.isArray(fullPayload.data?.scanDebug?.full?.selectedAccounts), true);
});
