import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  SKILL_NAME,
  installSkill,
  resolveDefaultSkillsRoot,
  resolveTargetSkillsRoot,
} from '../src/skill-installer.js';
import { ensureFile, makeTempDir, removeDir } from './helpers/temp.js';

test('resolveDefaultSkillsRoot 优先使用 CODEX_HOME', () => {
  const root = resolveDefaultSkillsRoot({ CODEX_HOME: '/tmp/codex-home' });
  assert.equal(root, path.resolve('/tmp/codex-home', 'skills'));
});

test('resolveTargetSkillsRoot 可回退默认目录', () => {
  const root = resolveTargetSkillsRoot('', { CODEX_HOME: '/tmp/codex-home-2' });
  assert.equal(root, path.resolve('/tmp/codex-home-2', 'skills'));
});

test('installSkill 可安装技能目录', async (t) => {
  const workspace = await makeTempDir('wecom-skill-installer-');
  t.after(async () => removeDir(workspace));

  const sourceSkillDir = path.join(workspace, 'source', SKILL_NAME);
  await ensureFile(path.join(sourceSkillDir, 'SKILL.md'), '# demo');
  await ensureFile(path.join(sourceSkillDir, 'references', 'commands.md'), 'demo');

  const targetRoot = path.join(workspace, 'target', 'skills');
  const result = await installSkill({ sourceSkillDir, targetRoot });

  assert.equal(result.skillName, SKILL_NAME);
  assert.equal(result.replaced, false);
  const installedSkill = path.join(targetRoot, SKILL_NAME, 'SKILL.md');
  const installedExists = await fs
    .stat(installedSkill)
    .then(() => true)
    .catch(() => false);
  assert.equal(installedExists, true);
});

test('installSkill 在已存在且无 force 时会失败', async (t) => {
  const workspace = await makeTempDir('wecom-skill-installer-conflict-');
  t.after(async () => removeDir(workspace));

  const sourceSkillDir = path.join(workspace, 'source', SKILL_NAME);
  const targetRoot = path.join(workspace, 'target', 'skills');

  await ensureFile(path.join(sourceSkillDir, 'SKILL.md'), '# v1');
  await ensureFile(path.join(targetRoot, SKILL_NAME, 'SKILL.md'), '# old');

  await assert.rejects(() => installSkill({ sourceSkillDir, targetRoot }), /目标技能已存在.*--force/);
});

test('installSkill 在 force 模式可覆盖旧版本', async (t) => {
  const workspace = await makeTempDir('wecom-skill-installer-force-');
  t.after(async () => removeDir(workspace));

  const sourceSkillDir = path.join(workspace, 'source', SKILL_NAME);
  const targetRoot = path.join(workspace, 'target', 'skills');
  const targetSkillFile = path.join(targetRoot, SKILL_NAME, 'SKILL.md');

  await ensureFile(path.join(sourceSkillDir, 'SKILL.md'), '# new');
  await ensureFile(targetSkillFile, '# old');

  const result = await installSkill({ sourceSkillDir, targetRoot, force: true });
  assert.equal(result.replaced, true);

  const content = await fs.readFile(targetSkillFile, 'utf-8');
  assert.equal(content, '# new');
});

test('installSkill 在 dry-run 模式只返回计划不写入文件', async (t) => {
  const workspace = await makeTempDir('wecom-skill-installer-dryrun-');
  t.after(async () => removeDir(workspace));

  const sourceSkillDir = path.join(workspace, 'source', SKILL_NAME);
  const targetRoot = path.join(workspace, 'target', 'skills');
  const targetSkillFile = path.join(targetRoot, SKILL_NAME, 'SKILL.md');

  await ensureFile(path.join(sourceSkillDir, 'SKILL.md'), '# new');

  const result = await installSkill({ sourceSkillDir, targetRoot, dryRun: true });
  assert.equal(result.dryRun, true);

  const existsAfterDryRun = await fs
    .stat(targetSkillFile)
    .then(() => true)
    .catch(() => false);
  assert.equal(existsAfterDryRun, false);

  const targetRootExists = await fs
    .stat(targetRoot)
    .then(() => true)
    .catch(() => false);
  assert.equal(targetRootExists, false);
});
