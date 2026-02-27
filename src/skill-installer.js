import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, cp, mkdir, readFile, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

export const SKILL_NAME = 'wecom-cleaner-agent';
export const SKILL_VERSION_FILE = 'version.json';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_SOURCE_SKILL_DIR = path.join(PROJECT_ROOT, 'skills', SKILL_NAME);
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

function normalizeSemver(rawValue) {
  const text = String(rawValue || '').trim();
  if (!text) {
    return '';
  }
  const matched = text.match(SEMVER_RE);
  if (!matched) {
    return '';
  }
  const base = `${matched[1]}.${matched[2]}.${matched[3]}`;
  return matched[4] ? `${base}-${matched[4]}` : base;
}

function buildFallbackManifest(appVersion = '') {
  const normalizedAppVersion = normalizeSemver(appVersion) || '0.0.0';
  return {
    schemaVersion: 1,
    skillName: SKILL_NAME,
    skillVersion: normalizedAppVersion,
    requiredAppVersion: normalizedAppVersion,
  };
}

function normalizeSkillManifest(rawManifest, options = {}) {
  const fallback = buildFallbackManifest(options.appVersion);
  const source = rawManifest && typeof rawManifest === 'object' ? rawManifest : {};
  const schemaVersion = Number.isFinite(Number(source.schemaVersion))
    ? Number(source.schemaVersion)
    : fallback.schemaVersion;
  const skillName =
    typeof source.skillName === 'string' && source.skillName.trim()
      ? source.skillName.trim()
      : fallback.skillName;
  const skillVersion = normalizeSemver(source.skillVersion) || fallback.skillVersion;
  const requiredAppVersion = normalizeSemver(source.requiredAppVersion) || fallback.requiredAppVersion;
  return {
    schemaVersion,
    skillName,
    skillVersion,
    requiredAppVersion,
  };
}

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

export function skillBindingStatusLabel(status) {
  if (status === 'matched') {
    return '已匹配';
  }
  if (status === 'mismatch') {
    return '版本不匹配';
  }
  if (status === 'legacy_unversioned') {
    return '旧版技能（缺少版本信息）';
  }
  if (status === 'not_installed') {
    return '未安装';
  }
  if (status === 'invalid_skill_dir') {
    return '安装目录异常';
  }
  return '未知';
}

export async function readSkillManifestFromDir(skillDir, options = {}) {
  const resolvedSkillDir = path.resolve(String(skillDir || ''));
  const manifestPath = path.join(resolvedSkillDir, SKILL_VERSION_FILE);
  const manifestExists = await exists(manifestPath);
  if (!manifestExists) {
    return {
      path: manifestPath,
      exists: false,
      parseError: '',
      manifest: normalizeSkillManifest(null, options),
    };
  }

  try {
    const text = await readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(text);
    return {
      path: manifestPath,
      exists: true,
      parseError: '',
      manifest: normalizeSkillManifest(parsed, options),
    };
  } catch (error) {
    return {
      path: manifestPath,
      exists: true,
      parseError: error instanceof Error ? error.message : String(error),
      manifest: normalizeSkillManifest(null, options),
    };
  }
}

export async function inspectSkillBinding(options = {}) {
  const appVersion = normalizeSemver(options.appVersion);
  const sourceSkillDir = path.resolve(options.sourceSkillDir || DEFAULT_SOURCE_SKILL_DIR);
  const sourceSkillFile = path.join(sourceSkillDir, 'SKILL.md');
  if (!(await exists(sourceSkillFile))) {
    throw new Error(`技能源目录无效，缺少 SKILL.md: ${sourceSkillDir}`);
  }

  const sourceManifestState = await readSkillManifestFromDir(sourceSkillDir, {
    appVersion,
  });
  const expectedAppVersion = appVersion || sourceManifestState.manifest.requiredAppVersion;
  const targetRoot = resolveTargetSkillsRoot(options.targetRoot, options.env || process.env);
  const targetSkillDir = path.join(targetRoot, SKILL_NAME);
  const targetSkillExists = await exists(targetSkillDir);
  const targetSkillFile = path.join(targetSkillDir, 'SKILL.md');
  const targetSkillFileExists = targetSkillExists ? await exists(targetSkillFile) : false;
  const installedManifestState = targetSkillExists
    ? await readSkillManifestFromDir(targetSkillDir, {
        appVersion: expectedAppVersion,
      })
    : null;

  const recommendation = (() => {
    if (!targetSkillExists) {
      return '执行 wecom-cleaner-skill install 安装技能。';
    }
    if (!targetSkillFileExists) {
      return '目标目录缺少 SKILL.md，建议执行 wecom-cleaner-skill install --force 修复。';
    }
    if (installedManifestState && !installedManifestState.exists) {
      return '检测到旧版技能（缺少 version.json），建议执行 wecom-cleaner-skill install --force。';
    }
    if (
      installedManifestState &&
      installedManifestState.manifest.skillName === SKILL_NAME &&
      installedManifestState.manifest.requiredAppVersion === expectedAppVersion
    ) {
      return '';
    }
    return '建议执行 wecom-cleaner-skill install --force 同步技能版本。';
  })();

  let status = 'matched';
  let matched = true;
  if (!targetSkillExists) {
    status = 'not_installed';
    matched = false;
  } else if (!targetSkillFileExists) {
    status = 'invalid_skill_dir';
    matched = false;
  } else if (installedManifestState && !installedManifestState.exists) {
    status = 'legacy_unversioned';
    matched = false;
  } else if (
    !installedManifestState ||
    installedManifestState.manifest.skillName !== SKILL_NAME ||
    installedManifestState.manifest.requiredAppVersion !== expectedAppVersion
  ) {
    status = 'mismatch';
    matched = false;
  }

  return {
    skillName: SKILL_NAME,
    status,
    matched,
    recommendation,
    expectedAppVersion: expectedAppVersion || '',
    sourceSkillDir,
    sourceManifestPath: sourceManifestState.path,
    sourceManifest: sourceManifestState.manifest,
    sourceManifestExists: sourceManifestState.exists,
    sourceManifestParseError: sourceManifestState.parseError || '',
    targetRoot,
    targetSkillDir,
    installed: targetSkillExists,
    installedSkillFileExists: targetSkillFileExists,
    installedManifestPath: installedManifestState?.path || path.join(targetSkillDir, SKILL_VERSION_FILE),
    installedManifest: installedManifestState?.manifest || null,
    installedManifestExists: Boolean(installedManifestState?.exists),
    installedManifestParseError: installedManifestState?.parseError || '',
  };
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
  const sourceManifestState = await readSkillManifestFromDir(sourceSkillDir, {
    appVersion: options.appVersion,
  });

  const targetSkillDir = path.join(targetRoot, SKILL_NAME);
  const targetExists = await exists(targetSkillDir);
  const previousManifestState = targetExists
    ? await readSkillManifestFromDir(targetSkillDir, {
        appVersion: options.appVersion || sourceManifestState.manifest.requiredAppVersion,
      })
    : null;
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

  const targetManifestState = dryRun
    ? sourceManifestState
    : await readSkillManifestFromDir(targetSkillDir, {
        appVersion: options.appVersion || sourceManifestState.manifest.requiredAppVersion,
      });

  return {
    skillName: SKILL_NAME,
    sourceSkillDir,
    targetRoot,
    targetSkillDir,
    dryRun,
    replaced: targetExists,
    sourceManifest: sourceManifestState.manifest,
    sourceManifestPath: sourceManifestState.path,
    previousManifest: previousManifestState?.manifest || null,
    previousManifestPath: previousManifestState?.path || null,
    previousManifestExists: Boolean(previousManifestState?.exists),
    targetManifest: targetManifestState.manifest,
    targetManifestPath: targetManifestState.path,
    targetManifestExists: targetManifestState.exists,
  };
}
