import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
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

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      WECOM_CLEANER_NATIVE_AUTO_REPAIR: 'false',
      ...env,
    },
    encoding: 'utf-8',
  });
}

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
  assert.equal(payload.summary.successCount >= 1, true);

  const sourcePath = path.join(profilesRoot, 'acc001', 'Caches', 'Files', '2024-01');
  const exists = await fs
    .stat(sourcePath)
    .then(() => true)
    .catch(() => false);
  assert.equal(exists, true);
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
