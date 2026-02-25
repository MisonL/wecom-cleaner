#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkbox, confirm, input, select } from '@inquirer/prompts';
import {
  CACHE_CATEGORIES,
  DEFAULT_PROFILE_ROOT,
  MODES,
  SPACE_GOVERNANCE_TARGETS,
  SPACE_GOVERNANCE_TIERS,
  SPACE_GOVERNANCE_TIER_LABELS,
  PACKAGE_NAME,
  APP_NAME,
  APP_ASCII_LOGO,
} from './constants.js';
import { CliArgError, loadAliases, loadConfig, parseCliArgs, saveAliases, saveConfig } from './config.js';
import { detectNativeCore } from './native-bridge.js';
import {
  discoverAccounts,
  collectAvailableMonths,
  collectCleanupTargets,
  analyzeCacheFootprint,
  scanSpaceGovernanceTargets,
  detectExternalStorageRoots,
} from './scanner.js';
import { executeCleanup } from './cleanup.js';
import { listRestorableBatches, restoreBatch } from './restore.js';
import { printAnalysisSummary } from './analysis.js';
import {
  compareMonthKey,
  expandHome,
  formatBytes,
  formatLocalDate,
  inferDataRootFromProfilesRoot,
  monthByDaysBefore,
  normalizeMonthKey,
  padToWidth,
  printProgress,
  printSection,
  renderTable,
  sleep,
  trimToWidth,
} from './utils.js';

class PromptAbortError extends Error {
  constructor() {
    super('Prompt aborted by user');
    this.name = 'PromptAbortError';
  }
}

function isPromptAbort(error) {
  if (!error) {
    return false;
  }
  const text = `${error.name || ''} ${error.message || ''}`;
  return text.includes('ExitPromptError') || text.includes('SIGINT') || text.includes('canceled') || text.includes('force closed');
}

async function askSelect(config) {
  try {
    return await select(config);
  } catch (error) {
    if (isPromptAbort(error)) {
      throw new PromptAbortError();
    }
    throw error;
  }
}

async function askCheckbox(config) {
  try {
    return await checkbox(config);
  } catch (error) {
    if (isPromptAbort(error)) {
      throw new PromptAbortError();
    }
    throw error;
  }
}

async function askInput(config) {
  try {
    return await input(config);
  } catch (error) {
    if (isPromptAbort(error)) {
      throw new PromptAbortError();
    }
    throw error;
  }
}

async function askConfirm(config) {
  try {
    return await confirm(config);
  } catch (error) {
    if (isPromptAbort(error)) {
      throw new PromptAbortError();
    }
    throw error;
  }
}

function categoryChoices(defaultKeys = [], options = {}) {
  const includeAllByDefault = Boolean(options.includeAllByDefault);
  const defaultSet = new Set(defaultKeys);
  return CACHE_CATEGORIES.map((cat) => ({
    name: `${cat.label} (${cat.key}) - ${cat.desc}`,
    value: cat.key,
    checked: defaultSet.size === 0 ? (includeAllByDefault ? true : cat.defaultSelected !== false) : defaultSet.has(cat.key),
  }));
}

function formatEngineStatus({ nativeCorePath, lastRunEngineUsed }) {
  if (!nativeCorePath) {
    return 'Zig加速:未开启(当前使用Node)';
  }
  if (lastRunEngineUsed === 'zig') {
    return 'Zig加速:已生效(本次扫描更快)';
  }
  if (lastRunEngineUsed === 'node') {
    return 'Zig加速:本次未生效(已自动改用Node)';
  }
  return 'Zig加速:已就绪(开始扫描后自动使用)';
}

const ANSI_RESET = '\x1b[0m';
const LOGO_LEFT_PADDING = '  ';
const THEME_AUTO = 'auto';
const THEME_LIGHT = 'light';
const THEME_DARK = 'dark';
const THEME_SET = new Set([THEME_AUTO, THEME_LIGHT, THEME_DARK]);
const LOGO_THEME_PALETTES = {
  light: {
    wecomStops: [
      { at: 0, color: [0, 170, 220] },
      { at: 0.55, color: [0, 130, 220] },
      { at: 1, color: [55, 85, 215] },
    ],
    cleanerStops: [
      { at: 0, color: [0, 190, 215] },
      { at: 0.6, color: [0, 185, 95] },
      { at: 1, color: [210, 175, 0] },
    ],
    subtitleColor: [20, 90, 185],
    versionColor: [0, 120, 165],
  },
  dark: {
    wecomStops: [
      { at: 0, color: [70, 205, 255] },
      { at: 0.55, color: [55, 165, 255] },
      { at: 1, color: [70, 110, 255] },
    ],
    cleanerStops: [
      { at: 0, color: [90, 225, 255] },
      { at: 0.6, color: [90, 220, 140] },
      { at: 1, color: [250, 220, 90] },
    ],
    subtitleColor: [120, 180, 255],
    versionColor: [95, 220, 240],
  },
};

function canUseAnsiColor() {
  return Boolean(process.stdout?.isTTY) && !process.env.NO_COLOR && process.env.NODE_DISABLE_COLORS !== '1';
}

function ansiColor(color) {
  return `\x1b[38;2;${color[0]};${color[1]};${color[2]}m`;
}

function normalizeThemeMode(themeMode) {
  if (typeof themeMode !== 'string') {
    return THEME_AUTO;
  }
  const normalized = themeMode.trim().toLowerCase();
  if (!THEME_SET.has(normalized)) {
    return THEME_AUTO;
  }
  return normalized;
}

function detectThemeByColorFgBg() {
  const raw = process.env.COLORFGBG || '';
  if (!raw) {
    return null;
  }
  const parts = raw
    .split(/[:;]/)
    .map((x) => Number.parseInt(x, 10))
    .filter((x) => Number.isFinite(x));
  if (parts.length === 0) {
    return null;
  }
  const bg = parts[parts.length - 1];
  if (bg <= 6 || bg === 8) {
    return THEME_DARK;
  }
  return THEME_LIGHT;
}

function detectThemeByEnvHint() {
  const envHints = [
    process.env.TERM_THEME,
    process.env.COLORSCHEME,
    process.env.THEME,
    process.env.ITERM_PROFILE,
  ]
    .filter(Boolean)
    .map((x) => String(x).toLowerCase());

  for (const hint of envHints) {
    if (hint.includes('dark')) {
      return THEME_DARK;
    }
    if (hint.includes('light')) {
      return THEME_LIGHT;
    }
  }
  return null;
}

function resolveThemeMode(themeMode) {
  const normalized = normalizeThemeMode(themeMode);
  if (normalized === THEME_LIGHT || normalized === THEME_DARK) {
    return normalized;
  }
  return detectThemeByColorFgBg() || detectThemeByEnvHint() || THEME_DARK;
}

function themeLabel(themeMode) {
  const normalized = normalizeThemeMode(themeMode);
  if (normalized === THEME_LIGHT) {
    return '亮色';
  }
  if (normalized === THEME_DARK) {
    return '暗色';
  }
  return '自动';
}

function formatThemeStatus(themeMode, resolvedThemeMode) {
  const normalized = normalizeThemeMode(themeMode);
  if (normalized === THEME_AUTO) {
    return `主题:自动(${themeLabel(resolvedThemeMode)})`;
  }
  return `主题:${themeLabel(normalized)}`;
}

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function blendColor(start, end, t) {
  return [lerp(start[0], end[0], t), lerp(start[1], end[1], t), lerp(start[2], end[2], t)];
}

function pickGradientColor(stops, t) {
  if (t <= stops[0].at) {
    return stops[0].color;
  }
  if (t >= stops[stops.length - 1].at) {
    return stops[stops.length - 1].color;
  }
  for (let i = 0; i < stops.length - 1; i += 1) {
    const curr = stops[i];
    const next = stops[i + 1];
    if (t >= curr.at && t <= next.at) {
      const denom = next.at - curr.at || 1;
      const local = (t - curr.at) / denom;
      return blendColor(curr.color, next.color, local);
    }
  }
  return stops[stops.length - 1].color;
}

function colorizeGradient(line, stops) {
  if (!canUseAnsiColor()) {
    return line;
  }
  const chars = [...line];
  const denom = Math.max(chars.length - 1, 1);
  let output = '';
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (ch === ' ') {
      output += ' ';
      continue;
    }
    const color = pickGradientColor(stops, i / denom);
    output += `${ansiColor(color)}${ch}`;
  }
  return `${output}${ANSI_RESET}`;
}

function colorizeText(text, color) {
  if (!canUseAnsiColor()) {
    return text;
  }
  return `${ansiColor(color)}${text}${ANSI_RESET}`;
}

function renderAsciiLogoLines(appMeta, resolvedThemeMode) {
  const palette = LOGO_THEME_PALETTES[resolvedThemeMode] || LOGO_THEME_PALETTES.dark;

  const logoLines = [];
  for (const line of APP_ASCII_LOGO.wecom) {
    logoLines.push(`${LOGO_LEFT_PADDING}${colorizeGradient(line, palette.wecomStops)}`);
  }
  logoLines.push('');
  for (const line of APP_ASCII_LOGO.cleaner) {
    logoLines.push(`${LOGO_LEFT_PADDING}${colorizeGradient(line, palette.cleanerStops)}`);
  }
  logoLines.push('');
  logoLines.push(`${LOGO_LEFT_PADDING}${colorizeText(APP_ASCII_LOGO.subtitle, palette.subtitleColor)}`);
  logoLines.push(`${LOGO_LEFT_PADDING}${colorizeText(`v${appMeta.version}`, palette.versionColor)}`);
  logoLines.push('');
  return logoLines;
}

function normalizeRepositoryUrl(rawValue) {
  if (typeof rawValue !== 'string' || rawValue.trim() === '') {
    return '';
  }
  let url = rawValue.trim();
  if (url.startsWith('git+')) {
    url = url.slice(4);
  }
  if (url.startsWith('git@github.com:')) {
    url = `https://github.com/${url.slice('git@github.com:'.length)}`;
  }
  if (url.endsWith('.git')) {
    url = url.slice(0, -4);
  }
  return url;
}

async function loadAppMeta(projectRoot) {
  const fallback = {
    version: process.env.npm_package_version || '0.0.0',
    author: 'MisonL',
    repository: 'https://github.com/MisonL/wecom-cleaner',
    license: 'MIT',
  };

  try {
    const packagePath = path.join(projectRoot, 'package.json');
    const text = await fs.readFile(packagePath, 'utf-8');
    const pkg = JSON.parse(text);
    const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
    const repositoryRaw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;

    return {
      version: String(pkg.version || fallback.version),
      author: String(author || fallback.author),
      repository: normalizeRepositoryUrl(repositoryRaw) || fallback.repository,
      license: String(pkg.license || fallback.license),
    };
  } catch {
    return fallback;
  }
}

async function isDirectoryPath(targetPath) {
  const stat = await fs.stat(targetPath).catch(() => null);
  return Boolean(stat?.isDirectory());
}

async function collectProfileRootCandidates(configRootDir) {
  const candidates = new Set([configRootDir, DEFAULT_PROFILE_ROOT]);
  const containersRoot = path.join(os.homedir(), 'Library', 'Containers');
  const entries = await fs.readdir(containersRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!entry.name.toLowerCase().includes('wework')) {
      continue;
    }
    candidates.add(path.join(containersRoot, entry.name, 'Data', 'Documents', 'Profiles'));
  }

  const rows = [];
  for (const item of candidates) {
    const rootDir = path.resolve(String(item || ''));
    if (!(await isDirectoryPath(rootDir))) {
      continue;
    }
    const accountCount = (await discoverAccounts(rootDir, {})).length;
    if (accountCount <= 0) {
      continue;
    }
    rows.push({
      rootDir,
      accountCount,
    });
  }

  const dedup = new Map();
  for (const row of rows) {
    dedup.set(row.rootDir, row);
  }
  return [...dedup.values()].sort((a, b) => b.accountCount - a.accountCount || a.rootDir.localeCompare(b.rootDir));
}

async function evaluateProfileRootHealth(configRootDir, accounts) {
  const rootExists = await isDirectoryPath(configRootDir);
  if (rootExists && accounts.length > 0) {
    return {
      status: 'ok',
      candidates: [],
    };
  }

  const currentRoot = path.resolve(configRootDir);
  const allCandidates = await collectProfileRootCandidates(configRootDir);
  const candidates = allCandidates.filter((item) => item.rootDir !== currentRoot);
  return {
    status: rootExists ? 'empty' : 'missing',
    candidates,
  };
}

function printHeader({
  config,
  accountCount,
  nativeCorePath,
  lastRunEngineUsed,
  appMeta,
  nativeRepairNote,
  externalStorageRoots = [],
  externalStorageMeta = null,
  profileRootHealth = null,
}) {
  console.clear();
  const nativeText = formatEngineStatus({ nativeCorePath, lastRunEngineUsed });
  const resolvedThemeMode = resolveThemeMode(config.theme);
  console.log(renderAsciiLogoLines(appMeta, resolvedThemeMode).join('\n'));
  console.log(`${APP_NAME} v${appMeta.version} (${PACKAGE_NAME})`);
  console.log(`作者: ${appMeta.author} | 许可证: ${appMeta.license}`);
  console.log(`仓库: ${appMeta.repository}`);
  console.log(`根目录: ${config.rootDir}`);
  console.log(`状态目录: ${config.stateRoot}`);
  console.log(`账号数: ${accountCount} | ${nativeText} | ${formatThemeStatus(config.theme, resolvedThemeMode)}`);
  const sourceCounts = externalStorageMeta?.sourceCounts || null;
  if (externalStorageRoots.length > 0) {
    if (sourceCounts) {
      console.log(
        `文件存储目录: 共${externalStorageRoots.length}个（默认${sourceCounts.builtin || 0} / 手动${sourceCounts.configured || 0} / 自动${sourceCounts.auto || 0}）`
      );
    } else {
      console.log(`文件存储目录: 已检测 ${externalStorageRoots.length} 个（含默认/自定义，示例: ${externalStorageRoots[0]}）`);
    }
  } else {
    console.log('文件存储目录: 未检测到（可在设置里手动添加）');
  }
  if ((sourceCounts?.auto || 0) > 0) {
    console.log('探测提示: 自动探测目录默认不预选，纳入处理前请确认。');
  }
  if ((sourceCounts?.auto || 0) > 0 && (sourceCounts?.builtin || 0) + (sourceCounts?.configured || 0) === 0) {
    console.log('操作建议: 建议在“交互配置 -> 手动追加文件存储根目录”先确认常用路径。');
  }
  if (externalStorageMeta && Array.isArray(externalStorageMeta.truncatedRoots) && externalStorageMeta.truncatedRoots.length > 0) {
    console.log(`探测提示: ${externalStorageMeta.truncatedRoots.length} 个搜索根达到扫描预算上限，建议手动补充路径`);
  }
  if (profileRootHealth?.status === 'missing') {
    console.log('目录提示: 当前 Profile 根目录不存在，请在“交互配置”中修正。');
  } else if (profileRootHealth?.status === 'empty') {
    console.log('目录提示: 当前 Profile 根目录未识别到账号目录。');
  }
  if (profileRootHealth && Array.isArray(profileRootHealth.candidates) && profileRootHealth.candidates.length > 0) {
    const candidateText = profileRootHealth.candidates
      .slice(0, 3)
      .map((item) => `${item.rootDir} (${item.accountCount}账号)`)
      .join(' ; ');
    console.log(`候选目录: ${candidateText}`);
    console.log('操作建议: 进入“交互配置 -> Profile 根目录”修改。');
  }
  if (nativeRepairNote) {
    console.log(`修复状态: ${nativeRepairNote}`);
  }
}

function accountTableRows(accounts) {
  return accounts.map((account, idx) => [
    String(idx + 1),
    account.userName,
    account.corpName,
    account.shortId,
    account.isCurrent ? '当前登录' : '-',
  ]);
}

function formatAccountChoiceLabel(account) {
  const terminalWidth = Number(process.stdout.columns || 120);
  const widths = {
    user: Math.max(10, Math.floor(terminalWidth * 0.26)),
    corp: Math.max(14, Math.floor(terminalWidth * 0.32)),
    shortId: 8,
  };
  return `${padToWidth(account.userName, widths.user)} | ${padToWidth(account.corpName, widths.corp)} | ${padToWidth(account.shortId, widths.shortId)}`;
}

function externalStorageSourceLabel(source) {
  if (source === 'builtin') {
    return '默认';
  }
  if (source === 'configured') {
    return '手动';
  }
  return '自动';
}

function normalizeExternalStorageDetection(detectedExternalStorage) {
  if (Array.isArray(detectedExternalStorage)) {
    return {
      roots: detectedExternalStorage,
      meta: {
        rootSources: {},
        sourceCounts: {
          builtin: 0,
          configured: 0,
          auto: detectedExternalStorage.length,
        },
      },
    };
  }
  if (!detectedExternalStorage || typeof detectedExternalStorage !== 'object') {
    return {
      roots: [],
      meta: {
        rootSources: {},
        sourceCounts: {
          builtin: 0,
          configured: 0,
          auto: 0,
        },
      },
    };
  }
  return {
    roots: Array.isArray(detectedExternalStorage.roots) ? detectedExternalStorage.roots : [],
    meta: detectedExternalStorage.meta || {
      rootSources: {},
      sourceCounts: {
        builtin: 0,
        configured: 0,
        auto: 0,
      },
    },
  };
}

function formatExternalStorageChoiceLabel(rootPath, source = 'auto') {
  const terminalWidth = Number(process.stdout.columns || 120);
  const pathWidth = Math.max(24, Math.floor(terminalWidth * 0.66));
  const name = path.basename(rootPath) || 'WXWork_Data';
  return `[${externalStorageSourceLabel(source)}] ${padToWidth(name, 14)} | ${padToWidth(rootPath, pathWidth)}`;
}

async function chooseExternalStorageRoots(detectedExternalStorage, modeText) {
  const normalized = normalizeExternalStorageDetection(detectedExternalStorage);
  const externalStorageRoots = normalized.roots;
  const rootSources = normalized.meta?.rootSources || {};

  if (!Array.isArray(externalStorageRoots) || externalStorageRoots.length === 0) {
    return [];
  }

  printSection(`文件存储目录（默认/自定义，${modeText}）`);
  const selected = await askCheckbox({
    message: '检测到文件存储目录，选择要纳入本次扫描的目录',
    required: false,
    choices: externalStorageRoots.map((rootPath) => ({
      name: formatExternalStorageChoiceLabel(rootPath, rootSources[rootPath]),
      value: rootPath,
      checked: rootSources[rootPath] !== 'auto',
    })),
  });

  const autoSelected = selected.filter((item) => rootSources[item] === 'auto');
  if (autoSelected.length === 0) {
    return selected;
  }

  const allowAuto = await askConfirm({
    message: `你勾选了自动探测目录 ${autoSelected.length} 项，可能包含非企业微信目录。确认纳入本次扫描吗？`,
    default: false,
  });
  if (allowAuto) {
    return selected;
  }

  console.log('已取消自动探测目录，仅保留默认/手动路径。');
  return selected.filter((item) => rootSources[item] !== 'auto');
}

async function chooseAccounts(accounts, modeText) {
  if (accounts.length === 0) {
    console.log('\n未发现可用账号目录。');
    return [];
  }

  printSection(`账号选择（${modeText}）`);
  console.log(renderTable(['序号', '用户名', '企业名', '短ID', '状态'], accountTableRows(accounts)));

  const defaults = accounts.filter((x) => x.isCurrent).map((x) => x.id);
  const defaultValues = defaults.length > 0 ? defaults : accounts.map((x) => x.id);

  const selected = await askCheckbox({
    message: '请选择要处理的账号（空格勾选，Enter确认）',
    required: true,
    choices: accounts.map((account) => ({
      name: formatAccountChoiceLabel(account),
      value: account.id,
      checked: defaultValues.includes(account.id),
    })),
    validate: (values) => (values.length > 0 ? true : '至少选择一个账号'),
  });

  return selected;
}

async function configureMonths(availableMonths) {
  if (availableMonths.length === 0) {
    return [];
  }

  printSection('年月筛选（进入清理模式后必须设置）');
  console.log(`检测到 ${availableMonths.length} 个可选年月。`);

  const mode = await askSelect({
    message: '请选择筛选方式',
    default: 'cutoff',
    choices: [
      { name: '按截止年月自动筛选（推荐）', value: 'cutoff' },
      { name: '手动勾选年月', value: 'manual' },
    ],
  });

  if (mode === 'cutoff') {
    const defaultCutoff = monthByDaysBefore(730);
    const cutoff = await askInput({
      message: '请输入截止年月（含此年月，例如 2024-02）',
      default: defaultCutoff,
      validate: (value) => (normalizeMonthKey(value) ? true : '格式必须是 YYYY-MM，且月份在 01-12'),
    });

    const cutoffKey = normalizeMonthKey(cutoff);
    let selected = availableMonths.filter((month) => compareMonthKey(month, cutoffKey) <= 0);

    console.log(`自动命中 ${selected.length} 个年月。`);

    const tweak = await askConfirm({
      message: '是否手动微调月份列表？',
      default: false,
    });

    if (tweak) {
      selected = await askCheckbox({
        message: '微调月份（空格勾选，Enter确认）',
        required: true,
        choices: availableMonths.map((month) => ({
          name: month,
          value: month,
          checked: selected.includes(month),
        })),
        validate: (values) => (values.length > 0 ? true : '至少选择一个年月'),
      });
    }

    return selected;
  }

  return askCheckbox({
    message: '手动选择要清理的年月',
    required: true,
    choices: availableMonths.map((month) => ({
      name: month,
      value: month,
      checked: false,
    })),
    validate: (values) => (values.length > 0 ? true : '至少选择一个年月'),
  });
}

function summarizeTargets(targets) {
  const totalBytes = targets.reduce((acc, item) => acc + Number(item.sizeBytes || 0), 0);
  const byCategory = new Map();
  const byAccount = new Map();

  for (const item of targets) {
    if (!byCategory.has(item.categoryKey)) {
      byCategory.set(item.categoryKey, { label: item.categoryLabel, sizeBytes: 0, count: 0 });
    }
    const cat = byCategory.get(item.categoryKey);
    cat.sizeBytes += item.sizeBytes;
    cat.count += 1;

    if (!byAccount.has(item.accountId)) {
      byAccount.set(item.accountId, {
        userName: item.userName,
        corpName: item.corpName,
        shortId: item.accountShortId,
        sizeBytes: 0,
        count: 0,
      });
    }
    const acc = byAccount.get(item.accountId);
    acc.sizeBytes += item.sizeBytes;
    acc.count += 1;
  }

  return {
    totalBytes,
    byCategory: [...byCategory.values()].sort((a, b) => b.sizeBytes - a.sizeBytes),
    byAccount: [...byAccount.values()].sort((a, b) => b.sizeBytes - a.sizeBytes),
  };
}

function relativeTargetPath(target) {
  const parts = [target.accountShortId, target.categoryKey, target.directoryName];
  return parts.join('/');
}

function printTargetPreview(targets) {
  const rows = targets.slice(0, 40).map((item, idx) => [
    String(idx + 1),
    formatBytes(item.sizeBytes),
    item.categoryLabel,
    item.monthKey || '非月份目录',
    item.accountShortId,
    relativeTargetPath(item),
  ]);

  console.log(renderTable(['#', '大小', '类型', '月份/目录', '账号', '路径'], rows));

  if (targets.length > 40) {
    console.log(`... 仅展示前 40 项，实际 ${targets.length} 项。`);
  }
}

function governanceTierLabel(tier) {
  return SPACE_GOVERNANCE_TIER_LABELS.get(tier) || tier;
}

function governanceTierRank(tier) {
  if (tier === SPACE_GOVERNANCE_TIERS.SAFE) {
    return 1;
  }
  if (tier === SPACE_GOVERNANCE_TIERS.CAUTION) {
    return 2;
  }
  return 3;
}

function formatIdleDaysText(idleDays) {
  if (!Number.isFinite(idleDays)) {
    return '-';
  }
  if (idleDays < 1) {
    return '<1天';
  }
  return `${Math.floor(idleDays)}天`;
}

function formatGovernancePath(target, dataRoot) {
  if (target.accountId) {
    if (target.accountPath && target.path.startsWith(target.accountPath)) {
      const rel = path.relative(target.accountPath, target.path);
      if (rel) {
        return `${target.accountShortId}/${rel}`;
      }
    }
    return `${target.accountShortId}/${target.targetKey}`;
  }
  if (dataRoot && target.path.startsWith(dataRoot)) {
    const rel = path.relative(dataRoot, target.path);
    return rel || path.basename(target.path);
  }
  return target.path;
}

function summarizeGovernanceTargets(targets) {
  const byTier = new Map();
  let totalBytes = 0;
  for (const item of targets) {
    totalBytes += Number(item.sizeBytes || 0);
    if (!byTier.has(item.tier)) {
      byTier.set(item.tier, {
        tier: item.tier,
        count: 0,
        suggestedCount: 0,
        sizeBytes: 0,
      });
    }
    const row = byTier.get(item.tier);
    row.count += 1;
    row.sizeBytes += item.sizeBytes;
    row.suggestedCount += item.suggested ? 1 : 0;
  }

  return {
    totalBytes,
    byTier: [...byTier.values()].sort((a, b) => governanceTierRank(a.tier) - governanceTierRank(b.tier)),
  };
}

function printGovernancePreview({ targets, dataRoot }) {
  const rows = targets.slice(0, 50).map((item, idx) => [
    String(idx + 1),
    governanceTierLabel(item.tier),
    item.suggested ? '建议' : '-',
    formatBytes(item.sizeBytes),
    formatIdleDaysText(item.idleDays),
    item.accountShortId || '-',
    trimToWidth(item.targetLabel, 20),
    trimToWidth(formatGovernancePath(item, dataRoot), 40),
  ]);

  console.log(renderTable(['#', '层级', '建议', '大小', '静置', '账号', '目标', '路径'], rows));
  if (targets.length > 50) {
    console.log(`... 仅展示前 50 项，实际 ${targets.length} 项。`);
  }
}

async function runCleanupMode(context) {
  const { config, aliases, nativeCorePath } = context;

  const accounts = await discoverAccounts(config.rootDir, aliases);
  const detectedExternalStorage = await detectExternalStorageRoots({
    configuredRoots: config.externalStorageRoots,
    profilesRoot: config.rootDir,
    autoDetect: config.externalStorageAutoDetect !== false,
    returnMeta: true,
  });
  const selectedAccountIds = await chooseAccounts(accounts, '年月清理');
  if (selectedAccountIds.length === 0) {
    return;
  }
  const selectedExternalStorageRoots = await chooseExternalStorageRoots(detectedExternalStorage, '年月清理');

  const allCategoryKeys = CACHE_CATEGORIES.map((x) => x.key);
  const availableMonths = await collectAvailableMonths(
    accounts,
    selectedAccountIds,
    allCategoryKeys,
    selectedExternalStorageRoots
  );

  if (availableMonths.length === 0) {
    console.log('\n未发现按年月分组的缓存目录。你仍可清理非月份目录。');
  }

  const selectedMonths = availableMonths.length > 0 ? await configureMonths(availableMonths) : [];

  const selectedCategories = await askCheckbox({
    message: '选择要清理的缓存类型',
    required: true,
    choices: categoryChoices(config.defaultCategories),
    validate: (values) => (values.length > 0 ? true : '至少选择一个类型'),
  });

  const includeNonMonthDirs = await askConfirm({
    message: '是否包含非月份目录（如数字目录、临时目录）？',
    default: false,
  });

  const dryRun = await askConfirm({
    message: '先 dry-run 预览（不执行删除）？',
    default: Boolean(config.dryRunDefault),
  });

  printSection('扫描目录并计算大小');
  const scan = await collectCleanupTargets({
    accounts,
    selectedAccountIds,
    categoryKeys: selectedCategories,
    monthFilters: selectedMonths,
    includeNonMonthDirs,
    externalStorageRoots: selectedExternalStorageRoots,
    nativeCorePath,
    onProgress: (current, total) => printProgress('计算目录大小', current, total),
  });
  const targets = scan.targets;
  context.lastRunEngineUsed = scan.engineUsed;

  if (targets.length === 0) {
    console.log('没有匹配到可清理目录。');
    return;
  }

  const summary = summarizeTargets(targets);

  printSection('清理预览');
  console.log(`匹配目录: ${targets.length}`);
  console.log(`预计释放: ${formatBytes(summary.totalBytes)}`);
  console.log(`扫描引擎: ${scan.engineUsed === 'zig' ? 'Zig核心' : 'Node引擎'}`);
  if (scan.nativeFallbackReason) {
    console.log(`引擎提示: ${scan.nativeFallbackReason}`);
  }

  if (summary.byAccount.length > 0) {
    console.log('\n按账号汇总：');
    const rows = summary.byAccount.map((row) => [
      row.userName,
      row.corpName,
      row.shortId,
      String(row.count),
      formatBytes(row.sizeBytes),
    ]);
    console.log(renderTable(['用户名', '企业名', '短ID', '目录数', '大小'], rows));
  }

  if (summary.byCategory.length > 0) {
    console.log('\n按类型汇总：');
    const rows = summary.byCategory.map((row) => [row.label, String(row.count), formatBytes(row.sizeBytes)]);
    console.log(renderTable(['类型', '目录数', '大小'], rows));
  }

  console.log('\n命中目录明细：');
  printTargetPreview(targets);

  let executeDryRun = dryRun;
  if (dryRun) {
    const continueDelete = await askConfirm({
      message: '当前为 dry-run 预览。是否继续执行真实删除（移动到程序回收区）？',
      default: false,
    });
    if (!continueDelete) {
      console.log('已结束：仅预览，无删除。');
      return;
    }
    executeDryRun = false;
  }

  const confirmText = await askInput({
    message: `将删除 ${targets.length} 项并移动到回收区，请输入 DELETE 确认`,
    validate: (value) => (value === 'DELETE' ? true : '请输入大写 DELETE'),
  });

  if (confirmText !== 'DELETE') {
    console.log('未确认，已取消。');
    return;
  }

  printSection('开始删除（移动到回收区）');
  const result = await executeCleanup({
    targets,
    recycleRoot: config.recycleRoot,
    indexPath: config.indexPath,
    dryRun: executeDryRun,
    onProgress: (current, total) => printProgress('移动目录', current, total),
  });

  printSection('删除结果');
  console.log(`批次ID   : ${result.batchId}`);
  console.log(`成功数量 : ${result.successCount}`);
  console.log(`跳过数量 : ${result.skippedCount}`);
  console.log(`失败数量 : ${result.failedCount}`);
  console.log(`释放体积 : ${formatBytes(result.reclaimedBytes)}`);

  if (result.errors.length > 0) {
    console.log('\n失败明细（最多 8 条）：');
    const rows = result.errors.slice(0, 8).map((e) => [trimToWidth(e.path, 50), trimToWidth(e.message, 40)]);
    console.log(renderTable(['路径', '错误'], rows));
  }
}

async function runAnalysisMode(context) {
  const { config, aliases, nativeCorePath } = context;
  const accounts = await discoverAccounts(config.rootDir, aliases);
  const detectedExternalStorage = await detectExternalStorageRoots({
    configuredRoots: config.externalStorageRoots,
    profilesRoot: config.rootDir,
    autoDetect: config.externalStorageAutoDetect !== false,
    returnMeta: true,
  });

  const selectedAccountIds = await chooseAccounts(accounts, '会话分析（只读）');
  if (selectedAccountIds.length === 0) {
    return;
  }
  const selectedExternalStorageRoots = await chooseExternalStorageRoots(
    detectedExternalStorage,
    '会话分析（只读）'
  );

  const selectedCategories = await askCheckbox({
    message: '选择分析范围（缓存类型）',
    required: true,
    choices: categoryChoices(config.defaultCategories, { includeAllByDefault: true }),
    validate: (values) => (values.length > 0 ? true : '至少选择一个类型'),
  });

  printSection('分析中');
  const result = await analyzeCacheFootprint({
    accounts,
    selectedAccountIds,
    categoryKeys: selectedCategories,
    externalStorageRoots: selectedExternalStorageRoots,
    nativeCorePath,
    onProgress: (current, total) => printProgress('分析目录', current, total),
  });
  context.lastRunEngineUsed = result.engineUsed;

  printSection('分析结果（只读）');
  printAnalysisSummary(result);
}

async function runSpaceGovernanceMode(context) {
  const { config, aliases, nativeCorePath } = context;
  const accounts = await discoverAccounts(config.rootDir, aliases);
  const detectedExternalStorage = await detectExternalStorageRoots({
    configuredRoots: config.externalStorageRoots,
    profilesRoot: config.rootDir,
    autoDetect: config.externalStorageAutoDetect !== false,
    returnMeta: true,
  });
  let selectedAccountIds = [];

  if (accounts.length > 0) {
    selectedAccountIds = await chooseAccounts(accounts, '全量空间治理（账号相关目录）');
  }
  const selectedExternalStorageRoots = await chooseExternalStorageRoots(
    detectedExternalStorage,
    '全量空间治理'
  );

  printSection('扫描治理目录并计算大小');
  const scan = await scanSpaceGovernanceTargets({
    accounts,
    selectedAccountIds,
    rootDir: config.rootDir,
    externalStorageRoots: selectedExternalStorageRoots,
    nativeCorePath,
    autoSuggest: config.spaceGovernance?.autoSuggest,
    onProgress: (current, total) => printProgress('扫描治理目录', current, total),
  });
  context.lastRunEngineUsed = scan.engineUsed;

  if (scan.targets.length === 0) {
    console.log('未发现可治理目录。');
    return;
  }

  const summary = summarizeGovernanceTargets(scan.targets);
  const governanceRuleCount = SPACE_GOVERNANCE_TARGETS.length + selectedExternalStorageRoots.length;
  printSection('全量空间治理预览');
  console.log(`治理规则数: ${governanceRuleCount}`);
  console.log(`匹配目录数: ${scan.targets.length}`);
  console.log(`预计涉及: ${formatBytes(summary.totalBytes)}`);
  console.log(`建议阈值: >= ${scan.suggestSizeThresholdMB}MB 且静置 >= ${scan.suggestIdleDays}天`);
  console.log(`扫描引擎: ${scan.engineUsed === 'zig' ? 'Zig核心' : 'Node引擎'}`);
  if (scan.nativeFallbackReason) {
    console.log(`引擎提示: ${scan.nativeFallbackReason}`);
  }
  if (scan.dataRoot) {
    console.log(`数据根目录: ${scan.dataRoot}`);
  } else {
    console.log('数据根目录: 未识别（仅扫描账号目录相关目标）');
  }

  const byTierRows = summary.byTier.map((row) => [
    governanceTierLabel(row.tier),
    String(row.count),
    String(row.suggestedCount),
    formatBytes(row.sizeBytes),
  ]);
  console.log('\n按层级汇总：');
  console.log(renderTable(['层级', '目录数', '建议数', '大小'], byTierRows));

  console.log('\n命中目录明细：');
  printGovernancePreview({ targets: scan.targets, dataRoot: scan.dataRoot });

  const selectableTargets = scan.targets.filter((item) => item.deletable);
  if (selectableTargets.length === 0) {
    console.log('\n当前仅发现受保护目录，已结束（只读分析）。');
    return;
  }

  const lastSelected = new Set(config.spaceGovernance?.lastSelectedTargets || []);
  const selectedIds = await askCheckbox({
    message: '选择要治理的目录（建议项会预选）',
    required: true,
    choices: selectableTargets.map((item) => ({
      name: `${item.suggested ? '[建议] ' : ''}[${governanceTierLabel(item.tier)}] ${item.targetLabel} | ${item.accountShortId} | ${formatBytes(item.sizeBytes)} | 静置${formatIdleDaysText(item.idleDays)} | ${trimToWidth(formatGovernancePath(item, scan.dataRoot), 36)}`,
      value: item.id,
      checked: lastSelected.size > 0 ? lastSelected.has(item.id) : item.suggested && item.tier === SPACE_GOVERNANCE_TIERS.SAFE,
    })),
    validate: (values) => (values.length > 0 ? true : '至少选择一个目录'),
  });

  const selectedTargets = selectableTargets.filter((item) => selectedIds.includes(item.id));
  if (selectedTargets.length === 0) {
    console.log('未选择任何目标。');
    return;
  }

  const cautionTargets = selectedTargets.filter((item) => item.tier === SPACE_GOVERNANCE_TIERS.CAUTION);
  if (cautionTargets.length > 0) {
    const continueCaution = await askConfirm({
      message: `已选择谨慎层目录 ${cautionTargets.length} 项，可能导致部分缓存重新建立。继续吗？`,
      default: false,
    });
    if (!continueCaution) {
      console.log('已取消执行。');
      return;
    }
  }

  const recentTargets = selectedTargets.filter((item) => item.recentlyActive);
  let allowRecentActive = false;
  if (recentTargets.length > 0) {
    allowRecentActive = await askConfirm({
      message: `有 ${recentTargets.length} 项在最近 ${scan.suggestIdleDays} 天内仍有写入，默认会跳过。是否允许继续处理这些活跃目录？`,
      default: false,
    });
  }

  config.spaceGovernance = config.spaceGovernance || {};
  config.spaceGovernance.lastSelectedTargets = selectedIds;
  await saveConfig(config);

  const dryRun = await askConfirm({
    message: '先 dry-run 预览（不执行删除）？',
    default: Boolean(config.dryRunDefault),
  });

  if (!dryRun) {
    const executeConfirm = await askConfirm({
      message: `即将处理 ${selectedTargets.length} 项，是否继续？`,
      default: false,
    });
    if (!executeConfirm) {
      console.log('已取消执行。');
      return;
    }

    const cooldownSeconds = Math.max(1, Number(config.spaceGovernance?.cooldownSeconds || 5));
    for (let left = cooldownSeconds; left >= 1; left -= 1) {
      process.stdout.write(`\r安全冷静期: ${left}s...`);
      await sleep(1000);
    }
    process.stdout.write('\n');

    const confirmText = await askInput({
      message: '请输入 CLEAN 确认执行治理删除',
      validate: (value) => (value === 'CLEAN' ? true : '请输入大写 CLEAN'),
    });
    if (confirmText !== 'CLEAN') {
      console.log('未确认，已取消。');
      return;
    }
  }

  printSection('开始全量空间治理');
  const result = await executeCleanup({
    targets: selectedTargets,
    recycleRoot: config.recycleRoot,
    indexPath: config.indexPath,
    dryRun,
    scope: MODES.SPACE_GOVERNANCE,
    shouldSkip: (target) => {
      if (!target.deletable) {
        return 'skipped_policy_protected';
      }
      if (target.recentlyActive && !allowRecentActive) {
        return 'skipped_recently_active';
      }
      return null;
    },
    onProgress: (current, total) => printProgress('治理目录', current, total),
  });

  printSection('治理结果');
  console.log(`批次ID   : ${result.batchId}`);
  console.log(`成功数量 : ${result.successCount}`);
  console.log(`跳过数量 : ${result.skippedCount}`);
  console.log(`失败数量 : ${result.failedCount}`);
  console.log(`释放体积 : ${formatBytes(result.reclaimedBytes)}`);

  if (result.errors.length > 0) {
    console.log('\n失败明细（最多 8 条）：');
    const rows = result.errors.slice(0, 8).map((e) => [trimToWidth(e.path, 50), trimToWidth(e.message, 40)]);
    console.log(renderTable(['路径', '错误'], rows));
  }
}

function batchTableRows(batches) {
  return batches.map((batch, idx) => [
    String(idx + 1),
    batch.batchId,
    formatLocalDate(batch.firstTime),
    String(batch.entries.length),
    formatBytes(batch.totalBytes),
  ]);
}

async function askConflictResolution(conflict) {
  console.log(`\n检测到目标路径已存在：${conflict.originalPath}`);

  const action = await askSelect({
    message: '请选择冲突处理策略',
    choices: [
      { name: '跳过该项', value: 'skip' },
      { name: '覆盖现有目标', value: 'overwrite' },
      { name: '重命名恢复目标', value: 'rename' },
    ],
  });

  const applyToAll = await askConfirm({
    message: '后续冲突是否沿用同一策略？',
    default: false,
  });

  return { action, applyToAll };
}

async function runRestoreMode(context) {
  const { config } = context;
  const governanceRoot = inferDataRootFromProfilesRoot(config.rootDir);
  const externalStorageRoots = await detectExternalStorageRoots({
    configuredRoots: config.externalStorageRoots,
    profilesRoot: config.rootDir,
    autoDetect: config.externalStorageAutoDetect !== false,
  });
  const governanceAllowRoots = governanceRoot ? [...externalStorageRoots] : [config.rootDir, ...externalStorageRoots];

  const batches = await listRestorableBatches(config.indexPath, { recycleRoot: config.recycleRoot });
  if (batches.length === 0) {
    console.log('\n暂无可恢复批次。');
    return;
  }

  printSection('可恢复批次');
  console.log(renderTable(['序号', '批次ID', '时间', '目录数', '大小'], batchTableRows(batches)));

  const batchId = await askSelect({
    message: '请选择要恢复的批次',
    choices: batches.map((batch) => ({
      name: `${batch.batchId} | ${formatLocalDate(batch.firstTime)} | ${batch.entries.length}项 | ${formatBytes(batch.totalBytes)}`,
      value: batch.batchId,
    })),
  });

  const batch = batches.find((x) => x.batchId === batchId);
  if (!batch) {
    console.log('批次不存在。');
    return;
  }

  const sure = await askConfirm({
    message: `确认恢复批次 ${batch.batchId} 吗？`,
    default: false,
  });

  if (!sure) {
    console.log('已取消恢复。');
    return;
  }

  printSection('恢复中');
  if (governanceRoot) {
    console.log(`治理恢复白名单: Data 根目录 + 文件存储目录(${externalStorageRoots.length}项)`);
  } else {
    console.log(`治理恢复白名单: 未识别Data根，已回退到 Profile 根目录 + 文件存储目录(${externalStorageRoots.length}项)`);
  }
  const result = await restoreBatch({
    batch,
    indexPath: config.indexPath,
    onProgress: (current, total) => printProgress('恢复目录', current, total),
    onConflict: askConflictResolution,
    profileRoot: config.rootDir,
    extraProfileRoots: externalStorageRoots,
    recycleRoot: config.recycleRoot,
    governanceRoot,
    extraGovernanceRoots: governanceAllowRoots,
  });

  printSection('恢复结果');
  console.log(`批次ID   : ${result.batchId}`);
  console.log(`成功数量 : ${result.successCount}`);
  console.log(`跳过数量 : ${result.skipCount}`);
  console.log(`失败数量 : ${result.failCount}`);
  console.log(`恢复体积 : ${formatBytes(result.restoredBytes)}`);

  if (result.errors.length > 0) {
    console.log('\n失败明细（最多 8 条）：');
    const rows = result.errors.slice(0, 8).map((e) => [trimToWidth(e.sourcePath, 50), trimToWidth(e.message, 40)]);
    console.log(renderTable(['路径', '错误'], rows));
  }
}

async function runAliasManager(context) {
  const { config } = context;
  const aliases = context.aliases || {};
  context.aliases = aliases;
  const accounts = await discoverAccounts(config.rootDir, aliases);

  if (accounts.length === 0) {
    console.log('\n无可配置账号。');
    return;
  }

  printSection('账号别名管理（用户名 | 企业名 | 短ID）');
  console.log(renderTable(['序号', '用户名', '企业名', '短ID', '状态'], accountTableRows(accounts)));

  const accountId = await askSelect({
    message: '选择要修改别名的账号',
    choices: accounts.map((account) => ({
      name: `${account.userName} | ${account.corpName} | ${account.shortId}`,
      value: account.id,
    })),
  });

  const account = accounts.find((x) => x.id === accountId);
  if (!account) {
    return;
  }

  const oldAlias = aliases[account.id] || {};

  const userName = await askInput({
    message: '用户名别名（留空表示清除该字段别名）',
    default: oldAlias.userName || account.userName,
  });

  const corpName = await askInput({
    message: '企业名别名（留空表示清除该字段别名）',
    default: oldAlias.corpName || account.corpName,
  });

  const cleaned = {
    userName: (userName || '').trim(),
    corpName: (corpName || '').trim(),
  };

  if (!cleaned.userName && !cleaned.corpName) {
    delete aliases[account.id];
  } else {
    aliases[account.id] = cleaned;
  }

  await saveAliases(config.aliasPath, aliases);
  console.log('已保存账号别名。');
}

async function runSettingsMode(context) {
  const { config } = context;

  while (true) {
    printSection('交互配置');
    const choice = await askSelect({
      message: '选择要调整的配置项',
      choices: [
        { name: `Profile 根目录: ${config.rootDir}`, value: 'root' },
        {
          name: `手动追加文件存储根目录: ${Array.isArray(config.externalStorageRoots) && config.externalStorageRoots.length > 0 ? config.externalStorageRoots.length : 0} 项（默认路径自动识别）`,
          value: 'externalRoots',
        },
        {
          name: `外部存储自动探测: ${config.externalStorageAutoDetect !== false ? '开' : '关'}`,
          value: 'externalAutoDetect',
        },
        { name: `回收区目录: ${config.recycleRoot}`, value: 'recycle' },
        { name: `默认 dry-run: ${config.dryRunDefault ? '开' : '关'}`, value: 'dryrun' },
        {
          name: `全量治理建议阈值: >=${config.spaceGovernance.autoSuggest.sizeThresholdMB}MB 且静置${config.spaceGovernance.autoSuggest.idleDays}天`,
          value: 'spaceSuggest',
        },
        { name: `全量治理冷静期: ${config.spaceGovernance.cooldownSeconds}s`, value: 'spaceCooldown' },
        { name: `Logo 主题: ${themeLabel(config.theme)}`, value: 'theme' },
        { name: '账号别名管理（用户名 | 企业名 | 短ID）', value: 'alias' },
        { name: '返回主菜单', value: 'back' },
      ],
    });

    if (choice === 'back') {
      return;
    }

    if (choice === 'root') {
      const value = await askInput({
        message: '输入新的 Profile 根目录',
        default: config.rootDir,
      });
      if (value.trim()) {
        config.rootDir = expandHome(value.trim());
      }
      await saveConfig(config);
      console.log('已保存根目录配置。');
      continue;
    }

    if (choice === 'recycle') {
      const value = await askInput({
        message: '输入新的回收区目录',
        default: config.recycleRoot,
      });
      if (value.trim()) {
        config.recycleRoot = expandHome(value.trim());
      }
      await saveConfig(config);
      console.log('已保存回收区配置。');
      continue;
    }

    if (choice === 'externalRoots') {
      const current = Array.isArray(config.externalStorageRoots) ? config.externalStorageRoots : [];
      const value = await askInput({
        message: '输入手动追加的文件存储根目录（多个路径可用逗号分隔，留空表示清空手动配置）',
        default: current.join(', '),
      });
      config.externalStorageRoots = String(value || '')
        .split(/[,\n;]/)
        .map((item) => expandHome(item.trim()))
        .filter((item) => item);
      await saveConfig(config);
      console.log('已保存手动文件存储根目录配置。');
      continue;
    }

    if (choice === 'externalAutoDetect') {
      const value = await askConfirm({
        message: '是否启用外部存储自动探测？（关闭后仅使用默认目录与手动配置路径）',
        default: config.externalStorageAutoDetect !== false,
      });
      config.externalStorageAutoDetect = value;
      await saveConfig(config);
      console.log(`已保存外部存储自动探测：${value ? '开启' : '关闭'}。`);
      continue;
    }

    if (choice === 'dryrun') {
      const value = await askConfirm({
        message: '默认是否启用 dry-run？',
        default: config.dryRunDefault,
      });
      config.dryRunDefault = value;
      await saveConfig(config);
      console.log('已保存 dry-run 默认值。');
      continue;
    }

    if (choice === 'spaceSuggest') {
      const sizeThresholdMB = await askInput({
        message: '输入建议体积阈值（MB，整数）',
        default: String(config.spaceGovernance.autoSuggest.sizeThresholdMB),
        validate: (value) => {
          const n = Number.parseInt(value, 10);
          return Number.isFinite(n) && n >= 1 ? true : '请输入 >= 1 的整数';
        },
      });
      const idleDays = await askInput({
        message: '输入建议静置天数（天，整数）',
        default: String(config.spaceGovernance.autoSuggest.idleDays),
        validate: (value) => {
          const n = Number.parseInt(value, 10);
          return Number.isFinite(n) && n >= 1 ? true : '请输入 >= 1 的整数';
        },
      });

      config.spaceGovernance.autoSuggest.sizeThresholdMB = Number.parseInt(sizeThresholdMB, 10);
      config.spaceGovernance.autoSuggest.idleDays = Number.parseInt(idleDays, 10);
      await saveConfig(config);
      console.log('已保存全量治理建议阈值。');
      continue;
    }

    if (choice === 'spaceCooldown') {
      const cooldownSeconds = await askInput({
        message: '输入冷静期秒数（整数）',
        default: String(config.spaceGovernance.cooldownSeconds),
        validate: (value) => {
          const n = Number.parseInt(value, 10);
          return Number.isFinite(n) && n >= 1 ? true : '请输入 >= 1 的整数';
        },
      });
      config.spaceGovernance.cooldownSeconds = Number.parseInt(cooldownSeconds, 10);
      await saveConfig(config);
      console.log('已保存全量治理冷静期。');
      continue;
    }

    if (choice === 'theme') {
      const value = await askSelect({
        message: '选择 Logo 主题',
        default: normalizeThemeMode(config.theme),
        choices: [
          { name: '自动（按终端环境判断）', value: THEME_AUTO },
          { name: '亮色（适配浅色背景）', value: THEME_LIGHT },
          { name: '暗色（适配深色背景）', value: THEME_DARK },
        ],
      });
      config.theme = normalizeThemeMode(value);
      await saveConfig(config);
      console.log(`已保存 Logo 主题：${themeLabel(config.theme)}。`);
      continue;
    }

    if (choice === 'alias') {
      await runAliasManager(context);
    }
  }
}

async function runMode(mode, context) {
  if (mode === MODES.CLEANUP_MONTHLY) {
    await runCleanupMode(context);
    return;
  }
  if (mode === MODES.ANALYSIS_ONLY) {
    await runAnalysisMode(context);
    return;
  }
  if (mode === MODES.SPACE_GOVERNANCE) {
    await runSpaceGovernanceMode(context);
    return;
  }
  if (mode === MODES.RESTORE) {
    await runRestoreMode(context);
    return;
  }
  if (mode === MODES.SETTINGS) {
    await runSettingsMode(context);
    return;
  }
  throw new Error(`不支持的运行模式: ${mode}`);
}

async function main() {
  const cliArgs = parseCliArgs(process.argv.slice(2));
  const config = await loadConfig(cliArgs);
  const aliases = await loadAliases(config.aliasPath);

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const projectRoot = path.resolve(__dirname, '..');
  const nativeProbe = await detectNativeCore(projectRoot, { stateRoot: config.stateRoot });
  const appMeta = await loadAppMeta(projectRoot);

  const context = {
    config,
    aliases,
    nativeCorePath: nativeProbe.nativeCorePath || null,
    nativeRepairNote: nativeProbe.repairNote || null,
    appMeta,
  };

  if (cliArgs.mode) {
    await runMode(cliArgs.mode, context);
    return;
  }

  while (true) {
    const accounts = await discoverAccounts(config.rootDir, context.aliases);
    const detectedExternalStorage = await detectExternalStorageRoots({
      configuredRoots: config.externalStorageRoots,
      profilesRoot: config.rootDir,
      autoDetect: config.externalStorageAutoDetect !== false,
      returnMeta: true,
    });
    const detectedExternalStorageRoots = detectedExternalStorage.roots;
    const profileRootHealth = await evaluateProfileRootHealth(config.rootDir, accounts);
    printHeader({
      config,
      accountCount: accounts.length,
      nativeCorePath: context.nativeCorePath,
      lastRunEngineUsed: context.lastRunEngineUsed || null,
      appMeta: context.appMeta,
      nativeRepairNote: context.nativeRepairNote,
      externalStorageRoots: detectedExternalStorageRoots,
      externalStorageMeta: detectedExternalStorage.meta,
      profileRootHealth,
    });

    const mode = await askSelect({
      message: '开始菜单：请选择功能',
      default: MODES.CLEANUP_MONTHLY,
      choices: [
        { name: '年月清理（默认，可执行删除）', value: MODES.CLEANUP_MONTHLY },
        { name: '会话分析（只读，不处理）', value: MODES.ANALYSIS_ONLY },
        { name: '全量空间治理（分级，安全优先）', value: MODES.SPACE_GOVERNANCE },
        { name: '恢复已删除批次', value: MODES.RESTORE },
        { name: '交互配置', value: MODES.SETTINGS },
        { name: '退出', value: 'exit' },
      ],
    });

    if (mode === 'exit') {
      break;
    }

    await runMode(mode, context);

    const back = await askConfirm({
      message: '返回主菜单？',
      default: true,
    });

    if (!back) {
      break;
    }
  }

  console.log('已退出。');
}

main().catch((error) => {
  if (error instanceof PromptAbortError) {
    console.log('\n已取消。');
    process.exit(0);
  }
  if (error instanceof CliArgError) {
    console.error(`参数错误: ${error.message}`);
    process.exit(2);
  }
  console.error('运行失败:', error instanceof Error ? error.message : error);
  process.exit(1);
});
