import path from 'node:path';
import { DEFAULT_PROFILE_ROOT, DEFAULT_STATE_ROOT } from './constants.js';
import { ensureDir, expandHome, readJson, writeJson } from './utils.js';
import { normalizeRecycleRetention } from './recycle-maintenance.js';

const ALLOWED_THEMES = new Set(['auto', 'light', 'dark']);

export class CliArgError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliArgError';
  }
}

function normalizeTheme(theme) {
  if (typeof theme !== 'string') {
    return null;
  }
  const normalized = theme.trim().toLowerCase();
  if (!ALLOWED_THEMES.has(normalized)) {
    return null;
  }
  return normalized;
}

export function defaultConfig() {
  const stateRoot = DEFAULT_STATE_ROOT;
  const recycleRetention = normalizeRecycleRetention({
    enabled: true,
    maxAgeDays: 30,
    minKeepBatches: 20,
    sizeThresholdGB: 20,
    lastRunAt: 0,
  });
  return {
    rootDir: DEFAULT_PROFILE_ROOT,
    externalStorageRoots: [],
    externalStorageAutoDetect: true,
    stateRoot,
    recycleRoot: path.join(stateRoot, 'recycle-bin'),
    indexPath: path.join(stateRoot, 'index.jsonl'),
    aliasPath: path.join(stateRoot, 'account-aliases.json'),
    dryRunDefault: true,
    defaultCategories: [],
    spaceGovernance: {
      autoSuggest: {
        sizeThresholdMB: 512,
        idleDays: 7,
      },
      cooldownSeconds: 5,
      lastSelectedTargets: [],
    },
    recycleRetention,
    theme: 'auto',
  };
}

function normalizePositiveInt(rawValue, fallbackValue, minValue = 1) {
  const num = Number.parseInt(String(rawValue ?? ''), 10);
  if (!Number.isFinite(num) || num < minValue) {
    return fallbackValue;
  }
  return num;
}

function normalizeSpaceGovernance(input, fallback) {
  const source = input && typeof input === 'object' ? input : {};
  const autoSuggest = source.autoSuggest && typeof source.autoSuggest === 'object' ? source.autoSuggest : {};

  return {
    autoSuggest: {
      sizeThresholdMB: normalizePositiveInt(
        autoSuggest.sizeThresholdMB,
        fallback.autoSuggest.sizeThresholdMB
      ),
      idleDays: normalizePositiveInt(autoSuggest.idleDays, fallback.autoSuggest.idleDays),
    },
    cooldownSeconds: normalizePositiveInt(source.cooldownSeconds, fallback.cooldownSeconds),
    lastSelectedTargets: Array.isArray(source.lastSelectedTargets)
      ? source.lastSelectedTargets.filter((x) => typeof x === 'string' && x.trim())
      : fallback.lastSelectedTargets,
  };
}

export function parseCliArgs(argv) {
  const parsed = {
    rootDir: null,
    externalStorageRoots: null,
    externalStorageAutoDetect: null,
    stateRoot: null,
    dryRunDefault: null,
    mode: null,
    theme: null,
    jsonOutput: false,
    force: false,
  };

  const takeValue = (flag, index) => {
    const value = argv[index + 1];
    if (!value || value.startsWith('-')) {
      throw new CliArgError(`参数 ${flag} 缺少值`);
    }
    return value;
  };

  const parseBooleanFlag = (flag, rawValue) => {
    const normalized = String(rawValue).trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
      return false;
    }
    throw new CliArgError(`参数 ${flag} 的值无效: ${rawValue}`);
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--root') {
      parsed.rootDir = takeValue(token, i);
      i += 1;
      continue;
    }
    if (token === '--state-root') {
      parsed.stateRoot = takeValue(token, i);
      i += 1;
      continue;
    }
    if (token === '--external-storage-root') {
      parsed.externalStorageRoots = takeValue(token, i);
      i += 1;
      continue;
    }
    if (token === '--external-storage-auto-detect') {
      parsed.externalStorageAutoDetect = parseBooleanFlag(token, takeValue(token, i));
      i += 1;
      continue;
    }
    if (token === '--dry-run-default') {
      parsed.dryRunDefault = parseBooleanFlag(token, takeValue(token, i));
      i += 1;
      continue;
    }
    if (token === '--mode') {
      parsed.mode = takeValue(token, i);
      i += 1;
      continue;
    }
    if (token === '--theme') {
      const theme = normalizeTheme(takeValue(token, i));
      if (!theme) {
        throw new CliArgError(`参数 --theme 的值无效: ${argv[i + 1]}`);
      }
      parsed.theme = theme;
      i += 1;
      continue;
    }
    if (token === '--json') {
      parsed.jsonOutput = true;
      continue;
    }
    if (token === '--force') {
      parsed.force = true;
      continue;
    }
    if (token.startsWith('-')) {
      throw new CliArgError(`不支持的参数: ${token}`);
    }
  }

  return parsed;
}

function normalizePathList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => expandHome(String(item || '').trim())).filter((item) => item && item.trim());
  }
  if (typeof value === 'string') {
    return value
      .split(/[,\n;]/)
      .map((item) => expandHome(String(item || '').trim()))
      .filter((item) => item && item.trim());
  }
  return [];
}

export async function loadConfig(cliArgs = {}) {
  const base = defaultConfig();
  const bootstrapStateRoot = expandHome(cliArgs.stateRoot || base.stateRoot);
  const bootstrapConfigPath = path.join(bootstrapStateRoot, 'config.json');

  let fileConfig = await readJson(bootstrapConfigPath, {});
  const preferredStateRoot = expandHome(cliArgs.stateRoot || fileConfig.stateRoot || base.stateRoot);
  const configPath = path.join(preferredStateRoot, 'config.json');
  if (preferredStateRoot !== bootstrapStateRoot) {
    fileConfig = await readJson(configPath, fileConfig);
  }

  const stateRoot = preferredStateRoot;

  const merged = {
    ...base,
    ...fileConfig,
    rootDir: expandHome(cliArgs.rootDir || fileConfig.rootDir || base.rootDir),
    externalStorageRoots:
      normalizePathList(cliArgs.externalStorageRoots).length > 0
        ? normalizePathList(cliArgs.externalStorageRoots)
        : normalizePathList(fileConfig.externalStorageRoots),
    externalStorageAutoDetect:
      typeof cliArgs.externalStorageAutoDetect === 'boolean'
        ? cliArgs.externalStorageAutoDetect
        : typeof fileConfig.externalStorageAutoDetect === 'boolean'
          ? fileConfig.externalStorageAutoDetect
          : base.externalStorageAutoDetect,
    stateRoot,
    dryRunDefault:
      typeof cliArgs.dryRunDefault === 'boolean'
        ? cliArgs.dryRunDefault
        : typeof fileConfig.dryRunDefault === 'boolean'
          ? fileConfig.dryRunDefault
          : base.dryRunDefault,
    theme: normalizeTheme(cliArgs.theme || fileConfig.theme || base.theme) || base.theme,
  };

  merged.spaceGovernance = normalizeSpaceGovernance(fileConfig.spaceGovernance, base.spaceGovernance);
  merged.recycleRetention = normalizeRecycleRetention(fileConfig.recycleRetention, base.recycleRetention);

  merged.recycleRoot = expandHome(fileConfig.recycleRoot || path.join(stateRoot, 'recycle-bin'));
  merged.indexPath = expandHome(fileConfig.indexPath || path.join(stateRoot, 'index.jsonl'));
  merged.aliasPath = expandHome(fileConfig.aliasPath || path.join(stateRoot, 'account-aliases.json'));
  merged.configPath = configPath;

  await ensureDir(merged.stateRoot);
  await ensureDir(merged.recycleRoot);

  return merged;
}

export async function saveConfig(config) {
  const payload = {
    rootDir: config.rootDir,
    externalStorageRoots: normalizePathList(config.externalStorageRoots),
    externalStorageAutoDetect:
      typeof config.externalStorageAutoDetect === 'boolean' ? config.externalStorageAutoDetect : true,
    stateRoot: config.stateRoot,
    recycleRoot: config.recycleRoot,
    indexPath: config.indexPath,
    aliasPath: config.aliasPath,
    dryRunDefault: Boolean(config.dryRunDefault),
    defaultCategories: Array.isArray(config.defaultCategories) ? config.defaultCategories : [],
    spaceGovernance: normalizeSpaceGovernance(config.spaceGovernance, defaultConfig().spaceGovernance),
    recycleRetention: normalizeRecycleRetention(config.recycleRetention, defaultConfig().recycleRetention),
    theme: normalizeTheme(config.theme) || 'auto',
  };
  await writeJson(config.configPath, payload);
}

export async function loadAliases(aliasPath) {
  const raw = await readJson(aliasPath, {});
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  return raw;
}

export async function saveAliases(aliasPath, aliases) {
  await writeJson(aliasPath, aliases || {});
}
