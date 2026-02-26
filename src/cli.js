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
import { runDoctor } from './doctor.js';
import { acquireLock, breakLock, LockHeldError } from './lock.js';
import { classifyErrorType, errorTypeToLabel } from './error-taxonomy.js';
import { collectRecycleStats, maintainRecycleBin, normalizeRecycleRetention } from './recycle-maintenance.js';
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

class ConfirmationRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfirmationRequiredError';
  }
}

class UsageError extends CliArgError {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

function isPromptAbort(error) {
  if (!error) {
    return false;
  }
  const text = `${error.name || ''} ${error.message || ''}`;
  return (
    text.includes('ExitPromptError') ||
    text.includes('SIGINT') ||
    text.includes('canceled') ||
    text.includes('force closed')
  );
}

const PROMPT_BACK = '__prompt_back__';
const NON_INTERACTIVE_ACTIONS = new Set([
  MODES.CLEANUP_MONTHLY,
  MODES.ANALYSIS_ONLY,
  MODES.SPACE_GOVERNANCE,
  MODES.RESTORE,
  MODES.RECYCLE_MAINTAIN,
  MODES.DOCTOR,
]);
const INTERACTIVE_MODE_ALIASES = new Map([
  ['start', MODES.START],
  ['cleanup_monthly', MODES.CLEANUP_MONTHLY],
  ['cleanup-monthly', MODES.CLEANUP_MONTHLY],
  ['analysis_only', MODES.ANALYSIS_ONLY],
  ['analysis-only', MODES.ANALYSIS_ONLY],
  ['space_governance', MODES.SPACE_GOVERNANCE],
  ['space-governance', MODES.SPACE_GOVERNANCE],
  ['restore', MODES.RESTORE],
  ['recycle_maintain', MODES.RECYCLE_MAINTAIN],
  ['recycle-maintain', MODES.RECYCLE_MAINTAIN],
  ['doctor', MODES.DOCTOR],
  ['settings', MODES.SETTINGS],
]);
const OUTPUT_JSON = 'json';
const OUTPUT_TEXT = 'text';

function isBackCommand(inputValue) {
  const normalized = String(inputValue || '')
    .trim()
    .toLowerCase();
  return normalized === '/b' || normalized === 'b' || normalized === 'back' || normalized === '返回';
}

function withBackChoice(choices, allowBack) {
  const inputChoices = Array.isArray(choices) ? [...choices] : [];
  if (!allowBack) {
    return inputChoices;
  }
  const already = inputChoices.some((choice) => choice?.value === PROMPT_BACK);
  if (!already) {
    inputChoices.push({
      name: '← 返回上一步',
      value: PROMPT_BACK,
    });
  }
  return inputChoices;
}

function withConfirmDefaultHint(message, defaultValue) {
  const text = String(message || '').trim();
  if (!text) {
    return text;
  }
  if (text.includes('回车默认')) {
    return text;
  }
  const hint = defaultValue ? '（y/n，回车默认: y）' : '（y/n，回车默认: n）';
  return `${text} ${hint}`;
}

function isPromptBack(value) {
  return value === PROMPT_BACK;
}

async function askSelect(config) {
  try {
    const allowBack = Boolean(config?.allowBack);
    const normalizedConfig = {
      ...config,
      choices: withBackChoice(config?.choices, allowBack),
    };
    delete normalizedConfig.allowBack;
    return await select(normalizedConfig);
  } catch (error) {
    if (isPromptAbort(error)) {
      throw new PromptAbortError();
    }
    throw error;
  }
}

async function askCheckbox(config) {
  try {
    const allowBack = Boolean(config?.allowBack);
    const originalValidate = config?.validate;
    const normalizedConfig = {
      ...config,
      choices: withBackChoice(config?.choices, allowBack),
      validate: (values) => {
        if (allowBack && Array.isArray(values) && values.includes(PROMPT_BACK)) {
          return true;
        }
        if (typeof originalValidate === 'function') {
          return originalValidate(values);
        }
        return true;
      },
    };
    delete normalizedConfig.allowBack;

    const values = await checkbox(normalizedConfig);
    if (allowBack && Array.isArray(values) && values.includes(PROMPT_BACK)) {
      return PROMPT_BACK;
    }
    return values;
  } catch (error) {
    if (isPromptAbort(error)) {
      throw new PromptAbortError();
    }
    throw error;
  }
}

async function askInput(config) {
  try {
    const allowBack = Boolean(config?.allowBack);
    const originalValidate = config?.validate;
    const normalizedConfig = {
      ...config,
      message: allowBack ? `${String(config?.message || '').trim()}（输入 /b 返回上一步）` : config?.message,
      validate: (value) => {
        if (allowBack && isBackCommand(value)) {
          return true;
        }
        if (typeof originalValidate === 'function') {
          return originalValidate(value);
        }
        return true;
      },
    };
    delete normalizedConfig.allowBack;

    const value = await input(normalizedConfig);
    if (allowBack && isBackCommand(value)) {
      return PROMPT_BACK;
    }
    return value;
  } catch (error) {
    if (isPromptAbort(error)) {
      throw new PromptAbortError();
    }
    throw error;
  }
}

async function askConfirm(config) {
  try {
    const defaultValue = config?.default === undefined ? false : Boolean(config.default);
    const normalizedConfig = {
      ...config,
      message: withConfirmDefaultHint(config?.message, defaultValue),
      default: defaultValue,
    };
    return await confirm(normalizedConfig);
  } catch (error) {
    if (isPromptAbort(error)) {
      throw new PromptAbortError();
    }
    throw error;
  }
}

async function askConfirmWithBack(config) {
  const defaultValue = config?.default === undefined ? false : Boolean(config.default);
  const selected = await askSelect({
    message: `${String(config?.message || '').trim()}（回车默认: ${defaultValue ? '是' : '否'}）`,
    default: defaultValue ? '__yes__' : '__no__',
    choices: [
      { name: `是${defaultValue ? '（默认）' : ''}`, value: '__yes__' },
      { name: `否${!defaultValue ? '（默认）' : ''}`, value: '__no__' },
    ],
    allowBack: true,
  });

  if (isPromptBack(selected)) {
    return PROMPT_BACK;
  }
  return selected === '__yes__';
}

function categoryChoices(defaultKeys = [], options = {}) {
  const includeAllByDefault = Boolean(options.includeAllByDefault);
  const defaultSet = new Set(defaultKeys);
  return CACHE_CATEGORIES.map((cat) => ({
    name: `${cat.label} (${cat.key}) - ${cat.desc}`,
    value: cat.key,
    checked:
      defaultSet.size === 0
        ? includeAllByDefault
          ? true
          : cat.defaultSelected !== false
        : defaultSet.has(cat.key),
  }));
}

function resolveEngineStatus({ nativeCorePath, lastRunEngineUsed }) {
  if (!nativeCorePath) {
    return {
      badge: 'Node模式',
      detail: '未检测到 Zig 核心，当前使用 Node 引擎',
      tone: 'muted',
      fullText: 'Zig加速:未开启(当前使用Node)',
    };
  }
  if (lastRunEngineUsed === 'zig') {
    return {
      badge: 'Zig加速',
      detail: '本次扫描已启用 Zig 核心',
      tone: 'ok',
      fullText: 'Zig加速:已生效(本次扫描更快)',
    };
  }
  if (lastRunEngineUsed === 'node') {
    return {
      badge: 'Node回退',
      detail: '检测到 Zig 核心，但本次扫描自动回退到 Node',
      tone: 'warn',
      fullText: 'Zig加速:本次未生效(已自动改用Node)',
    };
  }
  return {
    badge: 'Zig就绪',
    detail: '已检测到 Zig 核心，开始扫描后会自动启用',
    tone: 'info',
    fullText: 'Zig加速:已就绪(开始扫描后自动使用)',
  };
}

const ANSI_RESET = '\x1b[0m';
const ANSI_BOLD = '\x1b[1m';
const LOGO_LEFT_PADDING = '  ';
const INFO_LEFT_PADDING = '  ';
const AUTO_ADAPTIVE_LABEL_COLOR = [46, 132, 228];
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
const INFO_THEME_PALETTES = {
  light: {
    labelColor: [36, 72, 124],
    valueColor: [32, 44, 66],
    mutedColor: [62, 82, 116],
    dividerColor: [176, 186, 206],
    badges: {
      info: [35, 128, 220],
      ok: [0, 164, 94],
      warn: [190, 145, 0],
      muted: [122, 134, 156],
    },
  },
  dark: {
    labelColor: [148, 198, 255],
    valueColor: [232, 242, 255],
    mutedColor: [196, 216, 246],
    dividerColor: [92, 114, 152],
    badges: {
      info: [60, 150, 255],
      ok: [24, 185, 108],
      warn: [212, 168, 38],
      muted: [104, 118, 145],
    },
  },
};

function canUseAnsiColor() {
  return Boolean(process.stdout?.isTTY) && !process.env.NO_COLOR && process.env.NODE_DISABLE_COLORS !== '1';
}

function ansiColor(color) {
  return `\x1b[38;2;${color[0]};${color[1]};${color[2]}m`;
}

function ansiBgColor(color) {
  return `\x1b[48;2;${color[0]};${color[1]};${color[2]}m`;
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
    return '主题:自动';
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

function colorizeText(text, color, options = {}) {
  if (!canUseAnsiColor()) {
    return text;
  }
  const boldPrefix = options.bold ? ANSI_BOLD : '';
  return `${boldPrefix}${ansiColor(color)}${text}${ANSI_RESET}`;
}

function styleWithTerminalDefault(text, options = {}) {
  if (!canUseAnsiColor()) {
    return text;
  }
  const boldPrefix = options.bold ? ANSI_BOLD : '';
  return `${boldPrefix}${text}${ANSI_RESET}`;
}

function resolveInfoPalette(resolvedThemeMode) {
  return INFO_THEME_PALETTES[resolvedThemeMode] || INFO_THEME_PALETTES.dark;
}

function pickBadgeForegroundColor(bgColor) {
  const brightness = (bgColor[0] * 299 + bgColor[1] * 587 + bgColor[2] * 114) / 1000;
  return brightness >= 150 ? [18, 26, 40] : [245, 250, 255];
}

function renderBadge(text, tone, palette) {
  if (!canUseAnsiColor()) {
    return `[${text}]`;
  }
  const bg = palette.badges[tone] || palette.badges.info;
  const fg = pickBadgeForegroundColor(bg);
  return `${ansiBgColor(bg)}${ansiColor(fg)} ${text} ${ANSI_RESET}`;
}

function renderHeaderDivider(resolvedThemeMode, options = {}) {
  const palette = resolveInfoPalette(resolvedThemeMode);
  const width = Math.max(
    42,
    Math.min(96, Number(process.stdout.columns || 120) - INFO_LEFT_PADDING.length * 2)
  );
  if (options.adaptiveText) {
    return `${INFO_LEFT_PADDING}${styleWithTerminalDefault('─'.repeat(width))}`;
  }
  return `${INFO_LEFT_PADDING}${colorizeText('─'.repeat(width), palette.dividerColor)}`;
}

function renderHeaderInfoLines(label, value, resolvedThemeMode, options = {}) {
  const palette = resolveInfoPalette(resolvedThemeMode);
  const valueIndent = `${INFO_LEFT_PADDING}  `;
  const maxValueWidth = Math.max(28, Number(process.stdout.columns || 120) - valueIndent.length - 2);
  const clippedValue = trimToWidth(String(value || '-'), maxValueWidth);
  if (options.adaptiveText) {
    const labelText = colorizeText(`${label}：`, AUTO_ADAPTIVE_LABEL_COLOR, { bold: true });
    const valueText = styleWithTerminalDefault(clippedValue);
    return [`${INFO_LEFT_PADDING}${labelText}`, `${valueIndent}${valueText}`];
  }
  const labelText = colorizeText(`${label}：`, palette.labelColor, { bold: true });
  const isDarkTheme = resolvedThemeMode === THEME_DARK;
  const valueColor = options.muted
    ? isDarkTheme
      ? palette.valueColor
      : palette.mutedColor
    : palette.valueColor;
  return [`${INFO_LEFT_PADDING}${labelText}`, `${valueIndent}${colorizeText(clippedValue, valueColor)}`];
}

function guideLabelStyle(text) {
  if (!canUseAnsiColor()) {
    return text;
  }
  return colorizeText(text, AUTO_ADAPTIVE_LABEL_COLOR, { bold: true });
}

function printGuideBlock(title, rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const labelWidth = 6;
  const maxValueWidth = Math.max(28, Number(process.stdout.columns || 120) - INFO_LEFT_PADDING.length - 12);
  console.log(`${INFO_LEFT_PADDING}┌ ${styleWithTerminalDefault(title, { bold: true })}`);

  if (list.length === 0) {
    console.log(`${INFO_LEFT_PADDING}└`);
    return;
  }

  list.forEach((row, idx) => {
    const prefix = idx === list.length - 1 ? '└' : '│';
    if (typeof row === 'string') {
      console.log(`${INFO_LEFT_PADDING}${prefix} ${trimToWidth(row, maxValueWidth + labelWidth + 2)}`);
      return;
    }
    const label = padToWidth(String(row?.label || '-'), labelWidth);
    const value = trimToWidth(String(row?.value || '-'), maxValueWidth);
    const labelText = guideLabelStyle(label);
    console.log(`${INFO_LEFT_PADDING}${prefix} ${labelText}：${value}`);
  });
}

function summarizeErrorsByType(errors, options = {}) {
  const list = Array.isArray(errors) ? errors : [];
  const pickMessage =
    typeof options.pickMessage === 'function' ? options.pickMessage : (item) => item?.message;
  const counts = new Map();
  for (const item of list) {
    const label = errorTypeToLabel(classifyErrorType(pickMessage(item)));
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-Hans-CN'));
}

async function printErrorDiagnostics(errors, options = {}) {
  const list = Array.isArray(errors) ? errors : [];
  if (list.length === 0) {
    return;
  }

  const summaryRows = summarizeErrorsByType(list, options).map((item) => ({
    label: item.label,
    value: `${item.count} 项`,
  }));
  printGuideBlock('失败汇总', summaryRows);

  const defaultLimit = Math.max(1, Number(options.defaultLimit || 5));
  const headers =
    Array.isArray(options.headers) && options.headers.length > 0 ? options.headers : ['路径', '错误'];
  const mapRow =
    typeof options.mapRow === 'function'
      ? options.mapRow
      : (item) => [item?.path || '-', item?.message || '-'];
  const showAll = await askConfirm({
    message: `失败明细共 ${list.length} 条，是否展开查看全部？`,
    default: false,
  });
  const limit = showAll ? list.length : Math.min(defaultLimit, list.length);
  const rows = list.slice(0, limit).map((item) => mapRow(item).map((cell) => trimToWidth(cell, 50)));
  const detailTitle = showAll ? `失败明细（全部 ${limit} 条）` : `失败明细（前 ${limit} 条）`;
  console.log(`\n${detailTitle}：`);
  console.log(renderTable(headers, rows));
  if (!showAll && list.length > limit) {
    console.log(`... 已省略其余 ${list.length - limit} 条。`);
  }
}

function doctorStatusText(status) {
  if (status === 'pass') {
    return '通过';
  }
  if (status === 'warn') {
    return '警告';
  }
  return '失败';
}

async function printDoctorReport(report, asJson) {
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printSection('系统自检结果');
  printGuideBlock('总体状态', [
    { label: '结果', value: doctorStatusText(report.overall) },
    { label: '通过', value: `${report.summary.pass} 项` },
    { label: '警告', value: `${report.summary.warn} 项` },
    { label: '失败', value: `${report.summary.fail} 项` },
    { label: '平台', value: `${report.runtime.targetTag}` },
  ]);

  const rows = report.checks.map((item) => [
    item.title,
    doctorStatusText(item.status),
    trimToWidth(item.detail, 58),
  ]);
  console.log(renderTable(['检查项', '状态', '详情'], rows));

  if (Array.isArray(report.recommendations) && report.recommendations.length > 0) {
    printGuideBlock(
      '修复建议',
      report.recommendations.slice(0, 8).map((item) => ({ label: '建议', value: item }))
    );
  }
}

function recycleThresholdBytes(config) {
  const policy = normalizeRecycleRetention(config.recycleRetention);
  return Math.max(1, Number(policy.sizeThresholdGB || 20)) * 1024 * 1024 * 1024;
}

async function printRecyclePressureHint(config) {
  const policy = normalizeRecycleRetention(config.recycleRetention);
  if (!policy.enabled) {
    return;
  }

  const stats = await collectRecycleStats({
    indexPath: config.indexPath,
    recycleRoot: config.recycleRoot,
  });
  const threshold = recycleThresholdBytes(config);
  if (stats.totalBytes <= threshold) {
    return;
  }
  printGuideBlock('回收区容量提示', [
    { label: '当前', value: `${formatBytes(stats.totalBytes)}（${stats.totalBatches} 批）` },
    { label: '阈值', value: `${formatBytes(threshold)}` },
    { label: '建议', value: '建议执行“回收区治理（保留策略）”释放空间。' },
  ]);
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
  return [...dedup.values()].sort(
    (a, b) => b.accountCount - a.accountCount || a.rootDir.localeCompare(b.rootDir)
  );
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
  const normalizedThemeMode = normalizeThemeMode(config.theme);
  const resolvedThemeMode = resolveThemeMode(config.theme);
  const palette = resolveInfoPalette(resolvedThemeMode);
  const engineStatus = resolveEngineStatus({ nativeCorePath, lastRunEngineUsed });
  const adaptiveHeaderText = normalizedThemeMode === THEME_AUTO;
  const printLine = (label, value, options = {}) => {
    const lines = renderHeaderInfoLines(label, value, resolvedThemeMode, {
      adaptiveText: adaptiveHeaderText,
      ...options,
    });
    for (const line of lines) {
      console.log(line);
    }
  };

  console.log(renderAsciiLogoLines(appMeta, resolvedThemeMode).join('\n'));

  const stateBadges = [
    renderBadge(`账号 ${accountCount}`, 'info', palette),
    renderBadge(engineStatus.badge, engineStatus.tone, palette),
    renderBadge(formatThemeStatus(config.theme, resolvedThemeMode), 'muted', palette),
  ];
  console.log(`${INFO_LEFT_PADDING}${stateBadges.join(' ')}`);
  printLine('引擎说明', engineStatus.detail, { muted: true });
  console.log(renderHeaderDivider(resolvedThemeMode, { adaptiveText: adaptiveHeaderText }));

  printLine('应用', `${APP_NAME} v${appMeta.version} (${PACKAGE_NAME})`);
  printLine('作者/许可', `${appMeta.author} | ${appMeta.license}`);
  printLine('仓库', appMeta.repository);
  printLine('根目录', config.rootDir);
  printLine('状态目录', config.stateRoot);

  const sourceCounts = externalStorageMeta?.sourceCounts || null;
  if (externalStorageRoots.length > 0) {
    if (sourceCounts) {
      printLine(
        '文件存储',
        `共${externalStorageRoots.length}个（默认${sourceCounts.builtin || 0} / 手动${sourceCounts.configured || 0} / 自动${sourceCounts.auto || 0}）`
      );
    } else {
      printLine(
        '文件存储',
        `已检测 ${externalStorageRoots.length} 个（含默认/自定义，示例: ${externalStorageRoots[0]}）`
      );
    }
  } else {
    printLine('文件存储', '未检测到（可在设置里手动添加）');
  }
  if ((sourceCounts?.auto || 0) > 0) {
    printLine('探测提示', '自动探测目录默认不预选，纳入处理前请确认。', { muted: true });
  }
  if ((sourceCounts?.auto || 0) > 0 && (sourceCounts?.builtin || 0) + (sourceCounts?.configured || 0) === 0) {
    printLine('操作建议', '建议在“交互配置 -> 手动追加文件存储根目录”先确认常用路径。', { muted: true });
  }
  if (
    externalStorageMeta &&
    Array.isArray(externalStorageMeta.truncatedRoots) &&
    externalStorageMeta.truncatedRoots.length > 0
  ) {
    printLine(
      '探测提示',
      `${externalStorageMeta.truncatedRoots.length} 个搜索根达到扫描预算上限，建议手动补充路径`,
      { muted: true }
    );
  }
  if (profileRootHealth?.status === 'missing') {
    printLine('目录提示', '当前 Profile 根目录不存在，请在“交互配置”中修正。', { muted: true });
  } else if (profileRootHealth?.status === 'empty') {
    printLine('目录提示', '当前 Profile 根目录未识别到账号目录。', { muted: true });
  }
  if (
    profileRootHealth &&
    Array.isArray(profileRootHealth.candidates) &&
    profileRootHealth.candidates.length > 0
  ) {
    const candidateText = profileRootHealth.candidates
      .slice(0, 3)
      .map((item) => `${item.rootDir} (${item.accountCount}账号)`)
      .join(' ; ');
    printLine('候选目录', candidateText, { muted: true });
    printLine('操作建议', '进入“交互配置 -> Profile 根目录”修改。', { muted: true });
  }
  if (nativeRepairNote) {
    printLine('修复状态', nativeRepairNote, { muted: true });
  }
  console.log(renderHeaderDivider(resolvedThemeMode, { adaptiveText: adaptiveHeaderText }));
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

async function chooseExternalStorageRoots(detectedExternalStorage, modeText, options = {}) {
  const allowBack = Boolean(options.allowBack);
  const showGuide = options.showGuide !== false;
  const guideTitle = options.guideTitle || '文件存储目录范围';
  const guideRows = Array.isArray(options.guideRows)
    ? options.guideRows
    : [
        { label: '默认', value: '已预选默认路径与手动配置路径' },
        { label: '自动', value: '自动探测目录默认不预选，需显式确认' },
        { label: '回退', value: allowBack ? '可选“← 返回上一步”' : '当前步骤不支持回退' },
      ];
  const normalized = normalizeExternalStorageDetection(detectedExternalStorage);
  const externalStorageRoots = normalized.roots;
  const rootSources = normalized.meta?.rootSources || {};

  if (!Array.isArray(externalStorageRoots) || externalStorageRoots.length === 0) {
    return [];
  }

  printSection(`文件存储目录（默认/自定义，${modeText}）`);
  if (showGuide) {
    printGuideBlock(guideTitle, guideRows);
  }
  const selected = await askCheckbox({
    message: '检测到文件存储目录，选择要纳入本次扫描的目录',
    required: false,
    allowBack,
    choices: externalStorageRoots.map((rootPath) => ({
      name: formatExternalStorageChoiceLabel(rootPath, rootSources[rootPath]),
      value: rootPath,
      checked: rootSources[rootPath] !== 'auto',
    })),
  });
  if (isPromptBack(selected)) {
    return PROMPT_BACK;
  }

  const autoSelected = selected.filter((item) => rootSources[item] === 'auto');
  if (autoSelected.length === 0) {
    return selected;
  }

  const allowAuto = allowBack
    ? await askConfirmWithBack({
        message: `你勾选了自动探测目录 ${autoSelected.length} 项，可能包含非企业微信目录。确认纳入本次扫描吗？`,
        default: false,
      })
    : await askConfirm({
        message: `你勾选了自动探测目录 ${autoSelected.length} 项，可能包含非企业微信目录。确认纳入本次扫描吗？`,
        default: false,
      });
  if (isPromptBack(allowAuto)) {
    return PROMPT_BACK;
  }

  if (allowAuto) {
    return selected;
  }

  console.log('已取消自动探测目录，仅保留默认/手动路径。');
  return selected.filter((item) => rootSources[item] !== 'auto');
}

async function chooseAccounts(accounts, modeText, options = {}) {
  const allowBack = Boolean(options.allowBack);
  const showGuide = options.showGuide !== false;
  const guideTitle = options.guideTitle || '账号范围';
  const guideRows = Array.isArray(options.guideRows)
    ? options.guideRows
    : [
        { label: '默认', value: '优先选中“当前登录”账号；若无则全选' },
        { label: '操作', value: '空格勾选，Enter 确认' },
        { label: '目的', value: '缩小扫描范围，提高执行效率' },
      ];
  if (accounts.length === 0) {
    console.log('\n未发现可用账号目录。');
    return [];
  }

  printSection(`账号选择（${modeText}）`);
  if (showGuide) {
    printGuideBlock(guideTitle, guideRows);
  }
  console.log(renderTable(['序号', '用户名', '企业名', '短ID', '状态'], accountTableRows(accounts)));

  const defaults = accounts.filter((x) => x.isCurrent).map((x) => x.id);
  const defaultValues = defaults.length > 0 ? defaults : accounts.map((x) => x.id);

  const selected = await askCheckbox({
    message: '请选择要处理的账号（空格勾选，Enter确认）',
    required: true,
    allowBack,
    choices: accounts.map((account) => ({
      name: formatAccountChoiceLabel(account),
      value: account.id,
      checked: defaultValues.includes(account.id),
    })),
    validate: (values) => (values.length > 0 ? true : '至少选择一个账号'),
  });

  return selected;
}

async function configureMonths(availableMonths, options = {}) {
  const allowBack = Boolean(options.allowBack);
  if (availableMonths.length === 0) {
    return [];
  }

  printSection('年月筛选（进入清理模式后必须设置）');
  printGuideBlock('步骤 3/6 · 年月策略', [
    { label: '检测', value: `已发现 ${availableMonths.length} 个可选年月` },
    { label: '推荐', value: '先按截止年月自动筛选，再按需微调' },
    { label: '回退', value: allowBack ? '可选“← 返回上一步”' : '当前步骤不支持回退' },
  ]);

  const mode = await askSelect({
    message: '请选择筛选方式',
    default: 'cutoff',
    allowBack,
    choices: [
      { name: '按截止年月自动筛选（推荐）', value: 'cutoff' },
      { name: '手动勾选年月', value: 'manual' },
    ],
  });
  if (isPromptBack(mode)) {
    return PROMPT_BACK;
  }

  if (mode === 'cutoff') {
    const defaultCutoff = monthByDaysBefore(730);
    const cutoff = await askInput({
      message: '请输入截止年月（含此年月，例如 2024-02）',
      default: defaultCutoff,
      allowBack,
      validate: (value) => (normalizeMonthKey(value) ? true : '格式必须是 YYYY-MM，且月份在 01-12'),
    });
    if (isPromptBack(cutoff)) {
      return PROMPT_BACK;
    }

    const cutoffKey = normalizeMonthKey(cutoff);
    let selected = availableMonths.filter((month) => compareMonthKey(month, cutoffKey) <= 0);

    console.log(`自动命中 ${selected.length} 个年月。`);

    const tweak = allowBack
      ? await askConfirmWithBack({
          message: '是否手动微调月份列表？',
          default: false,
        })
      : await askConfirm({
          message: '是否手动微调月份列表？',
          default: false,
        });
    if (isPromptBack(tweak)) {
      return PROMPT_BACK;
    }

    if (tweak) {
      selected = await askCheckbox({
        message: '微调月份（空格勾选，Enter确认）',
        required: true,
        allowBack,
        choices: availableMonths.map((month) => ({
          name: month,
          value: month,
          checked: selected.includes(month),
        })),
        validate: (values) => (values.length > 0 ? true : '至少选择一个年月'),
      });
      if (isPromptBack(selected)) {
        return PROMPT_BACK;
      }
    }

    return selected;
  }

  const selected = await askCheckbox({
    message: '手动选择要清理的年月',
    required: true,
    allowBack,
    choices: availableMonths.map((month) => ({
      name: month,
      value: month,
      checked: false,
    })),
    validate: (values) => (values.length > 0 ? true : '至少选择一个年月'),
  });
  return selected;
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
  const rows = targets
    .slice(0, 40)
    .map((item, idx) => [
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
  const rows = targets
    .slice(0, 50)
    .map((item, idx) => [
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

function uniqueStrings(values = []) {
  return [...new Set(values.map((item) => String(item || '').trim()).filter(Boolean))];
}

function normalizeActionOutputMode(cliArgs) {
  if (cliArgs.output === OUTPUT_TEXT || cliArgs.output === OUTPUT_JSON) {
    return cliArgs.output;
  }
  return OUTPUT_JSON;
}

function actionFlagName(action) {
  if (action === MODES.CLEANUP_MONTHLY) {
    return '--cleanup-monthly';
  }
  if (action === MODES.ANALYSIS_ONLY) {
    return '--analysis-only';
  }
  if (action === MODES.SPACE_GOVERNANCE) {
    return '--space-governance';
  }
  if (action === MODES.RESTORE) {
    return '--restore-batch <batchId>';
  }
  if (action === MODES.RECYCLE_MAINTAIN) {
    return '--recycle-maintain';
  }
  if (action === MODES.DOCTOR) {
    return '--doctor';
  }
  return `--${String(action || '').replace(/_/g, '-')}`;
}

function resolveActionFromCli(cliArgs, hasAnyArgs) {
  if (!hasAnyArgs) {
    return null;
  }
  if (!cliArgs.action || !NON_INTERACTIVE_ACTIONS.has(cliArgs.action)) {
    throw new UsageError(
      [
        '无交互模式必须指定一个动作参数：',
        '--cleanup-monthly | --analysis-only | --space-governance | --restore-batch <batchId> | --recycle-maintain | --doctor',
      ].join('\n')
    );
  }
  return cliArgs.action;
}

function printCliUsage(appMeta) {
  const versionText = appMeta?.version ? ` v${appMeta.version}` : '';
  const lines = [
    `${APP_NAME}${versionText}`,
    '',
    '用法：',
    '  wecom-cleaner                             进入交互模式',
    '  wecom-cleaner <动作参数> [选项]          无交互执行（默认 JSON 输出）',
    '',
    '动作参数（必须且只能一个）：',
    '  --cleanup-monthly',
    '  --analysis-only',
    '  --space-governance',
    '  --restore-batch <batchId>',
    '  --recycle-maintain',
    '  --doctor',
    '',
    '常用选项：',
    '  --output json|text',
    '  --dry-run true|false',
    '  --yes',
    '  --accounts all|current|id1,id2',
    '  --months YYYY-MM,YYYY-MM',
    '  --cutoff-month YYYY-MM',
    '  --categories key1,key2',
    '  --root <path>',
    '  --state-root <path>',
    '',
    '辅助：',
    '  -h, --help      显示帮助',
    '  -v, --version   显示版本号',
    '',
    '示例：',
    '  wecom-cleaner --doctor',
    '  wecom-cleaner --cleanup-monthly --accounts all --cutoff-month 2024-04',
    '  wecom-cleaner --cleanup-monthly --accounts all --cutoff-month 2024-04 --dry-run false --yes',
  ];
  console.log(lines.join('\n'));
}

function resolveInteractiveStartMode(cliArgs) {
  const rawMode = String(cliArgs.mode || '')
    .trim()
    .toLowerCase();
  if (rawMode) {
    const mappedMode = INTERACTIVE_MODE_ALIASES.get(rawMode);
    if (!mappedMode) {
      throw new UsageError(`参数 --mode 的值无效: ${cliArgs.mode}`);
    }
    return mappedMode;
  }

  if (NON_INTERACTIVE_ACTIONS.has(cliArgs.action)) {
    return cliArgs.action;
  }
  return MODES.START;
}

function resolveDestructiveDryRun(cliArgs) {
  if (typeof cliArgs.dryRun === 'boolean') {
    if (cliArgs.dryRun === false && !cliArgs.yes) {
      throw new ConfirmationRequiredError('检测到真实执行请求，但未提供 --yes 确认参数。');
    }
    return cliArgs.dryRun;
  }
  return !cliArgs.yes;
}

function categoryDefaultSelection(config) {
  const configured = Array.isArray(config.defaultCategories) ? config.defaultCategories : [];
  if (configured.length > 0) {
    return uniqueStrings(configured);
  }
  return CACHE_CATEGORIES.filter((item) => item.defaultSelected !== false).map((item) => item.key);
}

function resolveCategoryKeys(rawValues, mode, config) {
  const allKeys = CACHE_CATEGORIES.map((item) => item.key);
  const keySet = new Set(allKeys);
  const values = Array.isArray(rawValues)
    ? rawValues.map((item) =>
        String(item || '')
          .trim()
          .toLowerCase()
      )
    : [];
  if (values.length === 0) {
    if (mode === MODES.ANALYSIS_ONLY) {
      return allKeys;
    }
    return categoryDefaultSelection(config);
  }

  if (values.includes('all')) {
    return allKeys;
  }

  const normalized = uniqueStrings(values);
  for (const value of normalized) {
    if (!keySet.has(value)) {
      throw new UsageError(`参数 --categories 中存在未知类型: ${value}`);
    }
  }
  return normalized;
}

function resolveMonthFilters(cliArgs, availableMonths) {
  const normalizedMonths = uniqueStrings(availableMonths);
  if (normalizedMonths.length === 0) {
    return [];
  }

  if (Array.isArray(cliArgs.months) && cliArgs.months.length > 0) {
    const selected = uniqueStrings(
      cliArgs.months.map((item) => {
        const month = normalizeMonthKey(item);
        if (!month) {
          throw new UsageError(`参数 --months 中存在非法年月: ${item}`);
        }
        return month;
      })
    );
    return selected;
  }

  if (cliArgs.cutoffMonth) {
    const cutoff = normalizeMonthKey(cliArgs.cutoffMonth);
    if (!cutoff) {
      throw new UsageError(`参数 --cutoff-month 非法: ${cliArgs.cutoffMonth}`);
    }
    return normalizedMonths.filter((month) => compareMonthKey(month, cutoff) <= 0);
  }

  const autoCutoff = monthByDaysBefore(730);
  return normalizedMonths.filter((month) => compareMonthKey(month, autoCutoff) <= 0);
}

function resolveAccountSelection(accounts, rawSelector) {
  const warnings = [];
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return { selectedAccountIds: [], warnings };
  }

  const selector = Array.isArray(rawSelector)
    ? rawSelector
        .map((item) =>
          String(item || '')
            .trim()
            .toLowerCase()
        )
        .filter(Boolean)
    : [];
  const byId = new Map(accounts.map((account) => [String(account.id), account]));
  const byShortId = new Map(accounts.map((account) => [String(account.shortId).toLowerCase(), account]));

  if (selector.length === 0) {
    const current = accounts.filter((item) => item.isCurrent).map((item) => item.id);
    if (current.length > 0) {
      return { selectedAccountIds: current, warnings };
    }
    return { selectedAccountIds: accounts.map((item) => item.id), warnings };
  }

  if (selector.includes('all')) {
    return { selectedAccountIds: accounts.map((item) => item.id), warnings };
  }

  const selected = new Set();
  if (selector.includes('current')) {
    const current = accounts.filter((item) => item.isCurrent).map((item) => item.id);
    if (current.length > 0) {
      current.forEach((id) => selected.add(id));
    } else {
      warnings.push('参数 --accounts 包含 current，但未识别当前登录账号，已回退到全账号。');
      accounts.map((item) => item.id).forEach((id) => selected.add(id));
    }
  }

  for (const token of selector) {
    if (token === 'current') {
      continue;
    }
    if (byId.has(token)) {
      selected.add(token);
      continue;
    }
    const shortMatched = byShortId.get(token);
    if (shortMatched) {
      selected.add(shortMatched.id);
      continue;
    }
    throw new UsageError(`参数 --accounts 中存在未知账号标识: ${token}`);
  }

  if (selected.size === 0) {
    throw new UsageError('参数 --accounts 解析后为空，请至少选择一个账号。');
  }
  return {
    selectedAccountIds: [...selected],
    warnings,
  };
}

function normalizeExternalRootsSource(rawSources) {
  const sources = Array.isArray(rawSources) && rawSources.length > 0 ? rawSources : ['preset'];
  const set = new Set(
    sources
      .map((item) =>
        String(item || '')
          .trim()
          .toLowerCase()
      )
      .filter(Boolean)
  );
  if (set.has('all')) {
    return new Set(['builtin', 'configured', 'auto']);
  }
  const resolved = new Set();
  if (set.has('preset')) {
    resolved.add('builtin');
    resolved.add('configured');
  }
  if (set.has('configured')) {
    resolved.add('configured');
  }
  if (set.has('auto')) {
    resolved.add('auto');
  }
  return resolved;
}

function resolveExternalStorageForAction(detected, cliArgs, options = {}) {
  const warnings = [];
  const normalized = normalizeExternalStorageDetection(detected);
  const detectedRoots = Array.isArray(normalized.roots) ? normalized.roots : [];
  const rootSources = normalized.meta?.rootSources || {};

  if (Array.isArray(cliArgs.externalRoots) && cliArgs.externalRoots.length > 0) {
    const roots = uniqueStrings(cliArgs.externalRoots.map((item) => expandHome(item)));
    return { roots, warnings };
  }

  const defaultSources = Array.isArray(options.defaultSources) ? options.defaultSources : ['preset'];
  const sourceAllowSet = normalizeExternalRootsSource(cliArgs.externalRootsSource || defaultSources);
  const selected = detectedRoots.filter((rootPath) => sourceAllowSet.has(rootSources[rootPath] || 'auto'));
  return { roots: selected, warnings };
}

function resolveConflictStrategy(rawValue) {
  const normalized = String(rawValue || 'skip')
    .trim()
    .toLowerCase();
  if (!['skip', 'overwrite', 'rename'].includes(normalized)) {
    throw new UsageError(`参数 --conflict 的值无效: ${rawValue}`);
  }
  return normalized;
}

function resolveGovernanceTierFilters(rawValue = []) {
  const values = uniqueStrings(rawValue.map((item) => String(item || '').toLowerCase()));
  if (values.length === 0) {
    return null;
  }
  const allowed = new Set([
    SPACE_GOVERNANCE_TIERS.SAFE,
    SPACE_GOVERNANCE_TIERS.CAUTION,
    SPACE_GOVERNANCE_TIERS.PROTECTED,
  ]);
  for (const value of values) {
    if (!allowed.has(value)) {
      throw new UsageError(`参数 --tiers 中存在非法层级: ${value}`);
    }
  }
  return new Set(values);
}

function responseSummaryFromCleanupResult(result, extra = {}) {
  return {
    batchId: result.batchId,
    successCount: result.successCount,
    skippedCount: result.skippedCount,
    failedCount: result.failedCount,
    reclaimedBytes: result.reclaimedBytes,
    ...extra,
  };
}

function toStructuredError(item = {}, fallbackCode = 'E_ACTION_FAILED') {
  const message = String(item.message || item.error || 'unknown_error');
  return {
    code: classifyErrorType(message) || fallbackCode,
    message,
    path: item.path || item.sourcePath || item.recyclePath || null,
  };
}

function printNonInteractiveTextResult(payload) {
  const statusText = payload.ok ? 'SUCCESS' : 'FAILED';
  console.log(`[${statusText}] ${payload.action}`);
  if (payload.summary && typeof payload.summary === 'object') {
    for (const [key, value] of Object.entries(payload.summary)) {
      console.log(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
    }
  }
  if (Array.isArray(payload.warnings) && payload.warnings.length > 0) {
    console.log('warnings:');
    payload.warnings.forEach((item) => console.log(`- ${item}`));
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    console.log('errors:');
    payload.errors.forEach((item) => console.log(`- ${item.code}: ${item.message}`));
  }
}

function emitNonInteractivePayload(payload, outputMode) {
  if (outputMode === OUTPUT_TEXT) {
    printNonInteractiveTextResult(payload);
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}

async function runCleanupModeNonInteractive(context, cliArgs, warnings = []) {
  const { config, aliases, nativeCorePath } = context;
  const accounts = await discoverAccounts(config.rootDir, aliases);
  const accountResolved = resolveAccountSelection(accounts, cliArgs.accounts);
  warnings.push(...accountResolved.warnings);

  const detectedExternalStorage = await detectExternalStorageRoots({
    configuredRoots: config.externalStorageRoots,
    profilesRoot: config.rootDir,
    autoDetect: config.externalStorageAutoDetect !== false,
    returnMeta: true,
  });
  const externalResolved = resolveExternalStorageForAction(detectedExternalStorage, cliArgs, {
    defaultSources: ['preset'],
  });
  warnings.push(...externalResolved.warnings);

  const categoryKeys = resolveCategoryKeys(cliArgs.categories, MODES.CLEANUP_MONTHLY, config);
  const availableMonths = await collectAvailableMonths(
    accounts,
    accountResolved.selectedAccountIds,
    categoryKeys,
    externalResolved.roots
  );
  const monthFilters = resolveMonthFilters(cliArgs, availableMonths);
  const includeNonMonthDirs = Boolean(cliArgs.includeNonMonthDirs);
  const dryRun = resolveDestructiveDryRun(cliArgs);

  const scan = await collectCleanupTargets({
    accounts,
    selectedAccountIds: accountResolved.selectedAccountIds,
    categoryKeys,
    monthFilters,
    includeNonMonthDirs,
    externalStorageRoots: externalResolved.roots,
    nativeCorePath,
  });
  context.lastRunEngineUsed = scan.engineUsed;
  if (scan.nativeFallbackReason) {
    warnings.push(scan.nativeFallbackReason);
  }

  const targets = scan.targets || [];
  if (targets.length === 0) {
    return {
      ok: true,
      action: MODES.CLEANUP_MONTHLY,
      dryRun,
      summary: {
        matchedTargets: 0,
        reclaimedBytes: 0,
        successCount: 0,
        skippedCount: 0,
        failedCount: 0,
      },
      warnings,
      errors: [],
      data: {
        selectedAccounts: accountResolved.selectedAccountIds,
        selectedMonths: monthFilters,
        selectedCategories: categoryKeys,
        selectedExternalRoots: externalResolved.roots,
        engineUsed: scan.engineUsed || 'node',
      },
    };
  }

  const result = await executeCleanup({
    targets,
    recycleRoot: config.recycleRoot,
    indexPath: config.indexPath,
    dryRun,
    allowedRoots: [config.rootDir, ...externalResolved.roots],
  });
  return {
    ok: result.failedCount === 0,
    action: MODES.CLEANUP_MONTHLY,
    dryRun,
    summary: responseSummaryFromCleanupResult(result, {
      matchedTargets: targets.length,
    }),
    warnings,
    errors: result.errors.map((item) => toStructuredError(item)),
    data: {
      selectedAccounts: accountResolved.selectedAccountIds,
      selectedMonths: monthFilters,
      selectedCategories: categoryKeys,
      selectedExternalRoots: externalResolved.roots,
      includeNonMonthDirs,
      engineUsed: scan.engineUsed || 'node',
    },
  };
}

async function runAnalysisModeNonInteractive(context, cliArgs, warnings = []) {
  const { config, aliases, nativeCorePath } = context;
  const accounts = await discoverAccounts(config.rootDir, aliases);
  const accountResolved = resolveAccountSelection(accounts, cliArgs.accounts);
  warnings.push(...accountResolved.warnings);

  const detectedExternalStorage = await detectExternalStorageRoots({
    configuredRoots: config.externalStorageRoots,
    profilesRoot: config.rootDir,
    autoDetect: config.externalStorageAutoDetect !== false,
    returnMeta: true,
  });
  const externalResolved = resolveExternalStorageForAction(detectedExternalStorage, cliArgs, {
    defaultSources: ['preset'],
  });
  warnings.push(...externalResolved.warnings);

  const categoryKeys = resolveCategoryKeys(cliArgs.categories, MODES.ANALYSIS_ONLY, config);
  const result = await analyzeCacheFootprint({
    accounts,
    selectedAccountIds: accountResolved.selectedAccountIds,
    categoryKeys,
    externalStorageRoots: externalResolved.roots,
    nativeCorePath,
  });
  context.lastRunEngineUsed = result.engineUsed;
  if (result.nativeFallbackReason) {
    warnings.push(result.nativeFallbackReason);
  }

  return {
    ok: true,
    action: MODES.ANALYSIS_ONLY,
    dryRun: null,
    summary: {
      targetCount: result.targets.length,
      totalBytes: result.totalBytes,
      accountCount: result.accountsSummary.length,
      categoryCount: result.categoriesSummary.length,
      monthBucketCount: result.monthsSummary.length,
    },
    warnings,
    errors: [],
    data: {
      engineUsed: result.engineUsed || 'node',
      selectedAccounts: accountResolved.selectedAccountIds,
      selectedCategories: categoryKeys,
      selectedExternalRoots: externalResolved.roots,
      accountsSummary: result.accountsSummary,
      categoriesSummary: result.categoriesSummary,
      monthsSummary: result.monthsSummary,
    },
  };
}

async function runSpaceGovernanceModeNonInteractive(context, cliArgs, warnings = []) {
  const { config, aliases, nativeCorePath } = context;
  const accounts = await discoverAccounts(config.rootDir, aliases);
  const accountResolved = resolveAccountSelection(accounts, cliArgs.accounts);
  warnings.push(...accountResolved.warnings);

  const detectedExternalStorage = await detectExternalStorageRoots({
    configuredRoots: config.externalStorageRoots,
    profilesRoot: config.rootDir,
    autoDetect: config.externalStorageAutoDetect !== false,
    returnMeta: true,
  });
  const externalResolved = resolveExternalStorageForAction(detectedExternalStorage, cliArgs, {
    defaultSources: ['preset'],
  });
  warnings.push(...externalResolved.warnings);

  const scan = await scanSpaceGovernanceTargets({
    accounts,
    selectedAccountIds: accountResolved.selectedAccountIds,
    rootDir: config.rootDir,
    externalStorageRoots: externalResolved.roots,
    nativeCorePath,
    autoSuggest: config.spaceGovernance?.autoSuggest,
  });
  context.lastRunEngineUsed = scan.engineUsed;
  if (scan.nativeFallbackReason) {
    warnings.push(scan.nativeFallbackReason);
  }

  const selectableTargets = scan.targets.filter((item) => item.deletable);
  const targetIdSet = new Set(selectableTargets.map((item) => item.id));
  const selectedById =
    Array.isArray(cliArgs.targets) && cliArgs.targets.length > 0
      ? uniqueStrings(cliArgs.targets)
      : selectableTargets.map((item) => item.id);

  for (const targetId of selectedById) {
    if (!targetIdSet.has(targetId)) {
      throw new UsageError(`参数 --targets 中存在未知治理目标: ${targetId}`);
    }
  }

  const tierFilterSet = resolveGovernanceTierFilters(cliArgs.tiers || []);
  let selectedTargets = selectableTargets.filter((item) => selectedById.includes(item.id));
  if (tierFilterSet) {
    selectedTargets = selectedTargets.filter((item) => tierFilterSet.has(item.tier));
  }
  if (cliArgs.suggestedOnly === true) {
    selectedTargets = selectedTargets.filter((item) => item.suggested);
  }
  const allowRecentActive = cliArgs.allowRecentActive === true;
  const dryRun = resolveDestructiveDryRun(cliArgs);
  const governanceRoot = inferDataRootFromProfilesRoot(config.rootDir);
  const governanceAllowedRoots = governanceRoot
    ? [governanceRoot, ...externalResolved.roots]
    : [config.rootDir, ...externalResolved.roots];

  if (selectedTargets.length === 0) {
    return {
      ok: true,
      action: MODES.SPACE_GOVERNANCE,
      dryRun,
      summary: {
        matchedTargets: 0,
        reclaimedBytes: 0,
        successCount: 0,
        skippedCount: 0,
        failedCount: 0,
      },
      warnings,
      errors: [],
      data: {
        selectedAccounts: accountResolved.selectedAccountIds,
        selectedExternalRoots: externalResolved.roots,
        selectedTargetIds: [],
        engineUsed: scan.engineUsed || 'node',
      },
    };
  }

  const result = await executeCleanup({
    targets: selectedTargets,
    recycleRoot: config.recycleRoot,
    indexPath: config.indexPath,
    dryRun,
    allowedRoots: governanceAllowedRoots,
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
  });

  return {
    ok: result.failedCount === 0,
    action: MODES.SPACE_GOVERNANCE,
    dryRun,
    summary: responseSummaryFromCleanupResult(result, {
      matchedTargets: selectedTargets.length,
      allowRecentActive,
    }),
    warnings,
    errors: result.errors.map((item) => toStructuredError(item)),
    data: {
      selectedAccounts: accountResolved.selectedAccountIds,
      selectedExternalRoots: externalResolved.roots,
      selectedTargetIds: selectedTargets.map((item) => item.id),
      engineUsed: scan.engineUsed || 'node',
    },
  };
}

async function runRestoreModeNonInteractive(context, cliArgs, warnings = []) {
  const { config } = context;
  if (!cliArgs.restoreBatchId) {
    throw new UsageError('动作 --restore-batch 缺少 batchId。');
  }
  const conflictStrategy = resolveConflictStrategy(cliArgs.conflict);
  const dryRun = resolveDestructiveDryRun(cliArgs);

  const governanceRoot = inferDataRootFromProfilesRoot(config.rootDir);
  const detectedExternalStorage = await detectExternalStorageRoots({
    configuredRoots: config.externalStorageRoots,
    profilesRoot: config.rootDir,
    autoDetect: config.externalStorageAutoDetect !== false,
    returnMeta: true,
  });
  const externalResolved = resolveExternalStorageForAction(detectedExternalStorage, cliArgs, {
    defaultSources: ['all'],
  });
  warnings.push(...externalResolved.warnings);
  const governanceAllowRoots = governanceRoot
    ? [...externalResolved.roots]
    : [config.rootDir, ...externalResolved.roots];

  const batches = await listRestorableBatches(config.indexPath, { recycleRoot: config.recycleRoot });
  const batch = batches.find((item) => item.batchId === cliArgs.restoreBatchId);
  if (!batch) {
    throw new UsageError(`未找到可恢复批次: ${cliArgs.restoreBatchId}`);
  }

  const result = await restoreBatch({
    batch,
    indexPath: config.indexPath,
    dryRun,
    profileRoot: config.rootDir,
    extraProfileRoots: externalResolved.roots,
    recycleRoot: config.recycleRoot,
    governanceRoot,
    extraGovernanceRoots: governanceAllowRoots,
    onConflict: async () => ({ action: conflictStrategy, applyToAll: true }),
  });

  return {
    ok: result.failCount === 0,
    action: MODES.RESTORE,
    dryRun,
    summary: {
      batchId: result.batchId,
      successCount: result.successCount,
      skippedCount: result.skipCount,
      failedCount: result.failCount,
      restoredBytes: result.restoredBytes,
      conflictStrategy,
    },
    warnings,
    errors: result.errors.map((item) => toStructuredError(item)),
    data: {
      selectedExternalRoots: externalResolved.roots,
      governanceRoot,
    },
  };
}

async function runRecycleMaintainModeNonInteractive(context, cliArgs, warnings = []) {
  const { config } = context;
  const dryRun = resolveDestructiveDryRun(cliArgs);

  const policy = normalizeRecycleRetention({
    ...config.recycleRetention,
    enabled:
      typeof cliArgs.retentionEnabled === 'boolean'
        ? cliArgs.retentionEnabled
        : config.recycleRetention?.enabled,
    maxAgeDays:
      typeof cliArgs.retentionMaxAgeDays === 'number'
        ? cliArgs.retentionMaxAgeDays
        : config.recycleRetention?.maxAgeDays,
    minKeepBatches:
      typeof cliArgs.retentionMinKeepBatches === 'number'
        ? cliArgs.retentionMinKeepBatches
        : config.recycleRetention?.minKeepBatches,
    sizeThresholdGB:
      typeof cliArgs.retentionSizeThresholdGB === 'number'
        ? cliArgs.retentionSizeThresholdGB
        : config.recycleRetention?.sizeThresholdGB,
  });
  const result = await maintainRecycleBin({
    indexPath: config.indexPath,
    recycleRoot: config.recycleRoot,
    policy,
    dryRun,
  });

  if (!dryRun) {
    config.recycleRetention = {
      ...policy,
      lastRunAt: Date.now(),
    };
    await saveConfig(config);
  }

  return {
    ok: result.failBatches === 0,
    action: MODES.RECYCLE_MAINTAIN,
    dryRun,
    summary: {
      status: result.status,
      candidateCount: result.candidateCount,
      deletedBatches: result.deletedBatches,
      deletedBytes: result.deletedBytes,
      failedBatches: result.failBatches,
      remainingBatches: result.after?.totalBatches || 0,
      remainingBytes: result.after?.totalBytes || 0,
    },
    warnings,
    errors: result.errors.map((item) => ({
      code: item.errorType || 'E_RECYCLE_MAINTAIN_FAILED',
      message: item.message || 'unknown_error',
      batchId: item.batchId || null,
      invalidReason: item.invalidReason || null,
    })),
    data: {
      policy,
    },
  };
}

async function runDoctorModeNonInteractive(context, _cliArgs, warnings = []) {
  const report = await runDoctor({
    config: context.config,
    aliases: context.aliases,
    projectRoot: context.projectRoot,
    appVersion: context.appMeta?.version || null,
  });

  return {
    ok: true,
    action: MODES.DOCTOR,
    dryRun: null,
    summary: {
      overall: report.overall,
      pass: report.summary.pass,
      warn: report.summary.warn,
      fail: report.summary.fail,
    },
    warnings,
    errors: [],
    data: report,
  };
}

async function runNonInteractiveAction(action, context, cliArgs) {
  const warnings = [];
  if (cliArgs.actionFromMode) {
    warnings.push(`参数 --mode 已进入兼容模式，建议改为动作参数（例如 ${actionFlagName(action)}）。`);
  }

  if (action === MODES.CLEANUP_MONTHLY) {
    return runCleanupModeNonInteractive(context, cliArgs, warnings);
  }
  if (action === MODES.ANALYSIS_ONLY) {
    return runAnalysisModeNonInteractive(context, cliArgs, warnings);
  }
  if (action === MODES.SPACE_GOVERNANCE) {
    return runSpaceGovernanceModeNonInteractive(context, cliArgs, warnings);
  }
  if (action === MODES.RESTORE) {
    return runRestoreModeNonInteractive(context, cliArgs, warnings);
  }
  if (action === MODES.RECYCLE_MAINTAIN) {
    return runRecycleMaintainModeNonInteractive(context, cliArgs, warnings);
  }
  if (action === MODES.DOCTOR) {
    return runDoctorModeNonInteractive(context, cliArgs, warnings);
  }
  throw new UsageError(`不支持的无交互动作: ${action}`);
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
  const allCategoryKeys = CACHE_CATEGORIES.map((x) => x.key);

  let selectedAccountIds = [];
  let selectedExternalStorageRoots = [];
  let selectedMonths = [];
  let selectedCategories = [];
  let includeNonMonthDirs = false;
  let dryRun = Boolean(config.dryRunDefault);

  let step = 0;
  while (step < 6) {
    if (step === 0) {
      const selected = await chooseAccounts(accounts, '年月清理', {
        allowBack: false,
        guideTitle: '步骤 1/6 · 账号范围',
      });
      if (!Array.isArray(selected) || selected.length === 0) {
        return;
      }
      selectedAccountIds = selected;
      step = 1;
      continue;
    }

    if (step === 1) {
      const selected = await chooseExternalStorageRoots(detectedExternalStorage, '年月清理', {
        allowBack: true,
        guideTitle: '步骤 2/6 · 文件存储目录范围',
      });
      if (isPromptBack(selected)) {
        step = Math.max(0, step - 1);
        continue;
      }
      selectedExternalStorageRoots = Array.isArray(selected) ? selected : [];
      step = 2;
      continue;
    }

    if (step === 2) {
      const availableMonths = await collectAvailableMonths(
        accounts,
        selectedAccountIds,
        allCategoryKeys,
        selectedExternalStorageRoots
      );

      if (availableMonths.length === 0) {
        console.log('\n未发现按年月分组的缓存目录。你仍可清理非月份目录。');
        selectedMonths = [];
        step = 3;
        continue;
      }

      const selected = await configureMonths(availableMonths, { allowBack: true });
      if (isPromptBack(selected)) {
        step = Math.max(0, step - 1);
        continue;
      }
      selectedMonths = Array.isArray(selected) ? selected : [];
      step = 3;
      continue;
    }

    if (step === 3) {
      printSection('缓存类型筛选');
      printGuideBlock('步骤 4/6 · 缓存类型', [
        { label: '范围', value: '按类型限制清理目标，降低误删风险' },
        { label: '建议', value: '默认推荐项已预选，可按需调整' },
        { label: '回退', value: '可选“← 返回上一步”' },
      ]);
      const selected = await askCheckbox({
        message: '选择要清理的缓存类型',
        required: true,
        allowBack: true,
        choices: categoryChoices(config.defaultCategories),
        validate: (values) => (values.length > 0 ? true : '至少选择一个类型'),
      });
      if (isPromptBack(selected)) {
        step = Math.max(0, step - 1);
        continue;
      }
      selectedCategories = selected;
      step = 4;
      continue;
    }

    if (step === 4) {
      printSection('目录粒度策略');
      printGuideBlock('步骤 5/6 · 非月份目录策略', [
        { label: '含义', value: '非月份目录常见于临时目录、数字目录等' },
        { label: '风险', value: '勾选后命中范围会更大，请先预览' },
        { label: '回退', value: '可选“← 返回上一步”' },
      ]);
      const selected = await askConfirmWithBack({
        message: '是否包含非月份目录（如数字目录、临时目录）？',
        default: false,
      });
      if (isPromptBack(selected)) {
        step = Math.max(0, step - 1);
        continue;
      }
      includeNonMonthDirs = selected;
      step = 5;
      continue;
    }

    printSection('执行方式');
    printGuideBlock('步骤 6/6 · 预览与执行', [
      { label: 'dry-run', value: '只预览命中结果，不执行删除' },
      { label: '真实删', value: '移动到程序回收区，可按批次恢复' },
      { label: '回退', value: '可选“← 返回上一步”' },
    ]);
    const selected = await askConfirmWithBack({
      message: '先 dry-run 预览（不执行删除）？',
      default: Boolean(config.dryRunDefault),
    });
    if (isPromptBack(selected)) {
      step = Math.max(0, step - 1);
      continue;
    }
    dryRun = selected;
    step = 6;
  }

  printSection('向导配置确认');
  const categoryLabelByKey = new Map(CACHE_CATEGORIES.map((cat) => [cat.key, cat.label]));
  const selectedCategoryText = selectedCategories.map((key) => categoryLabelByKey.get(key) || key).join('、');
  printGuideBlock('即将执行的配置', [
    { label: '账号', value: `${selectedAccountIds.length} 个` },
    {
      label: '年月',
      value: selectedMonths.length > 0 ? `${selectedMonths.length} 个` : '不过滤（仅非月份或按类型命中）',
    },
    {
      label: '类型',
      value: selectedCategoryText || '-',
    },
    {
      label: '文件存储',
      value:
        selectedExternalStorageRoots.length > 0
          ? `${selectedExternalStorageRoots.length} 个目录`
          : '未纳入额外文件存储目录',
    },
    { label: '非月份', value: includeNonMonthDirs ? '包含' : '不包含' },
    { label: '模式', value: dryRun ? 'dry-run（预览）' : '真实删除（回收区）' },
  ]);

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
    allowedRoots: [config.rootDir, ...selectedExternalStorageRoots],
    onProgress: (current, total) => printProgress('移动目录', current, total),
  });

  printSection('删除结果');
  printGuideBlock('结果摘要', [
    { label: '批次', value: result.batchId },
    { label: '模式', value: executeDryRun ? 'dry-run（预览）' : '真实删除（回收区）' },
    { label: '成功', value: `${result.successCount} 项` },
    { label: '跳过', value: `${result.skippedCount} 项` },
    { label: '失败', value: `${result.failedCount} 项` },
    { label: '释放', value: formatBytes(result.reclaimedBytes) },
  ]);
  if (result.failedCount > 0) {
    printGuideBlock('结果建议', [{ label: '建议', value: '请查看失败明细，修复路径或权限后重试。' }]);
  }
  console.log(`批次ID   : ${result.batchId}`);
  console.log(`成功数量 : ${result.successCount}`);
  console.log(`跳过数量 : ${result.skippedCount}`);
  console.log(`失败数量 : ${result.failedCount}`);
  console.log(`释放体积 : ${formatBytes(result.reclaimedBytes)}`);

  await printErrorDiagnostics(result.errors, {
    defaultLimit: 5,
    headers: ['路径', '错误'],
    mapRow: (item) => [item.path || '-', item.message || '-'],
  });
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

  const selectedAccountIds = await chooseAccounts(accounts, '会话分析（只读）', {
    guideTitle: '步骤 1/3 · 账号范围',
    guideRows: [
      { label: '模式', value: '只读分析，不执行删除' },
      { label: '范围', value: '建议先聚焦常用账号，避免分析结果过载' },
      { label: '操作', value: '空格勾选，Enter 确认' },
    ],
  });
  if (selectedAccountIds.length === 0) {
    return;
  }
  const selectedExternalStorageRoots = await chooseExternalStorageRoots(
    detectedExternalStorage,
    '会话分析（只读）',
    {
      guideTitle: '步骤 2/3 · 文件存储目录范围',
      guideRows: [
        { label: '默认', value: '默认/手动目录已预选' },
        { label: '自动', value: '自动探测目录建议按需纳入' },
        { label: '提示', value: '分析仅统计体积，不做移动或删除' },
      ],
    }
  );

  printSection('分析范围设置');
  printGuideBlock('步骤 3/3 · 缓存类型范围', [
    { label: '建议', value: '可先全选做全景盘点，再聚焦热点类型' },
    { label: '安全', value: '当前流程只读，不写入数据目录' },
    { label: '确认', value: '空格勾选，Enter 确认' },
  ]);
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
    selectedAccountIds = await chooseAccounts(accounts, '全量空间治理（账号相关目录）', {
      guideTitle: '治理步骤 1/5 · 账号范围',
      guideRows: [
        { label: '目标', value: '限定账号相关目录，避免无关扫描' },
        { label: '建议', value: '优先处理当前登录账号与高占用账号' },
        { label: '操作', value: '空格勾选，Enter 确认' },
      ],
    });
  } else {
    printSection('账号范围（全量治理）');
    printGuideBlock('治理步骤 1/5 · 账号范围', [
      { label: '状态', value: '未识别账号目录，将仅处理容器级治理目标' },
      { label: '影响', value: '不会阻塞治理，可继续执行' },
    ]);
  }
  const selectedExternalStorageRoots = await chooseExternalStorageRoots(
    detectedExternalStorage,
    '全量空间治理',
    {
      guideTitle: '治理步骤 2/5 · 文件存储目录范围',
      guideRows: [
        { label: '策略', value: '默认/手动目录预选，自动探测目录需确认' },
        { label: '风险', value: '目录越多，命中范围越大，请结合预览确认' },
        { label: '目标', value: '仅纳入确认为企业微信缓存的路径' },
      ],
    }
  );

  printSection('扫描治理目录并计算大小');
  printGuideBlock('治理步骤 3/5 · 扫描与建议', [
    { label: '分级', value: '按安全层/谨慎层/受保护层分类' },
    { label: '建议', value: '默认建议阈值：体积 + 静置天数' },
    { label: '保障', value: '仅生成候选列表，不会立即删除' },
  ]);
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

  printSection('治理目标选择');
  printGuideBlock('治理步骤 4/5 · 选择目录', [
    { label: '预选', value: '建议项默认预选，可手动调整' },
    { label: '层级', value: '谨慎层会触发二次确认' },
    { label: '确认', value: '空格勾选，Enter 确认' },
  ]);
  const lastSelected = new Set(config.spaceGovernance?.lastSelectedTargets || []);
  const selectedIds = await askCheckbox({
    message: '选择要治理的目录（建议项会预选）',
    required: true,
    choices: selectableTargets.map((item) => ({
      name: `${item.suggested ? '[建议] ' : ''}[${governanceTierLabel(item.tier)}] ${item.targetLabel} | ${item.accountShortId} | ${formatBytes(item.sizeBytes)} | 静置${formatIdleDaysText(item.idleDays)} | ${trimToWidth(formatGovernancePath(item, scan.dataRoot), 36)}`,
      value: item.id,
      checked:
        lastSelected.size > 0
          ? lastSelected.has(item.id)
          : item.suggested && item.tier === SPACE_GOVERNANCE_TIERS.SAFE,
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

  printSection('执行确认');
  printGuideBlock('治理步骤 5/5 · 执行策略', [
    { label: '目标', value: `已选 ${selectedTargets.length} 项（谨慎层 ${cautionTargets.length} 项）` },
    { label: '模式', value: '可先 dry-run，再决定是否真实治理' },
    { label: '保护', value: '真实治理包含冷静期 + CLEAN 确认词' },
  ]);
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
  const governanceAllowedRoots = scan.dataRoot
    ? [scan.dataRoot, ...selectedExternalStorageRoots]
    : [config.rootDir, ...selectedExternalStorageRoots];
  const result = await executeCleanup({
    targets: selectedTargets,
    recycleRoot: config.recycleRoot,
    indexPath: config.indexPath,
    dryRun,
    allowedRoots: governanceAllowedRoots,
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
  printGuideBlock('结果摘要', [
    { label: '批次', value: result.batchId },
    { label: '模式', value: dryRun ? 'dry-run（预览）' : '真实治理（回收区）' },
    { label: '成功', value: `${result.successCount} 项` },
    { label: '跳过', value: `${result.skippedCount} 项` },
    { label: '失败', value: `${result.failedCount} 项` },
    { label: '释放', value: formatBytes(result.reclaimedBytes) },
  ]);
  if (result.failedCount > 0 || result.skippedCount > 0) {
    printGuideBlock('结果建议', [
      {
        label: '建议',
        value: '建议复核“跳过/失败”明细，确认是否需要放宽活跃目录策略后重试。',
      },
    ]);
  }
  console.log(`批次ID   : ${result.batchId}`);
  console.log(`成功数量 : ${result.successCount}`);
  console.log(`跳过数量 : ${result.skippedCount}`);
  console.log(`失败数量 : ${result.failedCount}`);
  console.log(`释放体积 : ${formatBytes(result.reclaimedBytes)}`);

  await printErrorDiagnostics(result.errors, {
    defaultLimit: 5,
    headers: ['路径', '错误'],
    mapRow: (item) => [item.path || '-', item.message || '-'],
  });
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
  const scope = String(conflict?.entry?.scope || MODES.CLEANUP_MONTHLY);
  const scopeText = scope === MODES.SPACE_GOVERNANCE ? '全量治理批次' : '年月清理批次';
  const targetPathText = trimToWidth(String(conflict?.originalPath || '-'), 66);
  const recyclePathText = trimToWidth(String(conflict?.recyclePath || '-'), 66);
  const sizeText = formatBytes(Number(conflict?.entry?.sizeBytes || 0));

  printSection('恢复冲突处理');
  printGuideBlock('冲突说明', [
    { label: '目标', value: targetPathText },
    { label: '来源', value: recyclePathText },
    { label: '范围', value: scopeText },
    { label: '大小', value: sizeText },
    { label: '建议', value: '默认建议先“跳过该项”，确认后再决定覆盖或重命名' },
  ]);

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
  const governanceAllowRoots = governanceRoot
    ? [...externalStorageRoots]
    : [config.rootDir, ...externalStorageRoots];

  const batches = await listRestorableBatches(config.indexPath, { recycleRoot: config.recycleRoot });
  if (batches.length === 0) {
    console.log('\n暂无可恢复批次。');
    return;
  }

  printSection('可恢复批次');
  printGuideBlock('恢复步骤 1/3 · 批次选择', [
    { label: '来源', value: '仅展示回收区中可恢复且索引有效的批次' },
    { label: '建议', value: '优先恢复最近批次，便于问题回滚' },
    { label: '确认', value: 'Enter 选中后进入恢复确认' },
  ]);
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

  printSection('恢复配置确认');
  printGuideBlock('恢复步骤 2/3 · 白名单与冲突策略', [
    { label: '批次', value: `${batch.batchId}（${batch.entries.length} 项）` },
    {
      label: '范围',
      value: governanceRoot
        ? `Data 根目录 + 文件存储目录(${externalStorageRoots.length}项)`
        : `Profile 根目录 + 文件存储目录(${externalStorageRoots.length}项)`,
    },
    { label: '冲突', value: '若目标已存在，将询问 跳过/覆盖/重命名' },
    { label: '安全', value: '路径越界会自动拦截并记审计状态' },
  ]);
  printSection('恢复执行策略');
  const previewFirst = await askConfirm({
    message: '先 dry-run 预演恢复？',
    default: true,
  });

  const runRestoreOnce = async (dryRun) => {
    printSection(dryRun ? '恢复预演中（dry-run）' : '恢复中');
    printGuideBlock('恢复步骤 3/3 · 执行中', [
      { label: '动作', value: '按批次回放恢复，逐项校验路径边界' },
      { label: '审计', value: '成功/跳过/失败都会写入索引' },
      { label: '模式', value: dryRun ? 'dry-run 预演（不落盘）' : '真实恢复（落盘）' },
    ]);
    if (governanceRoot) {
      console.log(`治理恢复白名单: Data 根目录 + 文件存储目录(${externalStorageRoots.length}项)`);
    } else {
      console.log(
        `治理恢复白名单: 未识别Data根，已回退到 Profile 根目录 + 文件存储目录(${externalStorageRoots.length}项)`
      );
    }

    const result = await restoreBatch({
      batch,
      indexPath: config.indexPath,
      onProgress: (current, total) => printProgress('恢复目录', current, total),
      onConflict: askConflictResolution,
      dryRun,
      profileRoot: config.rootDir,
      extraProfileRoots: externalStorageRoots,
      recycleRoot: config.recycleRoot,
      governanceRoot,
      extraGovernanceRoots: governanceAllowRoots,
    });

    printSection(dryRun ? '恢复预演结果（dry-run）' : '恢复结果');
    printGuideBlock('结果摘要', [
      { label: '批次', value: result.batchId },
      { label: '模式', value: dryRun ? 'dry-run 预演' : '真实恢复' },
      { label: '成功', value: `${result.successCount} 项` },
      { label: '跳过', value: `${result.skipCount} 项` },
      { label: '失败', value: `${result.failCount} 项` },
      { label: '恢复', value: formatBytes(result.restoredBytes) },
    ]);
    if (result.failCount > 0 || result.skipCount > 0) {
      printGuideBlock('结果建议', [
        {
          label: '建议',
          value: '若有冲突或越界拦截，请按提示修正后重新恢复剩余项。',
        },
      ]);
    }
    console.log(`批次ID   : ${result.batchId}`);
    console.log(`成功数量 : ${result.successCount}`);
    console.log(`跳过数量 : ${result.skipCount}`);
    console.log(`失败数量 : ${result.failCount}`);
    console.log(`恢复体积 : ${formatBytes(result.restoredBytes)}`);

    await printErrorDiagnostics(result.errors, {
      defaultLimit: 5,
      headers: ['路径', '错误'],
      mapRow: (item) => [item.sourcePath || '-', item.message || '-'],
    });
    return result;
  };

  if (previewFirst) {
    await runRestoreOnce(true);
    const continueReal = await askConfirm({
      message: 'dry-run 预演已完成，是否继续执行真实恢复？',
      default: false,
    });
    if (!continueReal) {
      console.log('已结束：dry-run 预演已完成，未执行真实恢复。');
      return;
    }
  }

  await runRestoreOnce(false);
}

async function runDoctorMode(context, options = {}) {
  const { config, aliases, appMeta } = context;
  const report = await runDoctor({
    config,
    aliases,
    projectRoot: context.projectRoot,
    appVersion: appMeta?.version || null,
  });
  await printDoctorReport(report, Boolean(options.jsonOutput));
}

async function runRecycleMaintainMode(context, options = {}) {
  const { config } = context;
  const policy = normalizeRecycleRetention(config.recycleRetention);
  const stats = await collectRecycleStats({
    indexPath: config.indexPath,
    recycleRoot: config.recycleRoot,
  });
  const thresholdBytes = recycleThresholdBytes(config);
  const overThreshold = stats.totalBytes > thresholdBytes;

  printSection('回收区治理预览');
  printGuideBlock('治理策略', [
    { label: '启用', value: policy.enabled ? '是' : '否' },
    { label: '保留', value: `最近 ${policy.minKeepBatches} 批 + ${policy.maxAgeDays} 天内` },
    { label: '容量', value: `${formatBytes(thresholdBytes)}（当前 ${formatBytes(stats.totalBytes)}）` },
    { label: '批次', value: `${stats.totalBatches} 批` },
    { label: '状态', value: overThreshold ? '已超过阈值' : '未超过阈值' },
  ]);

  if (!policy.enabled) {
    console.log('回收区治理策略已关闭，请在“交互配置”中开启。');
    return;
  }

  const force = Boolean(options.force);
  let dryRun = true;
  if (force) {
    dryRun = false;
  } else {
    dryRun = await askConfirm({
      message: '先 dry-run 预览回收区治理计划？',
      default: true,
    });
  }

  if (!dryRun && !force) {
    const sure = await askConfirm({
      message: '将按策略清理回收区历史批次，是否继续？',
      default: false,
    });
    if (!sure) {
      console.log('已取消回收区治理。');
      return;
    }
  }

  printSection('回收区治理中');
  const result = await maintainRecycleBin({
    indexPath: config.indexPath,
    recycleRoot: config.recycleRoot,
    policy,
    dryRun,
    onProgress: (current, total) => printProgress('清理批次', current, total),
  });

  if (!dryRun) {
    config.recycleRetention = {
      ...policy,
      lastRunAt: Date.now(),
    };
    await saveConfig(config);
  }

  printSection('回收区治理结果');
  printGuideBlock('结果摘要', [
    { label: '状态', value: result.status },
    { label: '模式', value: dryRun ? 'dry-run 预览' : '真实清理' },
    { label: '候选', value: `${result.candidateCount} 批` },
    { label: '已清理', value: `${result.deletedBatches} 批` },
    { label: '释放', value: formatBytes(result.deletedBytes) },
    { label: '剩余', value: `${result.after.totalBatches} 批 / ${formatBytes(result.after.totalBytes)}` },
  ]);
  if (result.failBatches > 0) {
    printGuideBlock('结果建议', [{ label: '建议', value: '部分批次清理失败，请检查目录权限后重试。' }]);
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
        {
          name: `回收区保留策略: ${config.recycleRetention.enabled ? '开' : '关'} | ${config.recycleRetention.maxAgeDays}天 | 最近${config.recycleRetention.minKeepBatches}批 | ${config.recycleRetention.sizeThresholdGB}GB`,
          value: 'recycleRetention',
        },
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
      continue;
    }

    if (choice === 'recycleRetention') {
      const enabled = await askConfirm({
        message: '是否启用回收区保留策略？',
        default: config.recycleRetention.enabled !== false,
      });

      const maxAgeDays = await askInput({
        message: '输入保留天数阈值（超过该天数可清理）',
        default: String(config.recycleRetention.maxAgeDays),
        validate: (value) => {
          const n = Number.parseInt(value, 10);
          return Number.isFinite(n) && n >= 1 ? true : '请输入 >= 1 的整数';
        },
      });
      const minKeepBatches = await askInput({
        message: '输入至少保留最近批次数',
        default: String(config.recycleRetention.minKeepBatches),
        validate: (value) => {
          const n = Number.parseInt(value, 10);
          return Number.isFinite(n) && n >= 1 ? true : '请输入 >= 1 的整数';
        },
      });
      const sizeThresholdGB = await askInput({
        message: '输入容量阈值（GB，超过后会提示治理）',
        default: String(config.recycleRetention.sizeThresholdGB),
        validate: (value) => {
          const n = Number.parseInt(value, 10);
          return Number.isFinite(n) && n >= 1 ? true : '请输入 >= 1 的整数';
        },
      });

      config.recycleRetention = normalizeRecycleRetention({
        ...config.recycleRetention,
        enabled,
        maxAgeDays: Number.parseInt(maxAgeDays, 10),
        minKeepBatches: Number.parseInt(minKeepBatches, 10),
        sizeThresholdGB: Number.parseInt(sizeThresholdGB, 10),
      });
      await saveConfig(config);
      console.log('已保存回收区保留策略。');
    }
  }
}

async function runMode(mode, context, options = {}) {
  if (mode === MODES.CLEANUP_MONTHLY) {
    await runCleanupMode(context);
    await printRecyclePressureHint(context.config);
    return;
  }
  if (mode === MODES.ANALYSIS_ONLY) {
    await runAnalysisMode(context);
    return;
  }
  if (mode === MODES.SPACE_GOVERNANCE) {
    await runSpaceGovernanceMode(context);
    await printRecyclePressureHint(context.config);
    return;
  }
  if (mode === MODES.RESTORE) {
    await runRestoreMode(context);
    return;
  }
  if (mode === MODES.DOCTOR) {
    await runDoctorMode(context, options);
    return;
  }
  if (mode === MODES.RECYCLE_MAINTAIN) {
    await runRecycleMaintainMode(context, options);
    return;
  }
  if (mode === MODES.SETTINGS) {
    await runSettingsMode(context);
    return;
  }
  throw new Error(`不支持的运行模式: ${mode}`);
}

function formatLockOwner(lockInfo) {
  if (!lockInfo || typeof lockInfo !== 'object') {
    return '未知实例';
  }
  const pid = Number(lockInfo.pid || 0);
  const mode = String(lockInfo.mode || 'unknown');
  const host = String(lockInfo.hostname || 'unknown');
  const startedAt = Number(lockInfo.startedAt || 0);
  const startedText = Number.isFinite(startedAt) && startedAt > 0 ? formatLocalDate(startedAt) : 'unknown';
  return `PID ${pid || '-'} | 模式 ${mode} | 主机 ${host} | 启动 ${startedText}`;
}

async function acquireExecutionLock(stateRoot, mode, options = {}) {
  try {
    return await acquireLock(stateRoot, mode);
  } catch (error) {
    if (!(error instanceof LockHeldError)) {
      throw error;
    }

    const ownerText = formatLockOwner(error.lockInfo);
    if (!error.isStale) {
      throw new Error(`已有实例正在运行：${ownerText}`);
    }

    if (options.force) {
      await breakLock(error.lockPath);
      return acquireLock(stateRoot, mode);
    }

    if (!process.stdout.isTTY) {
      throw new Error(`检测到疑似陈旧锁：${ownerText}。可追加 --force 自动清理后重试。`);
    }

    const clearStaleLock = await askConfirm({
      message: `检测到陈旧锁（${ownerText}），是否清理后继续？`,
      default: false,
    });
    if (!clearStaleLock) {
      throw new Error('已取消：未清理陈旧锁。');
    }
    await breakLock(error.lockPath);
    return acquireLock(stateRoot, mode);
  }
}

async function runInteractiveLoop(context) {
  while (true) {
    const accounts = await discoverAccounts(context.config.rootDir, context.aliases);
    const detectedExternalStorage = await detectExternalStorageRoots({
      configuredRoots: context.config.externalStorageRoots,
      profilesRoot: context.config.rootDir,
      autoDetect: context.config.externalStorageAutoDetect !== false,
      returnMeta: true,
    });
    const detectedExternalStorageRoots = detectedExternalStorage.roots;
    const profileRootHealth = await evaluateProfileRootHealth(context.config.rootDir, accounts);
    printHeader({
      config: context.config,
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
        { name: '回收区治理（保留策略）', value: MODES.RECYCLE_MAINTAIN },
        { name: '系统自检（doctor）', value: MODES.DOCTOR },
        { name: '交互配置', value: MODES.SETTINGS },
        { name: '退出', value: 'exit' },
      ],
    });

    if (mode === 'exit') {
      break;
    }

    await runMode(mode, context, {
      jsonOutput: false,
      force: false,
    });

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

async function main() {
  const rawArgv = process.argv.slice(2);
  const hasAnyArgs = rawArgv.length > 0;
  const cliArgs = parseCliArgs(rawArgv);
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const projectRoot = path.resolve(__dirname, '..');
  const appMeta = await loadAppMeta(projectRoot);

  if (cliArgs.version) {
    console.log(appMeta.version);
    return;
  }
  if (cliArgs.help) {
    printCliUsage(appMeta);
    return;
  }

  const forceInteractive = cliArgs.interactive === true;
  const hasNonInteractiveArgs = hasAnyArgs && !forceInteractive;
  const action = resolveActionFromCli(cliArgs, hasNonInteractiveArgs);
  const interactiveMode = !hasNonInteractiveArgs;
  const interactiveStartMode = interactiveMode ? resolveInteractiveStartMode(cliArgs) : MODES.START;
  const lockMode = interactiveMode ? interactiveStartMode : action || MODES.START;
  const readOnlyConfig = lockMode === MODES.DOCTOR;

  const config = await loadConfig(cliArgs, {
    readOnly: readOnlyConfig,
  });
  const aliases = await loadAliases(config.aliasPath);

  const nativeProbe =
    lockMode === MODES.DOCTOR
      ? { nativeCorePath: null, repairNote: null }
      : await detectNativeCore(projectRoot, {
          stateRoot: config.stateRoot,
          allowAutoRepair: true,
        });
  const outputMode = normalizeActionOutputMode(cliArgs);

  const context = {
    config,
    aliases,
    nativeCorePath: nativeProbe.nativeCorePath || null,
    nativeRepairNote: nativeProbe.repairNote || null,
    appMeta,
    projectRoot,
  };

  let lockHandle = null;
  if (lockMode !== MODES.DOCTOR) {
    lockHandle = await acquireExecutionLock(config.stateRoot, lockMode, { force: cliArgs.force });
  }

  try {
    if (interactiveMode) {
      if (interactiveStartMode !== MODES.START) {
        await runMode(interactiveStartMode, context, {
          jsonOutput: false,
          force: cliArgs.force,
        });
        return;
      }
      await runInteractiveLoop(context);
      return;
    }

    const startedAt = Date.now();
    const result = await runNonInteractiveAction(action, context, cliArgs);
    if (cliArgs.saveConfig) {
      await saveConfig(config);
    }

    const payload = {
      ok: Boolean(result.ok),
      action,
      dryRun: result.dryRun ?? null,
      summary: result.summary || {},
      warnings: Array.isArray(result.warnings) ? result.warnings : [],
      errors: Array.isArray(result.errors) ? result.errors : [],
      data: result.data || {},
      meta: {
        app: APP_NAME,
        package: PACKAGE_NAME,
        version: appMeta.version,
        timestamp: Date.now(),
        durationMs: Date.now() - startedAt,
        output: outputMode,
        engine: context.lastRunEngineUsed || (context.nativeCorePath ? 'zig_ready' : 'node'),
      },
    };
    emitNonInteractivePayload(payload, outputMode);
    if (!payload.ok) {
      process.exitCode = 1;
    }
  } finally {
    if (lockHandle && typeof lockHandle.release === 'function') {
      await lockHandle.release();
    }
  }
}

main().catch((error) => {
  if (error instanceof PromptAbortError) {
    console.log('\n已取消。');
    process.exit(0);
  }
  if (error instanceof ConfirmationRequiredError) {
    console.error(`确认错误: ${error.message}`);
    process.exit(3);
  }
  if (error instanceof CliArgError) {
    console.error(`参数错误: ${error.message}`);
    process.exit(2);
  }
  console.error('运行失败:', error instanceof Error ? error.message : error);
  process.exit(1);
});
