import path from 'node:path';
import { DEFAULT_PROFILE_ROOT, DEFAULT_STATE_ROOT } from './constants.js';
import { ensureDir, expandHome, readJson, writeJson } from './utils.js';

const ALLOWED_THEMES = new Set(['auto', 'light', 'dark']);

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
  return {
    rootDir: DEFAULT_PROFILE_ROOT,
    stateRoot,
    recycleRoot: path.join(stateRoot, 'recycle-bin'),
    indexPath: path.join(stateRoot, 'index.jsonl'),
    aliasPath: path.join(stateRoot, 'account-aliases.json'),
    dryRunDefault: true,
    defaultCategories: [],
    theme: 'auto',
  };
}

export function parseCliArgs(argv) {
  const parsed = {
    rootDir: null,
    stateRoot: null,
    dryRunDefault: null,
    mode: null,
    theme: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--root' && argv[i + 1]) {
      parsed.rootDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--state-root' && argv[i + 1]) {
      parsed.stateRoot = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--dry-run-default' && argv[i + 1]) {
      const raw = argv[i + 1].toLowerCase();
      parsed.dryRunDefault = raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y';
      i += 1;
      continue;
    }
    if (token === '--mode' && argv[i + 1]) {
      parsed.mode = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--theme' && argv[i + 1]) {
      parsed.theme = normalizeTheme(argv[i + 1]);
      i += 1;
      continue;
    }
  }

  return parsed;
}

export async function loadConfig(cliArgs = {}) {
  const base = defaultConfig();
  const stateRoot = expandHome(cliArgs.stateRoot || base.stateRoot);
  const configPath = path.join(stateRoot, 'config.json');

  const fileConfig = await readJson(configPath, {});

  const merged = {
    ...base,
    ...fileConfig,
    rootDir: expandHome(cliArgs.rootDir || fileConfig.rootDir || base.rootDir),
    stateRoot,
    dryRunDefault:
      typeof cliArgs.dryRunDefault === 'boolean'
        ? cliArgs.dryRunDefault
        : typeof fileConfig.dryRunDefault === 'boolean'
          ? fileConfig.dryRunDefault
          : base.dryRunDefault,
    theme: normalizeTheme(cliArgs.theme || fileConfig.theme || base.theme) || base.theme,
  };

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
    stateRoot: config.stateRoot,
    recycleRoot: config.recycleRoot,
    indexPath: config.indexPath,
    aliasPath: config.aliasPath,
    dryRunDefault: Boolean(config.dryRunDefault),
    defaultCategories: Array.isArray(config.defaultCategories) ? config.defaultCategories : [],
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
