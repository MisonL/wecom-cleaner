import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, cp, mkdir, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

export const SKILL_NAME = 'wecom-cleaner-agent';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SOURCE_SKILL_DIR = path.join(PROJECT_ROOT, 'skills', SKILL_NAME);

export function resolveDefaultSkillsRoot(env = process.env) {
  const codexHome = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '';
  if (codexHome) {
    return path.resolve(codexHome, 'skills');
  }
  return path.resolve(os.homedir(), '.codex', 'skills');
}

export function resolveTargetSkillsRoot(rawTarget, env = process.env) {
  if (typeof rawTarget === 'string' && rawTarget.trim()) {
    return path.resolve(rawTarget.trim());
  }
  return resolveDefaultSkillsRoot(env);
}

async function exists(targetPath) {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function installSkill(options = {}) {
  const sourceSkillDir = path.resolve(options.sourceSkillDir || DEFAULT_SOURCE_SKILL_DIR);
  const targetRoot = resolveTargetSkillsRoot(options.targetRoot);
  const dryRun = options.dryRun === true;
  const force = options.force === true;

  const sourceSkillFile = path.join(sourceSkillDir, 'SKILL.md');
  const sourceExists = await exists(sourceSkillFile);
  if (!sourceExists) {
    throw new Error(`技能源目录无效，缺少 SKILL.md: ${sourceSkillDir}`);
  }

  const targetSkillDir = path.join(targetRoot, SKILL_NAME);
  const targetExists = await exists(targetSkillDir);
  if (targetExists && !force) {
    throw new Error(`目标技能已存在：${targetSkillDir}。如需覆盖请加 --force`);
  }

  if (!dryRun) {
    await mkdir(targetRoot, { recursive: true });
    if (targetExists) {
      await rm(targetSkillDir, { recursive: true, force: true });
    }
    await cp(sourceSkillDir, targetSkillDir, {
      recursive: true,
      force: true,
      preserveTimestamps: true,
    });
  }

  return {
    skillName: SKILL_NAME,
    sourceSkillDir,
    targetRoot,
    targetSkillDir,
    dryRun,
    replaced: targetExists,
  };
}
