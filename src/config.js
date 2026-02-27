import path from 'node:path';
import { DEFAULT_PROFILE_ROOT, DEFAULT_STATE_ROOT } from './constants.js';
import { ensureDir, expandHome, readJson, writeJson } from './utils.js';
import { normalizeRecycleRetention } from './recycle-maintenance.js';
import { normalizeSelfUpdateConfig } from './updater.js';

const ALLOWED_THEMES = new Set(['auto', 'light', 'dark']);
const ALLOWED_OUTPUTS = new Set(['json', 'text']);
const ALLOWED_CONFLICT_STRATEGIES = new Set(['skip', 'overwrite', 'rename']);
const ALLOWED_EXTERNAL_ROOT_SOURCES = new Set(['preset', 'configured', 'auto', 'all']);
const ALLOWED_GOVERNANCE_TIERS = new Set(['safe', 'caution', 'protected']);
const ALLOWED_UPGRADE_METHODS = new Set(['npm', 'github-script']);
const ALLOWED_UPGRADE_CHANNELS = new Set(['stable', 'pre']);
const ALLOWED_RUN_TASK_MODES = new Set(['preview', 'execute', 'preview-execute-verify']);
const ALLOWED_SCAN_DEBUG_LEVELS = new Set(['off', 'summary', 'full']);
const ACTION_FLAG_MAP = new Map([
  ['--cleanup-monthly', 'cleanup_monthly'],
  ['--analysis-only', 'analysis_only'],
  ['--space-governance', 'space_governance'],
  ['--recycle-maintain', 'recycle_maintain'],
  ['--doctor', 'doctor'],
  ['--check-update', 'check_update'],
]);
const MODE_TO_ACTION_MAP = new Map([
  ['cleanup_monthly', 'cleanup_monthly'],
  ['analysis_only', 'analysis_only'],
  ['space_governance', 'space_governance'],
  ['recycle_maintain', 'recycle_maintain'],
  ['restore', 'restore'],
  ['doctor', 'doctor'],
  ['check_update', 'check_update'],
  ['upgrade', 'upgrade'],
]);

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

function normalizeOutput(output) {
  if (typeof output !== 'string') {
    return null;
  }
  const normalized = output.trim().toLowerCase();
  if (!ALLOWED_OUTPUTS.has(normalized)) {
    return null;
  }
  return normalized;
}

function parseCsvList(rawValue) {
  return String(rawValue || '')
    .split(/[,\n;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveInteger(flag, rawValue) {
  const num = Number.parseInt(String(rawValue || ''), 10);
  if (!Number.isFinite(num) || num < 1) {
    throw new CliArgError(`参数 ${flag} 的值必须是 >= 1 的整数: ${rawValue}`);
  }
  return num;
}

function parseEnumValue(flag, rawValue, allowedSet) {
  const normalized = String(rawValue || '')
    .trim()
    .toLowerCase();
  if (!allowedSet.has(normalized)) {
    throw new CliArgError(`参数 ${flag} 的值无效: ${rawValue}`);
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
    selfUpdate: normalizeSelfUpdateConfig({
      enabled: true,
      channel: 'stable',
      checkSchedule: 'tri_daily',
      autoCheckOnStartup: true,
      lastCheckAt: 0,
      lastCheckSlot: '',
      lastKnownLatest: '',
      lastKnownSource: '',
      skipVersion: '',
    }),
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
    help: false,
    version: false,
    rootDir: null,
    externalStorageRoots: null,
    externalStorageAutoDetect: null,
    stateRoot: null,
    dryRunDefault: null,
    mode: null,
    theme: null,
    output: null,
    dryRun: null,
    yes: false,
    saveConfig: false,
    jsonOutput: false,
    force: false,
    interactive: false,
    action: null,
    actionFromMode: false,
    actionFlagCount: 0,
    restoreBatchId: null,
    accounts: null,
    months: null,
    cutoffMonth: null,
    categories: null,
    includeNonMonthDirs: null,
    externalRoots: null,
    externalRootsSource: null,
    targets: null,
    tiers: null,
    suggestedOnly: null,
    allowRecentActive: null,
    conflict: null,
    retentionEnabled: null,
    retentionMaxAgeDays: null,
    retentionMinKeepBatches: null,
    retentionSizeThresholdGB: null,
    upgradeMethod: null,
    upgradeVersion: null,
    upgradeChannel: null,
    upgradeYes: false,
    runTask: null,
    scanDebug: 'off',
  };
  const actionValues = [];

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
    if (token === '-h' || token === '--help') {
      parsed.help = true;
      continue;
    }
    if (token === '-v' || token === '--version') {
      parsed.version = true;
      continue;
    }
    if (ACTION_FLAG_MAP.has(token)) {
      parsed.action = ACTION_FLAG_MAP.get(token);
      parsed.actionFlagCount += 1;
      actionValues.push(parsed.action);
      continue;
    }
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
    if (token === '--restore-batch') {
      parsed.restoreBatchId = takeValue(token, i);
      parsed.action = 'restore';
      parsed.actionFlagCount += 1;
      actionValues.push('restore');
      i += 1;
      continue;
    }
    if (token === '--check-update') {
      parsed.action = 'check_update';
      parsed.actionFlagCount += 1;
      actionValues.push('check_update');
      continue;
    }
    if (token === '--upgrade') {
      parsed.upgradeMethod = parseEnumValue(token, takeValue(token, i), ALLOWED_UPGRADE_METHODS);
      parsed.action = 'upgrade';
      parsed.actionFlagCount += 1;
      actionValues.push('upgrade');
      i += 1;
      continue;
    }
    if (token === '--upgrade-version') {
      parsed.upgradeVersion = takeValue(token, i);
      i += 1;
      continue;
    }
    if (token === '--upgrade-channel') {
      parsed.upgradeChannel = parseEnumValue(token, takeValue(token, i), ALLOWED_UPGRADE_CHANNELS);
      i += 1;
      continue;
    }
    if (token === '--upgrade-yes') {
      parsed.upgradeYes = true;
      continue;
    }
    if (token === '--run-task') {
      parsed.runTask = parseEnumValue(token, takeValue(token, i), ALLOWED_RUN_TASK_MODES);
      i += 1;
      continue;
    }
    if (token === '--scan-debug') {
      parsed.scanDebug = parseEnumValue(token, takeValue(token, i), ALLOWED_SCAN_DEBUG_LEVELS);
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
    if (token === '--output') {
      const output = normalizeOutput(takeValue(token, i));
      if (!output) {
        throw new CliArgError(`参数 --output 的值无效: ${argv[i + 1]}`);
      }
      parsed.output = output;
      i += 1;
      continue;
    }
    if (token === '--dry-run') {
      parsed.dryRun = parseBooleanFlag(token, takeValue(token, i));
      i += 1;
      continue;
    }
    if (token === '--yes') {
      parsed.yes = true;
      continue;
    }
    if (token === '--save-config') {
      parsed.saveConfig = true;
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
    if (token === '--interactive') {
      parsed.interactive = true;
      continue;
    }
    if (token === '--accounts') {
      parsed.accounts = parseCsvList(takeValue(token, i));
      i += 1;
      continue;
    }
    if (token === '--months') {
      parsed.months = parseCsvList(takeValue(token, i));
      i += 1;
      continue;
    }
    if (token === '--cutoff-month') {
      parsed.cutoffMonth = takeValue(token, i);
      i += 1;
      continue;
    }
    if (token === '--categories') {
      parsed.categories = parseCsvList(takeValue(token, i));
      i += 1;
      continue;
    }
    if (token === '--include-non-month-dirs') {
      parsed.includeNonMonthDirs = parseBooleanFlag(token, takeValue(token, i));
      i += 1;
      continue;
    }
    if (token === '--external-roots') {
      parsed.externalRoots = parseCsvList(takeValue(token, i));
      i += 1;
      continue;
    }
    if (token === '--external-roots-source') {
      const sourceValues = parseCsvList(takeValue(token, i)).map((item) => item.toLowerCase());
      if (sourceValues.length === 0) {
        throw new CliArgError('参数 --external-roots-source 至少需要一个值');
      }
      for (const source of sourceValues) {
        if (!ALLOWED_EXTERNAL_ROOT_SOURCES.has(source)) {
          throw new CliArgError(`参数 --external-roots-source 的值无效: ${source}`);
        }
      }
      parsed.externalRootsSource = sourceValues;
      i += 1;
      continue;
    }
    if (token === '--targets') {
      parsed.targets = parseCsvList(takeValue(token, i));
      i += 1;
      continue;
    }
    if (token === '--tiers') {
      const values = parseCsvList(takeValue(token, i)).map((item) => item.toLowerCase());
      if (values.length === 0) {
        throw new CliArgError('参数 --tiers 至少需要一个值');
      }
      for (const tier of values) {
        if (!ALLOWED_GOVERNANCE_TIERS.has(tier)) {
          throw new CliArgError(`参数 --tiers 的值无效: ${tier}`);
        }
      }
      parsed.tiers = values;
      i += 1;
      continue;
    }
    if (token === '--suggested-only') {
      parsed.suggestedOnly = parseBooleanFlag(token, takeValue(token, i));
      i += 1;
      continue;
    }
    if (token === '--allow-recent-active') {
      parsed.allowRecentActive = parseBooleanFlag(token, takeValue(token, i));
      i += 1;
      continue;
    }
    if (token === '--conflict') {
      parsed.conflict = parseEnumValue(token, takeValue(token, i), ALLOWED_CONFLICT_STRATEGIES);
      i += 1;
      continue;
    }
    if (token === '--retention-enabled') {
      parsed.retentionEnabled = parseBooleanFlag(token, takeValue(token, i));
      i += 1;
      continue;
    }
    if (token === '--retention-max-age-days') {
      parsed.retentionMaxAgeDays = parsePositiveInteger(token, takeValue(token, i));
      i += 1;
      continue;
    }
    if (token === '--retention-min-keep-batches') {
      parsed.retentionMinKeepBatches = parsePositiveInteger(token, takeValue(token, i));
      i += 1;
      continue;
    }
    if (token === '--retention-size-threshold-gb') {
      parsed.retentionSizeThresholdGB = parsePositiveInteger(token, takeValue(token, i));
      i += 1;
      continue;
    }
    if (token.startsWith('-')) {
      throw new CliArgError(`不支持的参数: ${token}`);
    }
  }

  if (parsed.months && parsed.cutoffMonth) {
    throw new CliArgError('参数 --months 与 --cutoff-month 不能同时使用');
  }

  if (parsed.actionFlagCount > 1 || new Set(actionValues).size > 1) {
    throw new CliArgError('动作参数冲突：一次只能指定一个动作（如 --cleanup-monthly）');
  }

  if (parsed.mode && parsed.action) {
    throw new CliArgError('参数 --mode 不能与动作参数同时使用');
  }

  if (parsed.mode && !parsed.action) {
    const mapped = MODE_TO_ACTION_MAP.get(String(parsed.mode || '').trim());
    if (mapped) {
      parsed.action = mapped;
      parsed.actionFromMode = true;
    }
  }

  if (parsed.jsonOutput) {
    if (parsed.output && parsed.output !== 'json') {
      throw new CliArgError('参数 --json 与 --output text 不能同时使用');
    }
    parsed.output = 'json';
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

export async function loadConfig(cliArgs = {}, options = {}) {
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
  merged.selfUpdate = normalizeSelfUpdateConfig(fileConfig.selfUpdate, base.selfUpdate);

  merged.recycleRoot = expandHome(fileConfig.recycleRoot || path.join(stateRoot, 'recycle-bin'));
  merged.indexPath = expandHome(fileConfig.indexPath || path.join(stateRoot, 'index.jsonl'));
  merged.aliasPath = expandHome(fileConfig.aliasPath || path.join(stateRoot, 'account-aliases.json'));
  merged.configPath = configPath;

  if (!options.readOnly) {
    await ensureDir(merged.stateRoot);
    await ensureDir(merged.recycleRoot);
  }

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
    selfUpdate: normalizeSelfUpdateConfig(config.selfUpdate, defaultConfig().selfUpdate),
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
