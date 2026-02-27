import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { makeTempDir, removeDir } from './helpers/temp.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const SKILL_CLI_PATH = path.join(REPO_ROOT, 'src', 'skill-cli.js');

function runSkillCli(args, options = {}) {
  return spawnSync(process.execPath, [SKILL_CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...options.env,
    },
    encoding: 'utf-8',
  });
}

test('skill-cli --help 输出帮助并成功退出', () => {
  const result = runSkillCli(['--help']);
  assert.equal(result.status, 0);
  assert.match(String(result.stdout || ''), /wecom-cleaner-skill/);
  assert.match(String(result.stdout || ''), /install/);
});

test('skill-cli path 在 CODEX_HOME 下输出默认技能目录', async (t) => {
  const root = await makeTempDir('wecom-skill-cli-path-');
  t.after(async () => removeDir(root));

  const result = runSkillCli(['path'], {
    env: { CODEX_HOME: root },
  });

  assert.equal(result.status, 0);
  assert.equal(String(result.stdout || '').trim(), path.join(root, 'skills'));
});

test('skill-cli install --dry-run 不写入目标目录', async (t) => {
  const root = await makeTempDir('wecom-skill-cli-dryrun-');
  t.after(async () => removeDir(root));

  const targetRoot = path.join(root, 'skills');
  const targetSkill = path.join(targetRoot, 'wecom-cleaner-agent');

  const result = runSkillCli(['install', '--dry-run', '--target', targetRoot]);

  assert.equal(result.status, 0);
  assert.match(String(result.stdout || ''), /预演成功/);

  const exists = await fs
    .stat(targetSkill)
    .then(() => true)
    .catch(() => false);
  assert.equal(exists, false);
});

test('skill-cli status 在未安装时返回失败并给出建议', async (t) => {
  const root = await makeTempDir('wecom-skill-cli-status-empty-');
  t.after(async () => removeDir(root));

  const targetRoot = path.join(root, 'skills');
  const result = runSkillCli(['status', '--target', targetRoot]);
  assert.equal(result.status, 1);
  assert.match(String(result.stdout || ''), /未安装/);
  assert.match(String(result.stdout || ''), /建议/);

  const jsonResult = runSkillCli(['status', '--target', targetRoot, '--json']);
  assert.equal(jsonResult.status, 1);
  const payload = JSON.parse(String(jsonResult.stdout || '{}'));
  assert.equal(payload.matched, false);
  assert.equal(payload.status, 'not_installed');
});

test('skill-cli install 支持冲突报错与 --force 覆盖', async (t) => {
  const root = await makeTempDir('wecom-skill-cli-install-');
  t.after(async () => removeDir(root));

  const targetRoot = path.join(root, 'skills');
  const targetSkill = path.join(targetRoot, 'wecom-cleaner-agent', 'SKILL.md');

  const first = runSkillCli(['install', '--target', targetRoot]);
  assert.equal(first.status, 0);

  const conflict = runSkillCli(['install', '--target', targetRoot]);
  assert.equal(conflict.status, 1);
  assert.match(String(conflict.stderr || ''), /目标技能已存在/);

  const force = runSkillCli(['install', '--target', targetRoot, '--force']);
  assert.equal(force.status, 0);

  const content = await fs.readFile(targetSkill, 'utf-8');
  assert.match(content, /^---/);
});

test('skill-cli sync 可覆盖安装且 status --json 返回匹配状态', async (t) => {
  const root = await makeTempDir('wecom-skill-cli-sync-');
  t.after(async () => removeDir(root));

  const targetRoot = path.join(root, 'skills');
  const syncResult = runSkillCli(['sync', '--target', targetRoot]);
  assert.equal(syncResult.status, 0);
  assert.match(String(syncResult.stdout || ''), /安装成功/);

  const statusResult = runSkillCli(['status', '--target', targetRoot, '--json']);
  const payload = JSON.parse(String(statusResult.stdout || '{}'));
  assert.equal(payload.status, 'matched');
  assert.equal(payload.matched, true);
});

test('skill-cli 对无效命令或参数返回失败', () => {
  const invalidCommand = runSkillCli(['unknown']);
  assert.equal(invalidCommand.status, 1);
  assert.match(String(invalidCommand.stderr || ''), /不支持的命令/);

  const invalidArg = runSkillCli(['install', '--bad-arg']);
  assert.equal(invalidArg.status, 1);
  assert.match(String(invalidArg.stderr || ''), /未知参数/);
});
