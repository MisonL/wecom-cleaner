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
  applyUpdateCheckResult,
  channelLabel,
  checkLatestVersion,
  normalizeSelfUpdateConfig,
  normalizeUpgradeChannel,
  runUpgrade,
  runSkillsUpgrade,
  shouldCheckForUpdate,
  shouldSkipVersion,
  updateWarningMessage,
} from './updater.js';
import { inspectSkillBinding, installSkill, skillBindingStatusLabel } from './skill-installer.js';
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
  MODES.CHECK_UPDATE,
  MODES.UPGRADE,
  MODES.SYNC_SKILLS,
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
  ['check_update', MODES.CHECK_UPDATE],
  ['check-update', MODES.CHECK_UPDATE],
  ['sync_skills', MODES.SYNC_SKILLS],
  ['sync-skills', MODES.SYNC_SKILLS],
  ['settings', MODES.SETTINGS],
]);
const OUTPUT_JSON = 'json';
const OUTPUT_TEXT = 'text';
const RUN_TASK_PREVIEW = 'preview';
const RUN_TASK_EXECUTE = 'execute';
const RUN_TASK_PREVIEW_EXECUTE_VERIFY = 'preview-execute-verify';
const RUN_TASK_MODES = new Set([RUN_TASK_PREVIEW, RUN_TASK_EXECUTE, RUN_TASK_PREVIEW_EXECUTE_VERIFY]);
const SCAN_DEBUG_OFF = 'off';
const SCAN_DEBUG_SUMMARY = 'summary';
const SCAN_DEBUG_FULL = 'full';
const SCAN_DEBUG_LEVELS = new Set([SCAN_DEBUG_OFF, SCAN_DEBUG_SUMMARY, SCAN_DEBUG_FULL]);
const DESTRUCTIVE_ACTIONS = new Set([
  MODES.CLEANUP_MONTHLY,
  MODES.SPACE_GOVERNANCE,
  MODES.RESTORE,
  MODES.RECYCLE_MAINTAIN,
]);
const UPDATE_REPO_OWNER = 'MisonL';
const UPDATE_REPO_NAME = 'wecom-cleaner';
const UPDATE_TIMEOUT_MS = 2500;

function allowAutoUpdateByEnv() {
  const raw = String(process.env.WECOM_CLEANER_AUTO_UPDATE || 'true')
    .trim()
    .toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

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

function resolveSkillStatus(skillSummary) {
  const summary = skillSummary && typeof skillSummary === 'object' ? skillSummary : null;
  if (!summary) {
    return {
      badge: 'Skills未知',
      detail: '未获取到 skills 版本状态',
      tone: 'muted',
    };
  }
  if (summary.matched) {
    return {
      badge: 'Skills匹配',
      detail: `skills v${summary.installedSkillVersion || '-'} 已匹配主程序 v${summary.expectedAppVersion || '-'}`,
      tone: 'ok',
    };
  }
  if (summary.status === 'not_installed') {
    return {
      badge: 'Skills未装',
      detail: '未检测到 Agent Skills，建议执行“同步 Agent Skills”',
      tone: 'warn',
    };
  }
  if (summary.status === 'legacy_unversioned') {
    return {
      badge: 'Skills旧版',
      detail: '检测到旧版 skills（缺少版本信息），建议同步升级',
      tone: 'warn',
    };
  }
  if (summary.status === 'mismatch') {
    return {
      badge: 'Skills待同步',
      detail: `skills 绑定 ${summary.installedRequiredAppVersion || '-'}，当前程序 ${summary.expectedAppVersion || '-'}`,
      tone: 'warn',
    };
  }
  return {
    badge: 'Skills异常',
    detail: 'skills 目录状态异常，建议执行同步修复',
    tone: 'warn',
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
  skillSummary = null,
}) {
  console.clear();
  const normalizedThemeMode = normalizeThemeMode(config.theme);
  const resolvedThemeMode = resolveThemeMode(config.theme);
  const palette = resolveInfoPalette(resolvedThemeMode);
  const engineStatus = resolveEngineStatus({ nativeCorePath, lastRunEngineUsed });
  const skillStatus = resolveSkillStatus(skillSummary);
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
    renderBadge(skillStatus.badge, skillStatus.tone, palette),
    renderBadge(formatThemeStatus(config.theme, resolvedThemeMode), 'muted', palette),
  ];
  console.log(`${INFO_LEFT_PADDING}${stateBadges.join(' ')}`);
  printLine('引擎说明', engineStatus.detail, { muted: true });
  printLine('skills说明', skillStatus.detail, { muted: true });
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
    printLine('探测提示', '自动探测目录已默认纳入，可在后续步骤取消勾选。', { muted: true });
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
        { label: '默认', value: '默认/手动/自动目录均已预选，可按需取消' },
        { label: '自动', value: '自动探测目录可能包含非企微路径，执行前请再次确认' },
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
      checked: true,
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
        message: `已勾选自动探测目录 ${autoSelected.length} 项，可能包含非企业微信目录。确认继续纳入本次扫描吗？`,
        default: true,
      })
    : await askConfirm({
        message: `已勾选自动探测目录 ${autoSelected.length} 项，可能包含非企业微信目录。确认继续纳入本次扫描吗？`,
        default: true,
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

function resolveCleanupTargetRootPath(target) {
  const accountPath = String(target?.accountPath || '').trim();
  const categoryPath = String(target?.categoryPath || '').trim();
  if (accountPath && categoryPath) {
    return path.resolve(accountPath, categoryPath);
  }
  if (accountPath) {
    return path.resolve(accountPath);
  }
  if (target?.path) {
    return path.dirname(path.resolve(target.path));
  }
  return null;
}

function pushTopTargetRow(rows, row, limit = 20) {
  rows.push(row);
  rows.sort((a, b) => Number(b.sizeBytes || 0) - Number(a.sizeBytes || 0));
  if (rows.length > limit) {
    rows.length = limit;
  }
}

function buildCleanupTargetReport(targets, { topPathLimit = 20 } = {}) {
  const categoryMap = new Map();
  const monthMap = new Map();
  const accountMap = new Map();
  const rootMap = new Map();
  const monthSet = new Set();
  const topPaths = [];
  let totalBytes = 0;

  for (const item of targets || []) {
    const sizeBytes = Number(item?.sizeBytes || 0);
    totalBytes += sizeBytes;

    const categoryKey = String(item?.categoryKey || 'unknown');
    if (!categoryMap.has(categoryKey)) {
      categoryMap.set(categoryKey, {
        categoryKey,
        categoryLabel: item?.categoryLabel || categoryKey,
        targetCount: 0,
        sizeBytes: 0,
      });
    }
    const categoryRow = categoryMap.get(categoryKey);
    categoryRow.targetCount += 1;
    categoryRow.sizeBytes += sizeBytes;

    const monthKey = String(item?.monthKey || '非月份目录');
    if (monthKey !== '非月份目录') {
      monthSet.add(monthKey);
    }
    if (!monthMap.has(monthKey)) {
      monthMap.set(monthKey, {
        monthKey,
        targetCount: 0,
        sizeBytes: 0,
      });
    }
    const monthRow = monthMap.get(monthKey);
    monthRow.targetCount += 1;
    monthRow.sizeBytes += sizeBytes;

    const accountKey = String(item?.accountId || 'unknown');
    if (!accountMap.has(accountKey)) {
      accountMap.set(accountKey, {
        accountId: item?.accountId || null,
        accountShortId: item?.accountShortId || '-',
        userName: item?.userName || '-',
        corpName: item?.corpName || '-',
        isExternalStorage: Boolean(item?.isExternalStorage),
        targetCount: 0,
        sizeBytes: 0,
      });
    }
    const accountRow = accountMap.get(accountKey);
    accountRow.targetCount += 1;
    accountRow.sizeBytes += sizeBytes;

    const rootPath = resolveCleanupTargetRootPath(item);
    const rootKey = rootPath || '(unknown)';
    if (!rootMap.has(rootKey)) {
      rootMap.set(rootKey, {
        rootPath: rootPath || null,
        rootType: item?.isExternalStorage ? 'external' : 'profile',
        targetCount: 0,
        sizeBytes: 0,
      });
    }
    const rootRow = rootMap.get(rootKey);
    rootRow.targetCount += 1;
    rootRow.sizeBytes += sizeBytes;

    pushTopTargetRow(
      topPaths,
      {
        path: item?.path || null,
        sizeBytes,
        categoryKey,
        categoryLabel: item?.categoryLabel || categoryKey,
        monthKey: item?.monthKey || null,
        accountShortId: item?.accountShortId || '-',
        isExternalStorage: Boolean(item?.isExternalStorage),
      },
      topPathLimit
    );
  }

  const matchedMonths = [...monthSet].sort((a, b) => compareMonthKey(a, b));
  const monthRange =
    matchedMonths.length > 0
      ? {
          from: matchedMonths[0],
          to: matchedMonths[matchedMonths.length - 1],
        }
      : null;

  const byBytesDesc = (a, b) => {
    const bytesDiff = Number(b.sizeBytes || 0) - Number(a.sizeBytes || 0);
    if (bytesDiff !== 0) {
      return bytesDiff;
    }
    return Number(b.targetCount || 0) - Number(a.targetCount || 0);
  };
  const byMonth = [...monthMap.values()].sort((a, b) => {
    const aMonth = String(a.monthKey || '非月份目录');
    const bMonth = String(b.monthKey || '非月份目录');
    if (aMonth === '非月份目录' && bMonth !== '非月份目录') {
      return 1;
    }
    if (aMonth !== '非月份目录' && bMonth === '非月份目录') {
      return -1;
    }
    if (aMonth === bMonth) {
      return Number(b.sizeBytes || 0) - Number(a.sizeBytes || 0);
    }
    return compareMonthKey(aMonth, bMonth);
  });

  return {
    totalTargets: Array.isArray(targets) ? targets.length : 0,
    totalBytes,
    monthRange,
    matchedMonths,
    categoryStats: [...categoryMap.values()].sort(byBytesDesc),
    monthStats: byMonth,
    accountStats: [...accountMap.values()].sort(byBytesDesc),
    rootStats: [...rootMap.values()].sort(byBytesDesc),
    topPaths,
  };
}

function buildGovernanceTargetReport(targets, { topPathLimit = 20 } = {}) {
  const byTierMap = new Map();
  const byTargetMap = new Map();
  const byAccountMap = new Map();
  const byRootMap = new Map();
  const topPaths = [];
  let totalBytes = 0;

  for (const item of targets || []) {
    const sizeBytes = Number(item?.sizeBytes || 0);
    totalBytes += sizeBytes;

    const tierKey = String(item?.tier || 'unknown');
    if (!byTierMap.has(tierKey)) {
      byTierMap.set(tierKey, {
        tier: tierKey,
        tierLabel: governanceTierLabel(tierKey),
        targetCount: 0,
        sizeBytes: 0,
        suggestedCount: 0,
        recentlyActiveCount: 0,
      });
    }
    const tierRow = byTierMap.get(tierKey);
    tierRow.targetCount += 1;
    tierRow.sizeBytes += sizeBytes;
    if (item?.suggested) {
      tierRow.suggestedCount += 1;
    }
    if (item?.recentlyActive) {
      tierRow.recentlyActiveCount += 1;
    }

    const targetKey = String(item?.targetKey || item?.categoryKey || 'unknown');
    if (!byTargetMap.has(targetKey)) {
      byTargetMap.set(targetKey, {
        targetKey,
        targetLabel: item?.targetLabel || item?.categoryLabel || targetKey,
        targetCount: 0,
        sizeBytes: 0,
      });
    }
    const targetRow = byTargetMap.get(targetKey);
    targetRow.targetCount += 1;
    targetRow.sizeBytes += sizeBytes;

    const accountKey = String(item?.accountId || 'global');
    if (!byAccountMap.has(accountKey)) {
      byAccountMap.set(accountKey, {
        accountId: item?.accountId || null,
        accountShortId: item?.accountShortId || (item?.accountId ? '-' : '全局'),
        userName: item?.userName || '-',
        corpName: item?.corpName || '-',
        targetCount: 0,
        sizeBytes: 0,
      });
    }
    const accountRow = byAccountMap.get(accountKey);
    accountRow.targetCount += 1;
    accountRow.sizeBytes += sizeBytes;

    const rootPath = item?.path ? path.dirname(path.resolve(item.path)) : null;
    const rootKey = rootPath || '(unknown)';
    if (!byRootMap.has(rootKey)) {
      byRootMap.set(rootKey, {
        rootPath: rootPath || null,
        rootType: item?.isExternalStorage ? 'external' : 'profile',
        targetCount: 0,
        sizeBytes: 0,
      });
    }
    const rootRow = byRootMap.get(rootKey);
    rootRow.targetCount += 1;
    rootRow.sizeBytes += sizeBytes;

    pushTopTargetRow(
      topPaths,
      {
        path: item?.path || null,
        sizeBytes,
        targetKey,
        targetLabel: item?.targetLabel || item?.categoryLabel || targetKey,
        tier: tierKey,
        tierLabel: governanceTierLabel(tierKey),
        accountShortId: item?.accountShortId || '-',
        suggested: Boolean(item?.suggested),
        recentlyActive: Boolean(item?.recentlyActive),
      },
      topPathLimit
    );
  }

  const byBytesDesc = (a, b) => {
    const bytesDiff = Number(b.sizeBytes || 0) - Number(a.sizeBytes || 0);
    if (bytesDiff !== 0) {
      return bytesDiff;
    }
    return Number(b.targetCount || 0) - Number(a.targetCount || 0);
  };

  return {
    totalTargets: Array.isArray(targets) ? targets.length : 0,
    totalBytes,
    byTier: [...byTierMap.values()].sort((a, b) => governanceTierRank(a.tier) - governanceTierRank(b.tier)),
    byTargetType: [...byTargetMap.values()].sort(byBytesDesc),
    byAccount: [...byAccountMap.values()].sort(byBytesDesc),
    byRoot: [...byRootMap.values()].sort(byBytesDesc),
    topPaths,
  };
}

function buildRestoreBatchTargetReport(entries, { topPathLimit = 20 } = {}) {
  const sourceEntries = Array.isArray(entries) ? entries : [];
  const byScopeMap = new Map();
  const byCategoryMap = new Map();
  const byMonthMap = new Map();
  const byAccountMap = new Map();
  const byRootMap = new Map();
  const topEntries = [];
  const monthSet = new Set();
  let totalBytes = 0;

  for (const entry of sourceEntries) {
    const sizeBytes = Number(entry?.sizeBytes || 0);
    totalBytes += sizeBytes;

    const scope = String(entry?.scope || MODES.CLEANUP_MONTHLY);
    if (!byScopeMap.has(scope)) {
      byScopeMap.set(scope, {
        scope,
        targetCount: 0,
        sizeBytes: 0,
      });
    }
    const scopeRow = byScopeMap.get(scope);
    scopeRow.targetCount += 1;
    scopeRow.sizeBytes += sizeBytes;

    const categoryKey = String(entry?.categoryKey || entry?.targetKey || 'unknown');
    if (!byCategoryMap.has(categoryKey)) {
      byCategoryMap.set(categoryKey, {
        categoryKey,
        categoryLabel: entry?.categoryLabel || categoryKey,
        targetCount: 0,
        sizeBytes: 0,
      });
    }
    const categoryRow = byCategoryMap.get(categoryKey);
    categoryRow.targetCount += 1;
    categoryRow.sizeBytes += sizeBytes;

    const monthKey = String(entry?.monthKey || '非月份目录');
    if (monthKey !== '非月份目录') {
      monthSet.add(monthKey);
    }
    if (!byMonthMap.has(monthKey)) {
      byMonthMap.set(monthKey, {
        monthKey,
        targetCount: 0,
        sizeBytes: 0,
      });
    }
    const monthRow = byMonthMap.get(monthKey);
    monthRow.targetCount += 1;
    monthRow.sizeBytes += sizeBytes;

    const accountKey = String(entry?.accountId || 'unknown');
    if (!byAccountMap.has(accountKey)) {
      byAccountMap.set(accountKey, {
        accountId: entry?.accountId || null,
        accountShortId: entry?.accountShortId || '-',
        userName: entry?.userName || '-',
        corpName: entry?.corpName || '-',
        targetCount: 0,
        sizeBytes: 0,
      });
    }
    const accountRow = byAccountMap.get(accountKey);
    accountRow.targetCount += 1;
    accountRow.sizeBytes += sizeBytes;

    const sourcePath = String(entry?.sourcePath || '').trim();
    const rootPath = sourcePath ? path.dirname(path.resolve(sourcePath)) : null;
    const rootKey = rootPath || '(unknown)';
    if (!byRootMap.has(rootKey)) {
      byRootMap.set(rootKey, {
        rootPath: rootPath || null,
        targetCount: 0,
        sizeBytes: 0,
      });
    }
    const rootRow = byRootMap.get(rootKey);
    rootRow.targetCount += 1;
    rootRow.sizeBytes += sizeBytes;

    pushTopTargetRow(
      topEntries,
      {
        sourcePath: sourcePath || null,
        recyclePath: entry?.recyclePath || null,
        sizeBytes,
        scope,
        categoryKey,
        categoryLabel: entry?.categoryLabel || categoryKey,
        monthKey: entry?.monthKey || null,
        accountShortId: entry?.accountShortId || '-',
      },
      topPathLimit
    );
  }

  const monthRange =
    monthSet.size > 0
      ? (() => {
          const months = [...monthSet].sort((a, b) => compareMonthKey(a, b));
          return { from: months[0], to: months[months.length - 1] };
        })()
      : null;

  const byBytesDesc = (a, b) => {
    const bytesDiff = Number(b.sizeBytes || 0) - Number(a.sizeBytes || 0);
    if (bytesDiff !== 0) {
      return bytesDiff;
    }
    return Number(b.targetCount || 0) - Number(a.targetCount || 0);
  };

  const monthRows = [...byMonthMap.values()].sort((a, b) => {
    const aMonth = String(a.monthKey || '非月份目录');
    const bMonth = String(b.monthKey || '非月份目录');
    if (aMonth === '非月份目录' && bMonth !== '非月份目录') {
      return 1;
    }
    if (aMonth !== '非月份目录' && bMonth === '非月份目录') {
      return -1;
    }
    if (aMonth === bMonth) {
      return Number(b.sizeBytes || 0) - Number(a.sizeBytes || 0);
    }
    return compareMonthKey(aMonth, bMonth);
  });

  return {
    totalEntries: sourceEntries.length,
    totalBytes,
    monthRange,
    byScope: [...byScopeMap.values()].sort(byBytesDesc),
    byCategory: [...byCategoryMap.values()].sort(byBytesDesc),
    byMonth: monthRows,
    byAccount: [...byAccountMap.values()].sort(byBytesDesc),
    byRoot: [...byRootMap.values()].sort(byBytesDesc),
    topEntries,
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

function normalizeRunTaskMode(rawMode) {
  const value = String(rawMode || '')
    .trim()
    .toLowerCase();
  if (!value) {
    return null;
  }
  if (!RUN_TASK_MODES.has(value)) {
    throw new UsageError(`参数 --run-task 的值无效: ${rawMode}`);
  }
  return value;
}

function normalizeScanDebugLevel(rawLevel) {
  const value = String(rawLevel || SCAN_DEBUG_OFF)
    .trim()
    .toLowerCase();
  if (!value) {
    return SCAN_DEBUG_OFF;
  }
  if (!SCAN_DEBUG_LEVELS.has(value)) {
    throw new UsageError(`参数 --scan-debug 的值无效: ${rawLevel}`);
  }
  return value;
}

function isDestructiveAction(action) {
  return DESTRUCTIVE_ACTIONS.has(action);
}

function shouldAttachScanDebug(cliArgs) {
  return normalizeScanDebugLevel(cliArgs?.scanDebug) !== SCAN_DEBUG_OFF;
}

function attachScanDebugData(baseData, cliArgs, summaryPayload, fullPayload = {}) {
  const level = normalizeScanDebugLevel(cliArgs?.scanDebug);
  if (level === SCAN_DEBUG_OFF) {
    return baseData || {};
  }
  const summary = summaryPayload && typeof summaryPayload === 'object' ? summaryPayload : {};
  const full = fullPayload && typeof fullPayload === 'object' ? fullPayload : {};
  return {
    ...(baseData || {}),
    scanDebug: {
      level,
      summary,
      ...(level === SCAN_DEBUG_FULL ? { full } : {}),
      generatedAt: Date.now(),
    },
  };
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
  if (action === MODES.CHECK_UPDATE) {
    return '--check-update';
  }
  if (action === MODES.UPGRADE) {
    return '--upgrade <npm|github-script>';
  }
  if (action === MODES.SYNC_SKILLS) {
    return '--sync-skills';
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
        '--cleanup-monthly | --analysis-only | --space-governance | --restore-batch <batchId> | --recycle-maintain | --doctor | --check-update | --upgrade <npm|github-script> | --sync-skills',
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
    '  --check-update',
    '  --upgrade <npm|github-script>',
    '  --sync-skills',
    '',
    '常用选项：',
    '  --output json|text',
    '  --dry-run true|false',
    '  --yes',
    '  --run-task preview|execute|preview-execute-verify',
    '  --scan-debug off|summary|full',
    '  --accounts all|current|id1,id2',
    '  --months YYYY-MM,YYYY-MM',
    '  --cutoff-month YYYY-MM',
    '  --categories key1,key2',
    '  --upgrade-version x.y.z',
    '  --upgrade-channel stable|pre',
    '  --upgrade-yes',
    '  --upgrade-sync-skills true|false',
    '  --skill-sync-method npm|github-script',
    '  --skill-sync-ref x.y.z',
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
    '  wecom-cleaner --cleanup-monthly --cutoff-month 2024-04 --accounts all --run-task preview-execute-verify --yes',
    '  wecom-cleaner --cleanup-monthly --accounts all --cutoff-month 2024-04 --dry-run false --yes',
    '  wecom-cleaner --sync-skills --skill-sync-method npm',
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
    if (cliArgs.action === MODES.UPGRADE) {
      throw new UsageError('参数 --upgrade 仅支持无交互模式，请移除 --interactive 后重试。');
    }
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
  const excludedAuto = detectedRoots.filter(
    (rootPath) => (rootSources[rootPath] || 'auto') === 'auto' && !sourceAllowSet.has('auto')
  );
  if (excludedAuto.length > 0) {
    warnings.push(
      `检测到 ${excludedAuto.length} 个自动探测文件存储目录未纳入本次扫描；如需纳入，请添加参数 --external-roots-source all。`
    );
  }
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

function summarizeDimensionRows(rows, { labelKey = 'label', countKey = 'targetCount' } = {}, limit = 20) {
  const list = Array.isArray(rows) ? rows : [];
  return list.slice(0, limit).map((row) => ({
    label:
      row?.[labelKey] ||
      row?.categoryLabel ||
      row?.targetLabel ||
      row?.monthKey ||
      row?.rootPath ||
      row?.accountShortId ||
      '-',
    count: Number(row?.[countKey] || row?.count || 0),
    sizeBytes: Number(row?.sizeBytes || 0),
  }));
}

function summarizeRootSamplesForNote(roots, limit = 2) {
  const list = uniqueStrings(Array.isArray(roots) ? roots : []);
  if (list.length === 0) {
    return '-';
  }
  const shown = list
    .slice(0, limit)
    .map((item) => trimToWidth(item, 68))
    .join('；');
  return list.length > limit ? `${shown}（其余 ${list.length - limit} 个省略）` : shown;
}

function buildActionScopeNotes(action, result) {
  const summary = result?.summary || {};
  const data = result?.data || {};
  const notes = [];
  const selectedExternalRoots = uniqueStrings(data.selectedExternalRoots || []);
  const scanActions = new Set([
    MODES.CLEANUP_MONTHLY,
    MODES.ANALYSIS_ONLY,
    MODES.SPACE_GOVERNANCE,
    MODES.RESTORE,
  ]);

  if (scanActions.has(action)) {
    if (selectedExternalRoots.length === 0) {
      notes.push('本次未纳入企业微信“文件存储位置”目录，统计结果可能明显小于磁盘实际占用。');
    } else {
      notes.push(
        `本次已纳入 ${selectedExternalRoots.length} 个文件存储目录（示例：${summarizeRootSamplesForNote(selectedExternalRoots)}）。`
      );
    }
  }

  if (action === MODES.CLEANUP_MONTHLY) {
    if (summary.cutoffMonth) {
      notes.push(`时间筛选使用“截至 ${summary.cutoffMonth}（含）”。`);
    }
    if (summary.noTarget) {
      notes.push('当前筛选命中为 0，已按安全策略跳过真实删除。');
    }
  }

  if (action === MODES.ANALYSIS_ONLY) {
    if (Number(summary.targetCount || 0) === 0) {
      notes.push('当前筛选范围未发现缓存目录，可检查账号、类别或文件存储路径设置。');
    }
  }

  if (action === MODES.SPACE_GOVERNANCE && Number(summary.matchedTargets || 0) === 0) {
    notes.push('当前治理筛选命中为 0，本次未执行任何删除。');
  }

  if (action === MODES.RESTORE) {
    if (result?.dryRun) {
      notes.push('本次为恢复预演，不会写回任何原路径。');
    }
  }

  if (action === MODES.SYNC_SKILLS) {
    const method = result?.summary?.method || 'npm';
    notes.push(`本次仅处理 Agent Skills 目录，不会扫描或清理企业微信缓存。`);
    notes.push(`同步方式：${skillSyncMethodLabel(method)}。`);
  }

  return uniqueStrings(notes);
}

function deriveUpdateSourceChain(summary = {}, updateData = {}) {
  const source = String(summary.source || updateData.sourceUsed || 'none');
  const errors = Array.isArray(updateData.errors) ? updateData.errors : [];
  const hasNpmFallback = errors.some((item) => String(item).includes('npm检查失败'));
  const hasGithubFallback = errors.some((item) => String(item).includes('github检查失败'));

  if (source === 'npm') {
    return '已通过 npmjs 获取版本信息。';
  }
  if (source === 'github') {
    return hasNpmFallback ? 'npmjs 请求失败，已自动回退到 GitHub。' : '已通过 GitHub 获取版本信息。';
  }
  if (source === 'none') {
    if (hasNpmFallback || hasGithubFallback) {
      return 'npmjs 与 GitHub 均未获取成功。';
    }
    return '本次未获取到可用更新来源。';
  }
  return source;
}

function collectUpdateFallbackWarnings(updateData) {
  if (!updateData || updateData.checked !== true) {
    return [];
  }
  const errors = Array.isArray(updateData.errors) ? updateData.errors : [];
  return errors.map((message) => `更新检查回退：${message}`);
}

function normalizeSkillSyncMethod(rawMethod) {
  const value = String(rawMethod || '')
    .trim()
    .toLowerCase();
  if (value === 'github-script') {
    return 'github-script';
  }
  return 'npm';
}

function skillSyncMethodLabel(method) {
  return normalizeSkillSyncMethod(method) === 'github-script' ? 'GitHub 脚本' : 'npm';
}

function summarizeSkillBinding(skillBinding) {
  const binding = skillBinding && typeof skillBinding === 'object' ? skillBinding : {};
  return {
    status: String(binding.status || 'unknown'),
    statusLabel: skillBindingStatusLabel(binding.status),
    matched: Boolean(binding.matched),
    installed: Boolean(binding.installed),
    expectedAppVersion: binding.expectedAppVersion || '',
    installedSkillVersion: binding.installedManifest?.skillVersion || null,
    installedRequiredAppVersion: binding.installedManifest?.requiredAppVersion || null,
    recommendation: binding.recommendation || '',
    targetSkillDir: binding.targetSkillDir || '',
  };
}

function collectSkillBindingWarnings(skillBinding) {
  const summary = summarizeSkillBinding(skillBinding);
  if (summary.matched) {
    return [];
  }
  const warnings = [];
  if (summary.status === 'not_installed') {
    warnings.push('未检测到 Agent Skills，请执行 wecom-cleaner-skill install 安装。');
  } else if (summary.status === 'legacy_unversioned') {
    warnings.push('检测到旧版 skills（缺少版本文件），建议执行 wecom-cleaner-skill install --force。');
  } else if (summary.status === 'mismatch') {
    warnings.push(
      `skills 与主程序版本不匹配：skills 绑定 ${summary.installedRequiredAppVersion || '-'}，当前程序 ${summary.expectedAppVersion || '-'}。`
    );
  } else if (summary.status === 'invalid_skill_dir') {
    warnings.push('skills 安装目录异常，请执行 wecom-cleaner-skill install --force 修复。');
  } else {
    warnings.push(`skills 状态异常：${summary.statusLabel}。`);
  }
  if (summary.recommendation) {
    warnings.push(summary.recommendation);
  }
  return uniqueStrings(warnings);
}

async function inspectSkillBindingSafe(context, appVersion = '') {
  try {
    return await inspectSkillBinding({
      appVersion: appVersion || context?.appMeta?.version || '',
      targetRoot: process.env.WECOM_CLEANER_SKILLS_ROOT || '',
    });
  } catch (error) {
    return {
      status: 'invalid_skill_dir',
      matched: false,
      installed: false,
      expectedAppVersion: appVersion || context?.appMeta?.version || '',
      installedManifest: null,
      recommendation: `skills 检测失败：${error instanceof Error ? error.message : String(error)}`,
      targetSkillDir: '',
    };
  }
}

function buildUserFacingSummary(action, result) {
  const summary = result?.summary || {};
  const report = result?.data?.report || {};
  const matched = report?.matched || {};

  if (action === MODES.CLEANUP_MONTHLY) {
    return {
      scopeNotes: buildActionScopeNotes(action, result),
      scope: {
        accountCount: Number(summary.accountCount || 0),
        monthCount: Number(summary.monthCount || 0),
        categoryCount: Number(summary.categoryCount || 0),
        rootPathCount: Number(summary.rootPathCount || 0),
        cutoffMonth: summary.cutoffMonth || null,
        monthRange: {
          from: summary.matchedMonthStart || matched?.monthRange?.from || null,
          to: summary.matchedMonthEnd || matched?.monthRange?.to || null,
        },
      },
      result: {
        noTarget: Boolean(summary.noTarget),
        matchedTargets: Number(summary.matchedTargets || 0),
        matchedBytes: Number(summary.matchedBytes || 0),
        reclaimedBytes: Number(summary.reclaimedBytes || 0),
        successCount: Number(summary.successCount || 0),
        skippedCount: Number(summary.skippedCount || 0),
        failedCount: Number(summary.failedCount || 0),
        batchId: summary.batchId || null,
      },
      byMonth: summarizeDimensionRows(matched.monthStats, { labelKey: 'monthKey' }),
      byCategory: summarizeDimensionRows(matched.categoryStats, { labelKey: 'categoryLabel' }),
      byRoot: summarizeDimensionRows(matched.rootStats, { labelKey: 'rootPath' }),
    };
  }

  if (action === MODES.ANALYSIS_ONLY) {
    return {
      scopeNotes: buildActionScopeNotes(action, result),
      scope: {
        accountCount: Number(summary.accountCount || 0),
        matchedAccountCount: Number(summary.matchedAccountCount || 0),
        categoryCount: Number(summary.categoryCount || 0),
        monthBucketCount: Number(summary.monthBucketCount || 0),
      },
      result: {
        targetCount: Number(summary.targetCount || 0),
        totalBytes: Number(summary.totalBytes || 0),
      },
      byMonth: summarizeDimensionRows(matched.monthStats, { labelKey: 'monthKey' }),
      byCategory: summarizeDimensionRows(matched.categoryStats, { labelKey: 'categoryLabel' }),
      byRoot: summarizeDimensionRows(matched.rootStats, { labelKey: 'rootPath' }),
    };
  }

  if (action === MODES.SPACE_GOVERNANCE) {
    return {
      scopeNotes: buildActionScopeNotes(action, result),
      scope: {
        accountCount: Number(summary.accountCount || 0),
        tierCount: Number(summary.tierCount || 0),
        targetTypeCount: Number(summary.targetTypeCount || 0),
        rootPathCount: Number(summary.rootPathCount || 0),
      },
      result: {
        noTarget: Boolean(summary.noTarget),
        matchedTargets: Number(summary.matchedTargets || 0),
        matchedBytes: Number(summary.matchedBytes || 0),
        reclaimedBytes: Number(summary.reclaimedBytes || 0),
        successCount: Number(summary.successCount || 0),
        skippedCount: Number(summary.skippedCount || 0),
        failedCount: Number(summary.failedCount || 0),
        batchId: summary.batchId || null,
      },
      byTier: summarizeDimensionRows(matched.byTier, { labelKey: 'tierLabel' }),
      byCategory: summarizeDimensionRows(matched.byTargetType, { labelKey: 'targetLabel' }),
      byRoot: summarizeDimensionRows(matched.byRoot, { labelKey: 'rootPath' }),
    };
  }

  if (action === MODES.RESTORE) {
    return {
      scopeNotes: buildActionScopeNotes(action, result),
      scope: {
        entryCount: Number(summary.entryCount || 0),
        conflictStrategy: summary.conflictStrategy || null,
        rootPathCount: Number(summary.rootPathCount || 0),
      },
      result: {
        batchId: summary.batchId || null,
        matchedBytes: Number(summary.matchedBytes || 0),
        restoredBytes: Number(summary.restoredBytes || 0),
        successCount: Number(summary.successCount || 0),
        skippedCount: Number(summary.skippedCount || 0),
        failedCount: Number(summary.failedCount || 0),
      },
      byMonth: summarizeDimensionRows(matched.byMonth, { labelKey: 'monthKey' }),
      byCategory: summarizeDimensionRows(matched.byCategory, { labelKey: 'categoryLabel' }),
      byRoot: summarizeDimensionRows(matched.byRoot, { labelKey: 'rootPath' }),
    };
  }

  if (action === MODES.RECYCLE_MAINTAIN) {
    return {
      scopeNotes: buildActionScopeNotes(action, result),
      scope: {
        candidateCount: Number(summary.candidateCount || 0),
        selectedByAge: Number(summary.selectedByAge || 0),
        selectedBySize: Number(summary.selectedBySize || 0),
      },
      result: {
        status: summary.status || null,
        deletedBatches: Number(summary.deletedBatches || 0),
        deletedBytes: Number(summary.deletedBytes || 0),
        failedBatches: Number(summary.failedBatches || 0),
        remainingBatches: Number(summary.remainingBatches || 0),
        remainingBytes: Number(summary.remainingBytes || 0),
      },
    };
  }

  if (action === MODES.DOCTOR) {
    return {
      scopeNotes: buildActionScopeNotes(action, result),
      scope: {
        platform: result?.data?.runtime?.targetTag || null,
      },
      result: {
        overall: summary.overall || null,
        pass: Number(summary.pass || 0),
        warn: Number(summary.warn || 0),
        fail: Number(summary.fail || 0),
      },
    };
  }

  if (action === MODES.CHECK_UPDATE) {
    const update = result?.data?.update || {};
    const skills = summarizeSkillBinding(result?.data?.skills || {});
    const scopeNotes = [
      deriveUpdateSourceChain(summary, update),
      summary.hasUpdate
        ? '检测到新版本后，仍需你手动确认才会执行升级。'
        : '本次仅执行检查，不会改动本机安装。',
    ];
    if (!skills.matched) {
      scopeNotes.push(`skills 状态：${skills.statusLabel}，建议同步后再让 Agent 执行任务。`);
    }
    return {
      scopeNotes: uniqueStrings(scopeNotes),
      result: {
        checked: Boolean(summary.checked),
        hasUpdate: Boolean(summary.hasUpdate),
        currentVersion: summary.currentVersion || null,
        latestVersion: summary.latestVersion || null,
        source: summary.source || null,
        sourceChain: summary.sourceChain || deriveUpdateSourceChain(summary, update),
        channel: summary.channel || null,
        skillsStatus: skills.status,
        skillsMatched: skills.matched,
        skillsInstalledVersion: skills.installedSkillVersion,
        skillsBoundAppVersion: skills.installedRequiredAppVersion,
      },
    };
  }

  if (action === MODES.UPGRADE) {
    const skillSync = result?.data?.skillSync || {};
    return {
      scopeNotes: buildActionScopeNotes(action, result),
      result: {
        executed: Boolean(summary.executed),
        method: summary.method || null,
        targetVersion: summary.targetVersion || null,
        status: hasDisplayValue(summary.status) ? Number(summary.status) : null,
        skillSyncStatus: summary.skillSyncStatus || null,
        skillSyncMethod: summary.skillSyncMethod || null,
        skillSyncTargetVersion: summary.skillSyncTargetVersion || null,
        skillSyncCommand: skillSync.command || null,
      },
    };
  }

  if (action === MODES.SYNC_SKILLS) {
    return {
      scopeNotes: buildActionScopeNotes(action, result),
      result: {
        method: summary.method || null,
        dryRun: Boolean(summary.dryRun),
        status: summary.status || null,
        skillsStatusBefore: summary.skillsStatusBefore || null,
        skillsStatusAfter: summary.skillsStatusAfter || null,
      },
    };
  }

  return {
    scopeNotes: buildActionScopeNotes(action, result),
    result: summary,
  };
}

const ACTION_DISPLAY_NAMES = new Map([
  [MODES.CLEANUP_MONTHLY, '年月清理'],
  [MODES.ANALYSIS_ONLY, '会话分析（只读）'],
  [MODES.SPACE_GOVERNANCE, '全量空间治理'],
  [MODES.RESTORE, '恢复已删除批次'],
  [MODES.RECYCLE_MAINTAIN, '回收区治理'],
  [MODES.DOCTOR, '系统自检'],
  [MODES.CHECK_UPDATE, '检查更新'],
  [MODES.UPGRADE, '程序升级'],
  [MODES.SYNC_SKILLS, '同步 Agent Skills'],
]);

const CONFLICT_STRATEGY_DISPLAY = new Map([
  ['skip', '跳过冲突项'],
  ['overwrite', '覆盖目标路径'],
  ['rename', '自动重命名后恢复'],
]);

function actionDisplayName(action) {
  return ACTION_DISPLAY_NAMES.get(action) || String(action || '-');
}

function hasDisplayValue(value) {
  return !(value === undefined || value === null || value === '');
}

function formatCount(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num.toLocaleString('zh-CN') : String(value || 0);
}

function formatBytesSafe(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? formatBytes(num) : '-';
}

function formatDuration(value) {
  const ms = Number(value || 0);
  if (!Number.isFinite(ms) || ms < 0) {
    return '-';
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatEngineLabel(engine) {
  const key = String(engine || '').toLowerCase();
  if (key === 'zig') {
    return 'Zig 核心';
  }
  if (key === 'zig_ready') {
    return 'Zig 已就绪（本次未实际使用）';
  }
  if (key === 'node') {
    return 'Node 引擎';
  }
  return key || '-';
}

function formatYesNo(value) {
  return value ? '是' : '否';
}

function categoryLabelFromKey(categoryKey) {
  const matched = CACHE_CATEGORIES.find((item) => item.key === categoryKey);
  return matched?.label || categoryKey;
}

function formatCategoryList(categoryKeys, limit = 8) {
  const keys = Array.isArray(categoryKeys) ? categoryKeys : [];
  if (keys.length === 0) {
    return '未指定';
  }
  const labels = uniqueStrings(keys.map((item) => categoryLabelFromKey(item)));
  const shown = labels.slice(0, limit).join('、');
  if (labels.length > limit) {
    return `${shown}（其余 ${labels.length - limit} 类已省略）`;
  }
  return shown;
}

function formatAccountList(accountIds, limit = 6) {
  const ids = uniqueStrings(Array.isArray(accountIds) ? accountIds : []);
  if (ids.length === 0) {
    return '-';
  }
  if (ids.length <= limit) {
    return ids.join('、');
  }
  return `${ids.slice(0, limit).join('、')}（其余 ${ids.length - limit} 个已省略）`;
}

function formatMonthScope(selectedMonths, summary = {}, matched = null) {
  const months = uniqueStrings(Array.isArray(selectedMonths) ? selectedMonths : []).sort((a, b) =>
    compareMonthKey(a, b)
  );
  if (months.length > 0) {
    if (months.length === 1) {
      return `${months[0]}（共 1 个月）`;
    }
    return `${months[0]} ~ ${months[months.length - 1]}（共 ${months.length} 个月）`;
  }
  if (summary.cutoffMonth) {
    return `截至 ${summary.cutoffMonth}（含）`;
  }
  const from = matched?.monthRange?.from || summary.matchedMonthStart;
  const to = matched?.monthRange?.to || summary.matchedMonthEnd;
  if (from && to) {
    return `${from} ~ ${to}`;
  }
  return '未指定（按当前筛选规则）';
}

function formatRootScope(roots, maxSamples = 2) {
  const list = uniqueStrings(Array.isArray(roots) ? roots : []);
  if (list.length === 0) {
    return '未纳入外部文件存储目录';
  }
  const samples = list.slice(0, maxSamples).map((item) => trimToWidth(item, 72));
  return `${list.length} 个（示例：${samples.join('；')}）`;
}

function printTextRows(title, rows, options = {}) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const emptyText = options.emptyText || '无';
  printSection(title);
  if (list.length === 0) {
    console.log(`- ${emptyText}`);
    return;
  }
  for (const row of list) {
    if (typeof row === 'string') {
      console.log(`- ${row}`);
      continue;
    }
    const label = row.label || '-';
    const value = hasDisplayValue(row.value) ? row.value : '-';
    const note = row.note ? `（${row.note}）` : '';
    console.log(`- ${label}：${value}${note}`);
  }
}

function printTopRows(title, rows, renderLine, limit = 8, emptyText = '无') {
  const source = Array.isArray(rows) ? rows : [];
  printSection(title);
  if (source.length === 0) {
    console.log(`- ${emptyText}`);
    return;
  }
  const shown = source.slice(0, limit);
  shown.forEach((item) => {
    const line = renderLine(item);
    if (line) {
      console.log(`- ${line}`);
    }
  });
  if (source.length > limit) {
    console.log(`- 其余 ${source.length - limit} 项已省略`);
  }
}

function formatExecutedBreakdownLine(row, label) {
  const successText = `${formatCount(row?.successCount)} 项/${formatBytesSafe(row?.successBytes)}`;
  const skippedText = `${formatCount(row?.skippedCount)} 项`;
  const failedText = `${formatCount(row?.failedCount)} 项`;
  const dryRunText = `${formatCount(row?.dryRunCount)} 项/${formatBytesSafe(row?.dryRunBytes)}`;
  return `${label}：成功 ${successText}，跳过 ${skippedText}，失败 ${failedText}，预演 ${dryRunText}`;
}

function printRuntimeAndRisk(payload) {
  const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
  const errors = Array.isArray(payload.errors) ? payload.errors : [];
  if (warnings.length > 0) {
    printTextRows(
      '风险提示',
      warnings.map((item) => ({ label: '警告', value: item })),
      { emptyText: '无' }
    );
  }
  if (errors.length > 0) {
    printTextRows(
      '错误明细',
      errors.map((item) => ({
        label: item.code || 'UNKNOWN',
        value: `${item.message || 'unknown_error'}${item.path ? `（${trimToWidth(item.path, 72)}）` : ''}`,
      })),
      { emptyText: '无' }
    );
  }
  printTextRows('运行状态', [
    { label: '耗时', value: formatDuration(payload.meta?.durationMs), note: '本次任务处理总耗时' },
    { label: '引擎', value: formatEngineLabel(payload.meta?.engine) },
    { label: 'warnings', value: formatCount(warnings.length) },
    { label: 'errors', value: formatCount(errors.length) },
  ]);
}

function printScopeNotes(payload) {
  const userFacing = payload?.data?.userFacingSummary || {};
  const notes =
    Array.isArray(userFacing.scopeNotes) && userFacing.scopeNotes.length > 0
      ? uniqueStrings(userFacing.scopeNotes)
      : buildActionScopeNotes(payload?.action, payload);
  if (notes.length === 0) {
    return;
  }
  printTextRows(
    '扫描边界说明',
    notes.map((item) => ({ label: '说明', value: item }))
  );
}

function printCleanupTextResult(payload) {
  const summary = payload.summary || {};
  const data = payload.data || {};
  const matched = data.report?.matched || {};
  const executed = data.report?.executed || null;

  let conclusion = '任务完成。';
  if (summary.noTarget) {
    conclusion = '当前范围未发现可清理目录，已按安全策略结束（未执行真实删除）。';
  } else if (payload.dryRun) {
    conclusion = '已完成预演，本次未执行真实删除。';
  } else if (summary.failedCount > 0) {
    conclusion = '已执行真实清理，但存在失败项，建议查看错误明细。';
  } else {
    conclusion = '已执行真实清理，命中目录已移动到回收区。';
  }

  printTextRows('任务结论', [
    { label: '动作', value: actionDisplayName(payload.action) },
    { label: '结果', value: payload.ok ? '成功' : '部分失败' },
    {
      label: '执行方式',
      value: payload.dryRun ? '预演（dry-run）' : '真实清理（移动到回收区）',
      note: payload.dryRun ? '不会删除数据，仅预估结果' : '可按批次恢复',
    },
    { label: '结论', value: conclusion },
  ]);

  printTextRows('处理范围', [
    {
      label: '账号范围',
      value: `${formatCount(summary.accountCount)} 个（${formatAccountList(data.selectedAccounts)}）`,
    },
    { label: '时间范围', value: formatMonthScope(data.selectedMonths, summary, matched) },
    { label: '缓存类别', value: formatCategoryList(data.selectedCategories) },
    {
      label: '文件存储目录',
      value: formatRootScope(data.selectedExternalRoots),
      note: '包含用户在企微设置里修改的文件存储路径',
    },
    {
      label: '非月份目录',
      value: formatYesNo(data.includeNonMonthDirs),
      note: '是=会包含数字目录/临时目录等',
    },
  ]);
  printScopeNotes(payload);

  printTextRows('结果统计', [
    { label: '命中目录', value: `${formatCount(summary.matchedTargets)} 项`, note: '本次范围内可处理目标数' },
    { label: '命中体积', value: formatBytesSafe(summary.matchedBytes), note: '命中目录当前占用空间' },
    {
      label: payload.dryRun ? '预计可释放' : '实际已释放',
      value: formatBytesSafe(summary.reclaimedBytes),
      note: payload.dryRun ? '若执行真实清理，理论可回收空间' : '已移动到回收区的体积',
    },
    { label: '成功', value: `${formatCount(summary.successCount)} 项` },
    { label: '跳过', value: `${formatCount(summary.skippedCount)} 项` },
    { label: '失败', value: `${formatCount(summary.failedCount)} 项` },
    { label: '回收批次', value: summary.batchId || '-' },
  ]);

  printTopRows(
    '分类统计（按命中范围）',
    matched.categoryStats,
    (row) =>
      `${row.categoryLabel || row.categoryKey}：${formatCount(row.targetCount)} 项，${formatBytesSafe(row.sizeBytes)}`,
    10
  );
  printTopRows(
    '月份统计（按命中范围）',
    matched.monthStats,
    (row) =>
      `${row.monthKey || '非月份目录'}：${formatCount(row.targetCount)} 项，${formatBytesSafe(row.sizeBytes)}`,
    12
  );
  printTopRows(
    '目录统计（按命中范围）',
    matched.rootStats,
    (row) =>
      `${trimToWidth(row.rootPath || '-', 72)}：${formatCount(row.targetCount)} 项，${formatBytesSafe(row.sizeBytes)}`,
    8
  );

  if (executed) {
    printTopRows(
      payload.dryRun ? '预演分布（按类别）' : '执行分布（按类别）',
      executed.byCategory,
      (row) => formatExecutedBreakdownLine(row, row.categoryLabel || row.categoryKey || '-'),
      8
    );
    printTopRows(
      payload.dryRun ? '预演分布（按月份）' : '执行分布（按月份）',
      executed.byMonth,
      (row) => formatExecutedBreakdownLine(row, row.monthKey || '非月份目录'),
      10
    );
  }

  printRuntimeAndRisk(payload);
}

function printAnalysisTextResult(payload) {
  const summary = payload.summary || {};
  const data = payload.data || {};
  const matched = data.report?.matched || {};
  const range = matched.monthRange
    ? `${matched.monthRange.from} ~ ${matched.monthRange.to}`
    : '无月份目录（可能仅命中非月份目录）';

  printTextRows('任务结论', [
    { label: '动作', value: actionDisplayName(payload.action) },
    { label: '结果', value: '只读分析完成' },
    { label: '说明', value: '本次不会删除任何数据，仅统计分布与占用情况' },
  ]);

  printTextRows('处理范围', [
    {
      label: '账号范围',
      value: `${formatCount(summary.accountCount)} 个（实际命中 ${formatCount(summary.matchedAccountCount)} 个）`,
      note: '实际命中指本次统计中出现数据的账号',
    },
    { label: '缓存类别', value: formatCategoryList(data.selectedCategories) },
    { label: '文件存储目录', value: formatRootScope(data.selectedExternalRoots) },
    { label: '时间范围', value: range },
  ]);
  printScopeNotes(payload);

  printTextRows('结果统计', [
    { label: '命中目录', value: `${formatCount(summary.targetCount)} 项` },
    { label: '总占用', value: formatBytesSafe(summary.totalBytes) },
    { label: '类别数', value: `${formatCount(summary.categoryCount)} 类` },
    { label: '月份桶', value: `${formatCount(summary.monthBucketCount)} 个` },
  ]);

  printTopRows(
    '分类统计（按命中范围）',
    matched.categoryStats,
    (row) =>
      `${row.categoryLabel || row.categoryKey}：${formatCount(row.targetCount)} 项，${formatBytesSafe(row.sizeBytes)}`,
    10
  );
  printTopRows(
    '月份统计（按命中范围）',
    matched.monthStats,
    (row) =>
      `${row.monthKey || '非月份目录'}：${formatCount(row.targetCount)} 项，${formatBytesSafe(row.sizeBytes)}`,
    12
  );
  printTopRows(
    '目录统计（按命中范围）',
    matched.rootStats,
    (row) =>
      `${trimToWidth(row.rootPath || '-', 72)}：${formatCount(row.targetCount)} 项，${formatBytesSafe(row.sizeBytes)}`,
    8
  );
  printRuntimeAndRisk(payload);
}

function printSpaceGovernanceTextResult(payload) {
  const summary = payload.summary || {};
  const data = payload.data || {};
  const matched = data.report?.matched || {};
  const executed = data.report?.executed || null;

  let conclusion = '治理扫描完成。';
  if (summary.matchedTargets === 0) {
    conclusion = '当前范围未发现可治理目录。';
  } else if (payload.dryRun) {
    conclusion = '已完成治理预演，尚未执行真实清理。';
  } else if (summary.failedCount > 0) {
    conclusion = '治理已执行，但存在失败项，请查看错误明细。';
  } else {
    conclusion = '治理已执行，目标目录已移动到回收区。';
  }

  printTextRows('任务结论', [
    { label: '动作', value: actionDisplayName(payload.action) },
    { label: '结果', value: payload.ok ? '成功' : '部分失败' },
    { label: '执行方式', value: payload.dryRun ? '预演（dry-run）' : '真实治理（移动到回收区）' },
    { label: '结论', value: conclusion },
  ]);

  printTextRows('处理范围', [
    {
      label: '账号范围',
      value: `${formatCount(data.selectedAccounts?.length)} 个（${formatAccountList(data.selectedAccounts)}）`,
    },
    { label: '治理目标', value: `${formatCount(data.selectedTargetIds?.length)} 项` },
    { label: '文件存储目录', value: formatRootScope(data.selectedExternalRoots) },
    {
      label: '近期活跃目录',
      value: formatYesNo(summary.allowRecentActive),
      note: '否=会自动跳过近期活跃目标',
    },
  ]);
  printScopeNotes(payload);

  printTextRows('结果统计', [
    { label: '命中目录', value: `${formatCount(summary.matchedTargets)} 项` },
    { label: '命中体积', value: formatBytesSafe(summary.matchedBytes) },
    { label: payload.dryRun ? '预计可释放' : '实际已释放', value: formatBytesSafe(summary.reclaimedBytes) },
    { label: '成功', value: `${formatCount(summary.successCount)} 项` },
    { label: '跳过', value: `${formatCount(summary.skippedCount)} 项` },
    { label: '失败', value: `${formatCount(summary.failedCount)} 项` },
    { label: '回收批次', value: summary.batchId || '-' },
  ]);

  printTopRows(
    '分级统计（按命中范围）',
    matched.byTier,
    (row) =>
      `${row.tierLabel || row.tier}：${formatCount(row.targetCount)} 项，${formatBytesSafe(row.sizeBytes)}，建议项 ${formatCount(row.suggestedCount)}`,
    8
  );
  printTopRows(
    '目标类型统计（按命中范围）',
    matched.byTargetType,
    (row) =>
      `${row.targetLabel || row.targetKey}：${formatCount(row.targetCount)} 项，${formatBytesSafe(row.sizeBytes)}`,
    10
  );
  printTopRows(
    '目录统计（按命中范围）',
    matched.byRoot,
    (row) =>
      `${trimToWidth(row.rootPath || '-', 72)}：${formatCount(row.targetCount)} 项，${formatBytesSafe(row.sizeBytes)}`,
    8
  );

  if (executed) {
    printTopRows(
      payload.dryRun ? '预演分布（按类别）' : '执行分布（按类别）',
      executed.byCategory,
      (row) => formatExecutedBreakdownLine(row, row.categoryLabel || row.categoryKey || '-'),
      8
    );
  }

  printRuntimeAndRisk(payload);
}

function printRestoreTextResult(payload) {
  const summary = payload.summary || {};
  const data = payload.data || {};
  const matched = data.report?.matched || {};
  const executed = data.report?.executed || null;
  const conflictText =
    CONFLICT_STRATEGY_DISPLAY.get(summary.conflictStrategy) || summary.conflictStrategy || '-';

  let conclusion = '恢复任务完成。';
  if (payload.dryRun) {
    conclusion = '已完成恢复预演，尚未写回原路径。';
  } else if (summary.failedCount > 0) {
    conclusion = '恢复已执行，但存在失败项，请按错误明细复核。';
  } else {
    conclusion = '恢复已执行完成。';
  }

  printTextRows('任务结论', [
    { label: '动作', value: actionDisplayName(payload.action) },
    { label: '批次号', value: summary.batchId || '-' },
    { label: '执行方式', value: payload.dryRun ? '预演（dry-run）' : '真实恢复' },
    { label: '冲突策略', value: conflictText },
    { label: '结论', value: conclusion },
  ]);

  printTextRows('处理范围', [
    { label: '批次条目', value: `${formatCount(summary.entryCount)} 项` },
    { label: '匹配体积', value: formatBytesSafe(summary.matchedBytes) },
    { label: '作用域数', value: `${formatCount(summary.scopeCount)} 类` },
    { label: '文件存储目录', value: formatRootScope(data.selectedExternalRoots) },
  ]);
  printScopeNotes(payload);

  printTextRows('结果统计', [
    { label: '成功恢复', value: `${formatCount(summary.successCount)} 项` },
    { label: '跳过', value: `${formatCount(summary.skippedCount)} 项` },
    { label: '失败', value: `${formatCount(summary.failedCount)} 项` },
    {
      label: payload.dryRun ? '预计恢复体积' : '实际恢复体积',
      value: formatBytesSafe(summary.restoredBytes),
    },
  ]);

  printTopRows(
    '作用域统计（按批次命中）',
    matched.byScope,
    (row) =>
      `${actionDisplayName(row.scope)}：${formatCount(row.targetCount)} 项，${formatBytesSafe(row.sizeBytes)}`,
    8
  );
  printTopRows(
    '类别统计（按批次命中）',
    matched.byCategory,
    (row) =>
      `${row.categoryLabel || row.categoryKey}：${formatCount(row.targetCount)} 项，${formatBytesSafe(row.sizeBytes)}`,
    10
  );
  printTopRows(
    '月份统计（按批次命中）',
    matched.byMonth,
    (row) =>
      `${row.monthKey || '非月份目录'}：${formatCount(row.targetCount)} 项，${formatBytesSafe(row.sizeBytes)}`,
    10
  );

  if (executed) {
    printTopRows(
      payload.dryRun ? '预演分布（按作用域）' : '执行分布（按作用域）',
      executed.byScope,
      (row) => formatExecutedBreakdownLine(row, actionDisplayName(row.scope)),
      8
    );
  }

  printRuntimeAndRisk(payload);
}

const RECYCLE_STATUS_LABELS = new Map([
  ['success', '治理完成'],
  ['dry_run', '预演完成'],
  ['partial_failed', '部分失败'],
  ['skipped_disabled', '已跳过（策略关闭）'],
  ['skipped_no_candidate', '已跳过（无候选批次）'],
]);

function recycleStatusLabel(status) {
  return RECYCLE_STATUS_LABELS.get(status) || status || '-';
}

function printRecycleMaintainTextResult(payload) {
  const summary = payload.summary || {};
  const report = payload.data?.report || {};
  const policy = payload.data?.policy || {};
  const operations = Array.isArray(report.operations) ? report.operations : [];
  const operationStatus = operations.reduce((acc, item) => {
    const key = String(item?.status || 'unknown');
    acc.set(key, (acc.get(key) || 0) + 1);
    return acc;
  }, new Map());

  printTextRows('任务结论', [
    { label: '动作', value: actionDisplayName(payload.action) },
    { label: '状态', value: recycleStatusLabel(summary.status) },
    { label: '执行方式', value: payload.dryRun ? '预演（dry-run）' : '真实治理' },
    {
      label: '结论',
      value:
        summary.candidateCount > 0
          ? payload.dryRun
            ? '已完成预演，未实际删除回收批次。'
            : '已按保留策略处理回收区批次。'
          : '当前没有需要治理的回收批次。',
    },
  ]);

  printTextRows('处理范围', [
    { label: '候选批次', value: `${formatCount(summary.candidateCount)} 个` },
    { label: '按年龄选中', value: `${formatCount(summary.selectedByAge)} 个` },
    { label: '按容量选中', value: `${formatCount(summary.selectedBySize)} 个` },
    { label: '保留天数阈值', value: `${formatCount(policy.maxAgeDays)} 天` },
    { label: '最少保留批次', value: `${formatCount(policy.minKeepBatches)} 个` },
    { label: '容量阈值', value: `${formatCount(policy.sizeThresholdGB)} GB` },
  ]);

  printTextRows('结果统计', [
    {
      label: payload.dryRun ? '预计释放批次' : '已释放批次',
      value: `${formatCount(summary.deletedBatches)} 个`,
    },
    { label: payload.dryRun ? '预计释放空间' : '已释放空间', value: formatBytesSafe(summary.deletedBytes) },
    { label: '失败批次', value: `${formatCount(summary.failedBatches)} 个` },
    { label: '治理后批次数', value: `${formatCount(summary.remainingBatches)} 个` },
    { label: '治理后占用', value: formatBytesSafe(summary.remainingBytes) },
  ]);

  printTopRows(
    '操作分布',
    [...operationStatus.entries()].map(([status, count]) => ({ status, count })),
    (row) => `${row.status}：${formatCount(row.count)} 个批次`,
    10
  );

  printRuntimeAndRisk(payload);
}

function printDoctorTextResult(payload) {
  const summary = payload.summary || {};
  const checks = Array.isArray(payload.data?.checks) ? payload.data.checks : [];
  const failedChecks = checks.filter((item) => item.status === 'fail');
  const warningChecks = checks.filter((item) => item.status === 'warn');

  printTextRows('任务结论', [
    { label: '动作', value: actionDisplayName(payload.action) },
    { label: '总体状态', value: doctorStatusText(summary.overall) },
    {
      label: '结论',
      value:
        summary.fail > 0
          ? '存在失败项，建议先处理失败检查后再执行清理。'
          : summary.warn > 0
            ? '存在告警项，建议先处理高风险告警。'
            : '系统状态良好。',
    },
  ]);

  printTextRows('检查统计', [
    { label: '通过', value: `${formatCount(summary.pass)} 项` },
    { label: '警告', value: `${formatCount(summary.warn)} 项` },
    { label: '失败', value: `${formatCount(summary.fail)} 项` },
    { label: '平台', value: payload.data?.runtime?.targetTag || '-' },
  ]);

  printTopRows(
    '失败检查项',
    failedChecks,
    (item) => `${item.title}：${item.detail}${item.suggestion ? `（建议：${item.suggestion}）` : ''}`,
    8,
    '无'
  );
  printTopRows(
    '告警检查项',
    warningChecks,
    (item) => `${item.title}：${item.detail}${item.suggestion ? `（建议：${item.suggestion}）` : ''}`,
    8,
    '无'
  );

  printRuntimeAndRisk(payload);
}

function printCheckUpdateTextResult(payload) {
  const summary = payload.summary || {};
  const update = payload.data?.update || {};
  const skills = summarizeSkillBinding(payload.data?.skills || {});
  const sourceChain = summary.sourceChain || deriveUpdateSourceChain(summary, update);
  const conclusion = summary.hasUpdate
    ? `检测到新版本 v${summary.latestVersion}，可选择 npm 或 GitHub 脚本升级。`
    : summary.checked
      ? '当前已是最新版本。'
      : '本次更新检查失败，请稍后重试。';

  printTextRows('任务结论', [
    { label: '动作', value: actionDisplayName(payload.action) },
    { label: '结论', value: conclusion },
    { label: '状态', value: summary.checked ? '检查完成' : '检查失败' },
  ]);

  printTextRows('检查结果', [
    { label: '当前版本', value: summary.currentVersion || '-' },
    { label: '最新版本', value: summary.latestVersion || '-' },
    { label: '来源', value: summary.source || '-' },
    { label: '来源链路', value: sourceChain },
    { label: '通道', value: channelLabel(summary.channel) },
    { label: '跳过提醒', value: formatYesNo(Boolean(summary.skippedByUser)) },
    { label: '检查时间', value: formatLocalDate(update.checkedAt || Date.now()) },
  ]);
  printTextRows('Skills 状态', [
    { label: '匹配状态', value: skills.statusLabel },
    { label: '主程序版本', value: skills.expectedAppVersion || '-' },
    { label: 'skills 版本', value: skills.installedSkillVersion || '-' },
    { label: 'skills 绑定版本', value: skills.installedRequiredAppVersion || '-' },
    { label: '安装目录', value: skills.targetSkillDir || '-' },
  ]);
  if (!skills.matched) {
    printTextRows('Skills 建议', [
      { label: '建议命令', value: 'wecom-cleaner --sync-skills --skill-sync-method npm' },
      { label: '补充', value: skills.recommendation || '同步后再让 Agent 继续执行任务。' },
    ]);
  }
  if (summary.hasUpdate && !summary.skippedByUser) {
    printTextRows('升级建议', [
      {
        label: '默认方式',
        value: `wecom-cleaner --upgrade npm --upgrade-version ${summary.latestVersion} --upgrade-yes`,
      },
      {
        label: '备选方式',
        value: `wecom-cleaner --upgrade github-script --upgrade-version ${summary.latestVersion} --upgrade-yes`,
      },
    ]);
  }
  printScopeNotes(payload);

  printRuntimeAndRisk(payload);
}

function printUpgradeTextResult(payload) {
  const summary = payload.summary || {};
  const upgrade = payload.data?.upgrade || {};
  const skillSync = payload.data?.skillSync || {};
  const executed = Boolean(summary.executed);
  const appUpgradeSucceeded = executed && Number(summary.status || 1) === 0;
  const onlySkillSyncFailed = appUpgradeSucceeded && !payload.ok;
  const conclusion = !executed
    ? summary.reason === 'already_latest'
      ? '当前已是最新版本，无需执行升级。'
      : '升级前置检查失败，未执行升级。'
    : payload.ok
      ? '升级已执行成功，建议重启程序后继续使用。'
      : onlySkillSyncFailed
        ? '程序升级成功，但 skills 同步失败，请先修复后再让 Agent 继续执行任务。'
        : '升级执行失败，请按错误提示排查。';

  printTextRows('任务结论', [
    { label: '动作', value: actionDisplayName(payload.action) },
    { label: '结论', value: conclusion },
    { label: '升级方式', value: summary.method || '-' },
    { label: '目标版本', value: summary.targetVersion || '-' },
  ]);

  printTextRows('执行明细', [
    { label: '已执行升级', value: formatYesNo(executed) },
    { label: '退出码', value: hasDisplayValue(summary.status) ? summary.status : '-' },
    { label: '命令', value: summary.command || upgrade.command || '-' },
  ]);
  printTextRows('Skills 同步', [
    { label: '同步方式', value: summary.skillSyncMethod || '-' },
    { label: '同步状态', value: summary.skillSyncStatus || '-' },
    { label: '目标版本', value: summary.skillSyncTargetVersion || '-' },
    { label: '执行命令', value: skillSync.command || '-' },
  ]);
  if (payload.ok && executed) {
    printTextRows('下一步建议', [
      { label: '建议', value: '升级已完成，建议重新打开 wecom-cleaner 继续任务。' },
      { label: '说明', value: '本次升级仅更新程序与 Zig 核心，不会改动企业微信缓存数据。' },
    ]);
  }
  printScopeNotes(payload);

  printRuntimeAndRisk(payload);
}

function printSyncSkillsTextResult(payload) {
  const summary = payload.summary || {};
  const before = payload.data?.before || {};
  const after = payload.data?.after || {};
  const syncResult = payload.data?.skillSync || {};

  const conclusion = payload.ok
    ? summary.dryRun
      ? '已完成 skills 同步预演，未写入目标目录。'
      : 'skills 已同步完成。'
    : 'skills 同步失败，请按错误信息排查。';

  printTextRows('任务结论', [
    { label: '动作', value: actionDisplayName(payload.action) },
    { label: '结论', value: conclusion },
    { label: '同步方式', value: skillSyncMethodLabel(summary.method || 'npm') },
    { label: '执行模式', value: summary.dryRun ? '预演（dry-run）' : '真实同步' },
  ]);

  printTextRows('同步前后', [
    { label: '同步前状态', value: before.statusLabel || '-' },
    { label: '同步后状态', value: after.statusLabel || '-' },
    { label: '主程序版本', value: after.expectedAppVersion || before.expectedAppVersion || '-' },
    { label: 'skills 版本', value: after.installedSkillVersion || before.installedSkillVersion || '-' },
    {
      label: 'skills 绑定版本',
      value: after.installedRequiredAppVersion || before.installedRequiredAppVersion || '-',
    },
    { label: '安装目录', value: after.targetSkillDir || before.targetSkillDir || '-' },
  ]);

  printTextRows('执行明细', [
    { label: '状态', value: summary.status || '-' },
    { label: '命令', value: syncResult.command || '-' },
    { label: '退出码', value: hasDisplayValue(syncResult.status) ? syncResult.status : '-' },
  ]);

  printScopeNotes(payload);
  printRuntimeAndRisk(payload);
}

function printGenericTextResult(payload) {
  printTextRows('任务结论', [
    { label: '动作', value: actionDisplayName(payload.action) },
    { label: '结果', value: payload.ok ? '成功' : '失败' },
  ]);
  const summaryRows = Object.entries(payload.summary || {}).map(([key, value]) => ({
    label: key,
    value: typeof value === 'object' ? JSON.stringify(value) : value,
  }));
  printTextRows('结果统计', summaryRows);
  printRuntimeAndRisk(payload);
}

function printTaskPhasesText(payload) {
  const phases = Array.isArray(payload?.data?.taskPhases) ? payload.data.taskPhases : [];
  if (phases.length === 0) {
    return;
  }
  printTextRows(
    '任务流程',
    phases.map((phase) => {
      const summaryText =
        phase.status === 'completed'
          ? `命中 ${formatCount(phase?.stats?.matchedTargets)} 项，成功 ${formatCount(phase?.stats?.successCount)} 项，失败 ${formatCount(phase?.stats?.failedCount)} 项，释放 ${formatBytesSafe(phase?.stats?.reclaimedBytes)}`
          : `已跳过（${phase.reason || '无'}）`;
      return {
        label: phase.name,
        value: `${phase.status}${phase.ok === false ? '（失败）' : ''}`,
        note: summaryText,
      };
    })
  );
  const taskCard = payload?.data?.taskCard;
  if (taskCard && typeof taskCard === 'object') {
    printTextRows('流程结论', [
      { label: '模式', value: taskCard.mode || '-' },
      { label: '决策', value: taskCard.decision || '-' },
      { label: '结论', value: taskCard.conclusion || '-' },
    ]);
  }
}

function printNonInteractiveTextResult(payload) {
  printTaskPhasesText(payload);
  if (payload.action === MODES.CLEANUP_MONTHLY) {
    printCleanupTextResult(payload);
    return;
  }
  if (payload.action === MODES.ANALYSIS_ONLY) {
    printAnalysisTextResult(payload);
    return;
  }
  if (payload.action === MODES.SPACE_GOVERNANCE) {
    printSpaceGovernanceTextResult(payload);
    return;
  }
  if (payload.action === MODES.RESTORE) {
    printRestoreTextResult(payload);
    return;
  }
  if (payload.action === MODES.RECYCLE_MAINTAIN) {
    printRecycleMaintainTextResult(payload);
    return;
  }
  if (payload.action === MODES.DOCTOR) {
    printDoctorTextResult(payload);
    return;
  }
  if (payload.action === MODES.CHECK_UPDATE) {
    printCheckUpdateTextResult(payload);
    return;
  }
  if (payload.action === MODES.UPGRADE) {
    printUpgradeTextResult(payload);
    return;
  }
  if (payload.action === MODES.SYNC_SKILLS) {
    printSyncSkillsTextResult(payload);
    return;
  }
  printGenericTextResult(payload);
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
    defaultSources: ['all'],
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
  const cleanupScopeSummary = {
    accountCount: accountResolved.selectedAccountIds.length,
    monthCount: monthFilters.length,
    categoryCount: categoryKeys.length,
    externalRootCount: externalResolved.roots.length,
    cutoffMonth: cliArgs.cutoffMonth || null,
    explicitMonthCount: Array.isArray(cliArgs.months) ? cliArgs.months.length : 0,
  };

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
  const matchedBytes = targets.reduce((total, item) => total + Number(item?.sizeBytes || 0), 0);
  const matchedReport = buildCleanupTargetReport(targets, { topPathLimit: 20 });
  const scanDebugSummary = {
    action: MODES.CLEANUP_MONTHLY,
    engineReady: context.nativeCorePath ? 'zig' : 'node',
    engineUsed: scan.engineUsed || 'node',
    nativeFallbackReason: scan.nativeFallbackReason || null,
    selectedAccountCount: accountResolved.selectedAccountIds.length,
    availableMonthCount: availableMonths.length,
    selectedMonthCount: monthFilters.length,
    selectedCategoryCount: categoryKeys.length,
    selectedExternalRootCount: externalResolved.roots.length,
    includeNonMonthDirs,
    matchedTargets: targets.length,
    matchedBytes,
  };
  const scanDebugFull = {
    selectedAccounts: accountResolved.selectedAccountIds,
    selectedMonths: monthFilters,
    selectedCategories: categoryKeys,
    availableMonths,
    selectedExternalRoots: externalResolved.roots,
    externalDetectionMeta: detectedExternalStorage.meta || null,
    matchedTopPaths: matchedReport.topPaths || [],
    matchedCategoryStats: matchedReport.categoryStats || [],
    matchedMonthStats: matchedReport.monthStats || [],
    matchedRootStats: matchedReport.rootStats || [],
  };
  if (targets.length === 0) {
    return {
      ok: true,
      action: MODES.CLEANUP_MONTHLY,
      dryRun,
      summary: {
        batchId: null,
        hasWork: false,
        noTarget: true,
        matchedTargets: 0,
        matchedBytes: 0,
        reclaimedBytes: 0,
        successCount: 0,
        skippedCount: 0,
        failedCount: 0,
        engineUsed: scan.engineUsed || 'node',
        matchedMonthStart: null,
        matchedMonthEnd: null,
        rootPathCount: 0,
        ...cleanupScopeSummary,
      },
      warnings,
      errors: [],
      data: {
        selectedAccounts: accountResolved.selectedAccountIds,
        selectedMonths: monthFilters,
        selectedCategories: categoryKeys,
        selectedExternalRoots: externalResolved.roots,
        engineUsed: scan.engineUsed || 'node',
        report: {
          matched: matchedReport,
          executed: null,
        },
        ...attachScanDebugData({}, cliArgs, scanDebugSummary, scanDebugFull),
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
      hasWork: true,
      noTarget: false,
      matchedTargets: targets.length,
      matchedBytes,
      engineUsed: scan.engineUsed || 'node',
      matchedMonthStart: matchedReport.monthRange?.from || null,
      matchedMonthEnd: matchedReport.monthRange?.to || null,
      rootPathCount: matchedReport.rootStats.length,
      ...cleanupScopeSummary,
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
      report: {
        matched: matchedReport,
        executed: result.breakdown || null,
      },
      ...attachScanDebugData({}, cliArgs, scanDebugSummary, scanDebugFull),
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
    defaultSources: ['all'],
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
  const analysisReport = buildCleanupTargetReport(result.targets, { topPathLimit: 20 });
  const scanDebugSummary = {
    action: MODES.ANALYSIS_ONLY,
    engineReady: context.nativeCorePath ? 'zig' : 'node',
    engineUsed: result.engineUsed || 'node',
    nativeFallbackReason: result.nativeFallbackReason || null,
    selectedAccountCount: accountResolved.selectedAccountIds.length,
    selectedCategoryCount: categoryKeys.length,
    selectedExternalRootCount: externalResolved.roots.length,
    matchedTargets: result.targets.length,
    matchedBytes: result.totalBytes,
    matchedAccountCount: result.accountsSummary.length,
    monthBucketCount: result.monthsSummary.length,
  };
  const scanDebugFull = {
    selectedAccounts: accountResolved.selectedAccountIds,
    selectedCategories: categoryKeys,
    selectedExternalRoots: externalResolved.roots,
    externalDetectionMeta: detectedExternalStorage.meta || null,
    accountsSummary: result.accountsSummary,
    categoriesSummary: result.categoriesSummary,
    monthsSummary: result.monthsSummary,
    matchedTopPaths: analysisReport.topPaths || [],
  };

  return {
    ok: true,
    action: MODES.ANALYSIS_ONLY,
    dryRun: null,
    summary: {
      targetCount: result.targets.length,
      totalBytes: result.totalBytes,
      accountCount: accountResolved.selectedAccountIds.length,
      matchedAccountCount: result.accountsSummary.length,
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
      report: {
        matched: analysisReport,
      },
      ...attachScanDebugData({}, cliArgs, scanDebugSummary, scanDebugFull),
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
    defaultSources: ['all'],
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
  const matchedReport = buildGovernanceTargetReport(selectedTargets, { topPathLimit: 20 });
  const scanDebugSummary = {
    action: MODES.SPACE_GOVERNANCE,
    engineReady: context.nativeCorePath ? 'zig' : 'node',
    engineUsed: scan.engineUsed || 'node',
    nativeFallbackReason: scan.nativeFallbackReason || null,
    selectedAccountCount: accountResolved.selectedAccountIds.length,
    selectedExternalRootCount: externalResolved.roots.length,
    scannedTargets: scan.targets.length,
    selectableTargets: selectableTargets.length,
    selectedTargets: selectedTargets.length,
    selectedByCliTargets: selectedById.length,
    allowRecentActive,
    matchedBytes: matchedReport.totalBytes,
  };
  const scanDebugFull = {
    selectedAccounts: accountResolved.selectedAccountIds,
    selectedExternalRoots: externalResolved.roots,
    externalDetectionMeta: detectedExternalStorage.meta || null,
    tierFilters: tierFilterSet ? [...tierFilterSet] : [],
    cliSelectedTargets: selectedById,
    selectedTargetIds: selectedTargets.map((item) => item.id),
    matchedByTier: matchedReport.byTier || [],
    matchedByTargetType: matchedReport.byTargetType || [],
    matchedByRoot: matchedReport.byRoot || [],
    matchedTopPaths: matchedReport.topPaths || [],
    scanByTier: scan.byTier || [],
  };
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
        matchedBytes: 0,
        reclaimedBytes: 0,
        successCount: 0,
        skippedCount: 0,
        failedCount: 0,
        tierCount: 0,
        targetTypeCount: 0,
        rootPathCount: 0,
      },
      warnings,
      errors: [],
      data: {
        selectedAccounts: accountResolved.selectedAccountIds,
        selectedExternalRoots: externalResolved.roots,
        selectedTargetIds: [],
        engineUsed: scan.engineUsed || 'node',
        report: {
          matched: matchedReport,
          executed: null,
        },
        ...attachScanDebugData({}, cliArgs, scanDebugSummary, scanDebugFull),
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
      matchedBytes: matchedReport.totalBytes,
      allowRecentActive,
      tierCount: matchedReport.byTier.length,
      targetTypeCount: matchedReport.byTargetType.length,
      rootPathCount: matchedReport.byRoot.length,
    }),
    warnings,
    errors: result.errors.map((item) => toStructuredError(item)),
    data: {
      selectedAccounts: accountResolved.selectedAccountIds,
      selectedExternalRoots: externalResolved.roots,
      selectedTargetIds: selectedTargets.map((item) => item.id),
      engineUsed: scan.engineUsed || 'node',
      report: {
        matched: matchedReport,
        executed: result.breakdown || null,
      },
      ...attachScanDebugData({}, cliArgs, scanDebugSummary, scanDebugFull),
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
  const matchedReport = buildRestoreBatchTargetReport(batch.entries, { topPathLimit: 20 });
  const scanDebugSummary = {
    action: MODES.RESTORE,
    selectedExternalRootCount: externalResolved.roots.length,
    governanceRoot: governanceRoot || null,
    batchEntryCount: batch.entries.length,
    matchedBytes: matchedReport.totalBytes,
    dryRun,
  };
  const scanDebugFull = {
    batchId: batch.batchId,
    conflictStrategy,
    selectedExternalRoots: externalResolved.roots,
    governanceAllowRoots: governanceAllowRoots,
    matchedByScope: matchedReport.byScope || [],
    matchedByCategory: matchedReport.byCategory || [],
    matchedByMonth: matchedReport.byMonth || [],
    matchedByRoot: matchedReport.byRoot || [],
    topEntries: matchedReport.topEntries || [],
  };

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
      entryCount: batch.entries.length,
      matchedBytes: matchedReport.totalBytes,
      scopeCount: matchedReport.byScope.length,
      categoryCount: matchedReport.byCategory.length,
      rootPathCount: matchedReport.byRoot.length,
    },
    warnings,
    errors: result.errors.map((item) => toStructuredError(item)),
    data: {
      selectedExternalRoots: externalResolved.roots,
      governanceRoot,
      report: {
        matched: matchedReport,
        executed: result.breakdown || null,
      },
      ...attachScanDebugData({}, cliArgs, scanDebugSummary, scanDebugFull),
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
  const scanDebugSummary = {
    action: MODES.RECYCLE_MAINTAIN,
    dryRun,
    candidateCount: result.candidateCount,
    selectedByAge: result.selectedByAge,
    selectedBySize: result.selectedBySize,
    deletedBatches: result.deletedBatches,
    deletedBytes: result.deletedBytes,
    failedBatches: result.failBatches,
  };
  const scanDebugFull = {
    policy,
    before: result.before || null,
    after: result.after || null,
    thresholdBytes: result.thresholdBytes,
    overThreshold: result.overThreshold,
    selectedCandidates: result.selectedCandidates || [],
    operations: result.operations || [],
  };

  return {
    ok: result.failBatches === 0,
    action: MODES.RECYCLE_MAINTAIN,
    dryRun,
    summary: {
      status: result.status,
      candidateCount: result.candidateCount,
      selectedByAge: result.selectedByAge,
      selectedBySize: result.selectedBySize,
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
      report: {
        before: result.before,
        after: result.after,
        thresholdBytes: result.thresholdBytes,
        overThreshold: result.overThreshold,
        selectedCandidates: result.selectedCandidates || [],
        operations: result.operations || [],
      },
      ...attachScanDebugData({}, cliArgs, scanDebugSummary, scanDebugFull),
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

function resolveUpdateChannel(cliArgs, config) {
  const fallback = normalizeSelfUpdateConfig(config?.selfUpdate).channel;
  return normalizeUpgradeChannel(cliArgs.upgradeChannel, fallback);
}

function buildUpdateData(result, skipVersion = '') {
  const data = result && typeof result === 'object' ? result : {};
  return {
    checked: Boolean(data.checked),
    currentVersion: data.currentVersion || '',
    latestVersion: data.latestVersion || null,
    hasUpdate: Boolean(data.hasUpdate),
    sourceUsed: data.sourceUsed || 'none',
    channel: data.channel || 'stable',
    checkReason: data.checkReason || 'manual',
    checkedAt: Number(data.checkedAt || Date.now()),
    skippedByUser: shouldSkipVersion(data, skipVersion),
    errors: Array.isArray(data.errors) ? data.errors : [],
    upgradeMethods: Array.isArray(data.upgradeMethods) ? data.upgradeMethods : ['npm', 'github-script'],
  };
}

async function persistSelfUpdateState(context) {
  if (context.readOnlyConfig) {
    return;
  }
  await saveConfig(context.config).catch(() => {});
}

function shouldSyncSkillsOnUpgrade(cliArgs) {
  if (typeof cliArgs?.upgradeSyncSkills === 'boolean') {
    return cliArgs.upgradeSyncSkills;
  }
  return true;
}

function buildLocalSkillInstallCommand(targetRoot = '') {
  const base = ['wecom-cleaner-skill', 'install', '--force'];
  if (targetRoot) {
    base.push('--target', targetRoot);
  }
  return base.join(' ');
}

async function executeSkillSync({
  context,
  method = 'npm',
  targetRoot = '',
  expectedAppVersion = '',
  requestedVersion = '',
  dryRun = false,
  useExternalCommand = false,
}) {
  const normalizedMethod = normalizeSkillSyncMethod(method);
  const expectedVersion = String(expectedAppVersion || context?.appMeta?.version || '').trim();
  const normalizedTargetRoot = String(targetRoot || process.env.WECOM_CLEANER_SKILLS_ROOT || '').trim();
  const beforeBinding = await inspectSkillBindingSafe(context, expectedVersion);
  let syncResult = null;

  if (dryRun) {
    syncResult = runSkillsUpgrade({
      method: normalizedMethod,
      targetVersion: requestedVersion || expectedVersion,
      targetRoot: normalizedTargetRoot,
      githubOwner: UPDATE_REPO_OWNER,
      githubRepo: UPDATE_REPO_NAME,
      runCommand: () => ({
        status: 0,
        stdout: '',
        stderr: '',
        error: null,
      }),
    });
    syncResult.ok = true;
  } else if (!useExternalCommand && normalizedMethod === 'npm') {
    try {
      await installSkill({
        targetRoot: normalizedTargetRoot,
        force: true,
        dryRun: false,
        appVersion: expectedVersion,
      });
      syncResult = {
        method: 'npm',
        targetVersion: requestedVersion || expectedVersion || 'current',
        command: buildLocalSkillInstallCommand(normalizedTargetRoot),
        ok: true,
        status: 0,
        stdout: '',
        stderr: '',
        error: '',
      };
    } catch (error) {
      syncResult = {
        method: 'npm',
        targetVersion: requestedVersion || expectedVersion || 'current',
        command: buildLocalSkillInstallCommand(normalizedTargetRoot),
        ok: false,
        status: 1,
        stdout: '',
        stderr: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  } else {
    syncResult = runSkillsUpgrade({
      method: normalizedMethod,
      targetVersion: requestedVersion || expectedVersion,
      targetRoot: normalizedTargetRoot,
      githubOwner: UPDATE_REPO_OWNER,
      githubRepo: UPDATE_REPO_NAME,
    });
  }

  const afterBinding = dryRun ? beforeBinding : await inspectSkillBindingSafe(context, expectedVersion);
  const before = summarizeSkillBinding(beforeBinding);
  const after = summarizeSkillBinding(afterBinding);
  let ok = Boolean(syncResult.ok);
  let status = dryRun ? 'dry_run' : ok ? 'synced' : 'failed';

  if (!dryRun && ok && !after.matched) {
    ok = false;
    status = 'mismatch_after_sync';
    if (!syncResult.error) {
      syncResult.error = 'skills 同步命令执行成功，但版本仍未匹配';
    }
  }

  return {
    ok,
    status,
    method: normalizedMethod,
    dryRun,
    before,
    after,
    skillSync: syncResult,
  };
}

async function runSyncSkillsModeNonInteractive(context, cliArgs, warnings = []) {
  const method = normalizeSkillSyncMethod(cliArgs.skillSyncMethod || 'npm');
  const dryRun = cliArgs.dryRun !== null ? Boolean(cliArgs.dryRun) : false;
  const requestedVersion = String(cliArgs.skillSyncRef || '').trim();

  const syncResult = await executeSkillSync({
    context,
    method,
    dryRun,
    requestedVersion,
    expectedAppVersion: context.appMeta?.version || '',
    useExternalCommand: method === 'github-script',
  });

  warnings.push(...collectSkillBindingWarnings(syncResult.after));
  if (!syncResult.ok && syncResult.skillSync?.error) {
    warnings.push(`skills 同步失败：${syncResult.skillSync.error}`);
  }

  return {
    ok: syncResult.ok,
    action: MODES.SYNC_SKILLS,
    dryRun,
    summary: {
      method,
      dryRun,
      status: syncResult.status,
      skillsStatusBefore: syncResult.before.status,
      skillsStatusAfter: syncResult.after.status,
      skillsMatchedAfter: syncResult.after.matched,
    },
    warnings: uniqueStrings(warnings),
    errors: syncResult.ok
      ? []
      : [
          {
            code: 'E_SKILL_SYNC_FAILED',
            message: syncResult.skillSync?.error || 'skills_sync_failed',
          },
        ],
    data: {
      before: syncResult.before,
      after: syncResult.after,
      skillSync: syncResult.skillSync,
    },
  };
}

async function runCheckUpdateModeNonInteractive(context, cliArgs, warnings = []) {
  const channel = resolveUpdateChannel(cliArgs, context.config);
  const checkResult = await checkLatestVersion({
    currentVersion: context.appMeta?.version || '0.0.0',
    packageName: PACKAGE_NAME,
    githubOwner: UPDATE_REPO_OWNER,
    githubRepo: UPDATE_REPO_NAME,
    channel,
    timeoutMs: UPDATE_TIMEOUT_MS,
    reason: 'manual',
  });
  const normalizedSelfUpdate = normalizeSelfUpdateConfig({
    ...context.config.selfUpdate,
    channel,
  });
  context.config.selfUpdate = applyUpdateCheckResult(normalizedSelfUpdate, checkResult, '');
  await persistSelfUpdateState(context);
  const updateData = buildUpdateData(checkResult, context.config.selfUpdate.skipVersion);
  const fallbackWarnings = collectUpdateFallbackWarnings(updateData);
  warnings.push(...fallbackWarnings);
  const skillBinding = await inspectSkillBindingSafe(context, context.appMeta?.version || '');
  const skills = summarizeSkillBinding(skillBinding);
  warnings.push(...collectSkillBindingWarnings(skillBinding));

  if (updateData.hasUpdate && !updateData.skippedByUser) {
    warnings.push(updateWarningMessage(updateData, context.config.selfUpdate.skipVersion));
  }

  return {
    ok: updateData.checked,
    action: MODES.CHECK_UPDATE,
    dryRun: null,
    summary: {
      checked: updateData.checked,
      hasUpdate: updateData.hasUpdate,
      currentVersion: updateData.currentVersion || '-',
      latestVersion: updateData.latestVersion || '-',
      source: updateData.sourceUsed,
      sourceChain: deriveUpdateSourceChain(
        {
          source: updateData.sourceUsed,
        },
        updateData
      ),
      channel: updateData.channel,
      skippedByUser: updateData.skippedByUser,
      skillsStatus: skills.status,
      skillsMatched: skills.matched,
      skillsInstalledVersion: skills.installedSkillVersion || '-',
      skillsBoundAppVersion: skills.installedRequiredAppVersion || '-',
    },
    warnings: uniqueStrings(warnings),
    errors: updateData.checked
      ? []
      : updateData.errors.map((message) => ({
          code: 'E_UPDATE_CHECK_FAILED',
          message,
        })),
    data: {
      update: updateData,
      skills,
    },
  };
}

async function runUpgradeModeNonInteractive(context, cliArgs, warnings = []) {
  const method = String(cliArgs.upgradeMethod || '').trim();
  if (!method) {
    throw new UsageError('参数 --upgrade 缺少升级方式（npm|github-script）');
  }
  if (!cliArgs.upgradeYes) {
    throw new ConfirmationRequiredError('检测到升级请求，但未提供 --upgrade-yes 确认参数。');
  }

  const syncSkillsEnabled = shouldSyncSkillsOnUpgrade(cliArgs);
  const skillSyncMethod = normalizeSkillSyncMethod(cliArgs.skillSyncMethod || method);
  const channel = resolveUpdateChannel(cliArgs, context.config);
  let targetVersion = String(cliArgs.upgradeVersion || '').trim();
  const requestedSkillRef = String(cliArgs.skillSyncRef || '').trim();
  let checkResult = null;
  let checkData = null;
  const beforeSkills = summarizeSkillBinding(
    await inspectSkillBindingSafe(context, context.appMeta?.version || '')
  );

  if (!targetVersion) {
    checkResult = await checkLatestVersion({
      currentVersion: context.appMeta?.version || '0.0.0',
      packageName: PACKAGE_NAME,
      githubOwner: UPDATE_REPO_OWNER,
      githubRepo: UPDATE_REPO_NAME,
      channel,
      timeoutMs: UPDATE_TIMEOUT_MS,
      reason: 'manual',
    });
    checkData = buildUpdateData(checkResult, context.config.selfUpdate.skipVersion);
    warnings.push(...collectUpdateFallbackWarnings(checkData));

    if (!checkResult.checked) {
      return {
        ok: false,
        action: MODES.UPGRADE,
        dryRun: null,
        summary: {
          executed: false,
          method,
          targetVersion: '-',
          reason: 'check_failed',
          skillSyncEnabled: syncSkillsEnabled,
          skillSyncMethod,
          skillSyncStatus: 'skipped_check_failed',
          skillsStatusBefore: beforeSkills.status,
          skillsStatusAfter: beforeSkills.status,
        },
        warnings: uniqueStrings(warnings),
        errors: (checkResult.errors || []).map((message) => ({
          code: 'E_UPGRADE_CHECK_FAILED',
          message,
        })),
        data: {
          update: checkData,
          skills: {
            before: beforeSkills,
            after: beforeSkills,
          },
          skillSync: null,
        },
      };
    }
    if (!checkResult.hasUpdate) {
      let syncResult = null;
      let afterSkills = beforeSkills;
      if (syncSkillsEnabled && !beforeSkills.matched) {
        syncResult = await executeSkillSync({
          context,
          method: skillSyncMethod,
          dryRun: false,
          requestedVersion: requestedSkillRef || checkResult.currentVersion || '',
          expectedAppVersion: checkResult.currentVersion || context.appMeta?.version || '',
          useExternalCommand: skillSyncMethod === 'github-script',
        });
        afterSkills = syncResult.after;
        warnings.push(...collectSkillBindingWarnings(syncResult.after));
        if (!syncResult.ok && syncResult.skillSync?.error) {
          warnings.push(`skills 同步失败：${syncResult.skillSync.error}`);
        }
      } else if (!syncSkillsEnabled && !beforeSkills.matched) {
        warnings.push('当前已是最新版本，但 skills 未匹配；可执行 wecom-cleaner --sync-skills 处理。');
      }

      const payloadOk = syncResult ? syncResult.ok : true;
      return {
        ok: payloadOk,
        action: MODES.UPGRADE,
        dryRun: null,
        summary: {
          executed: false,
          method,
          targetVersion: checkResult.currentVersion || '-',
          reason: 'already_latest',
          skillSyncEnabled: syncSkillsEnabled,
          skillSyncMethod,
          skillSyncStatus: syncResult
            ? syncResult.status
            : syncSkillsEnabled
              ? 'skipped_already_matched'
              : 'disabled',
          skillSyncTargetVersion: requestedSkillRef || checkResult.currentVersion || '-',
          skillsStatusBefore: beforeSkills.status,
          skillsStatusAfter: afterSkills.status,
        },
        warnings: uniqueStrings(warnings),
        errors:
          syncResult && !syncResult.ok
            ? [
                {
                  code: 'E_SKILL_SYNC_FAILED',
                  message: syncResult.skillSync?.error || 'skills_sync_failed',
                },
              ]
            : [],
        data: {
          update: checkData,
          skills: {
            before: beforeSkills,
            after: afterSkills,
          },
          skillSync: syncResult?.skillSync || null,
        },
      };
    }
    targetVersion = checkResult.latestVersion;
  }

  const upgrade = runUpgrade({
    method,
    packageName: PACKAGE_NAME,
    targetVersion,
    githubOwner: UPDATE_REPO_OWNER,
    githubRepo: UPDATE_REPO_NAME,
  });

  if (upgrade.ok) {
    context.config.selfUpdate = normalizeSelfUpdateConfig({
      ...context.config.selfUpdate,
      skipVersion: '',
      lastKnownLatest: targetVersion,
      lastKnownSource: upgrade.method,
    });
    await persistSelfUpdateState(context);
  }

  let syncResult = null;
  let afterSkills = summarizeSkillBinding(
    await inspectSkillBindingSafe(context, upgrade.ok ? targetVersion : context.appMeta?.version || '')
  );
  if (upgrade.ok && syncSkillsEnabled) {
    syncResult = await executeSkillSync({
      context,
      method: skillSyncMethod,
      dryRun: false,
      requestedVersion: requestedSkillRef || targetVersion || '',
      expectedAppVersion: targetVersion || context.appMeta?.version || '',
      useExternalCommand: true,
    });
    afterSkills = syncResult.after;
    warnings.push(...collectSkillBindingWarnings(syncResult.after));
    if (!syncResult.ok && syncResult.skillSync?.error) {
      warnings.push(`skills 同步失败：${syncResult.skillSync.error}`);
    }
  } else if (upgrade.ok && !syncSkillsEnabled && !afterSkills.matched) {
    warnings.push('程序升级已完成，但 skills 同步已关闭；建议执行 wecom-cleaner --sync-skills。');
  }

  const payloadOk = upgrade.ok && (syncResult ? syncResult.ok : true);
  return {
    ok: payloadOk,
    action: MODES.UPGRADE,
    dryRun: null,
    summary: {
      executed: true,
      method: upgrade.method,
      targetVersion: upgrade.targetVersion || targetVersion || '-',
      command: upgrade.command,
      status: upgrade.status,
      skillSyncEnabled: syncSkillsEnabled,
      skillSyncMethod,
      skillSyncStatus: syncResult
        ? syncResult.status
        : syncSkillsEnabled
          ? 'skipped_upgrade_failed'
          : 'disabled',
      skillSyncTargetVersion: requestedSkillRef || targetVersion || '-',
      skillsStatusBefore: beforeSkills.status,
      skillsStatusAfter: afterSkills.status,
    },
    warnings: uniqueStrings(warnings),
    errors: [
      ...(upgrade.ok
        ? []
        : [
            {
              code: 'E_UPGRADE_FAILED',
              message: upgrade.error || upgrade.stderr || 'upgrade_failed',
            },
          ]),
      ...(!syncResult || syncResult.ok
        ? []
        : [
            {
              code: 'E_SKILL_SYNC_FAILED',
              message: syncResult.skillSync?.error || 'skills_sync_failed',
            },
          ]),
    ],
    data: {
      update: checkResult ? buildUpdateData(checkResult, context.config.selfUpdate.skipVersion) : null,
      upgrade,
      skills: {
        before: beforeSkills,
        after: afterSkills,
      },
      skillSync: syncResult?.skillSync || null,
    },
  };
}

function attachStartupUpdateToResult(result, startupUpdate, skipVersion) {
  if (!startupUpdate) {
    return result;
  }
  const output = result && typeof result === 'object' ? result : {};
  const warnings = uniqueStrings(Array.isArray(output.warnings) ? output.warnings : []);
  const updateData = buildUpdateData(startupUpdate, skipVersion);
  if (updateData.hasUpdate && !updateData.skippedByUser) {
    warnings.push(updateWarningMessage(updateData, skipVersion));
  }
  return {
    ...output,
    warnings: uniqueStrings(warnings),
    data: {
      ...(output.data || {}),
      update: updateData,
    },
  };
}

async function maybeRunStartupUpdateCheck(context, cliArgs, action, interactiveMode) {
  if (!allowAutoUpdateByEnv()) {
    return null;
  }
  const selfUpdate = normalizeSelfUpdateConfig(context.config.selfUpdate);
  context.config.selfUpdate = selfUpdate;

  if (!selfUpdate.enabled) {
    return null;
  }
  if (action === MODES.CHECK_UPDATE || action === MODES.UPGRADE || action === MODES.SYNC_SKILLS) {
    return null;
  }
  if (!interactiveMode && action === MODES.DOCTOR) {
    return null;
  }

  const decision = shouldCheckForUpdate(selfUpdate, Date.now());
  if (!decision.shouldCheck) {
    return null;
  }

  const channel = resolveUpdateChannel(cliArgs, context.config);
  const checkResult = await checkLatestVersion({
    currentVersion: context.appMeta?.version || '0.0.0',
    packageName: PACKAGE_NAME,
    githubOwner: UPDATE_REPO_OWNER,
    githubRepo: UPDATE_REPO_NAME,
    channel,
    timeoutMs: UPDATE_TIMEOUT_MS,
    reason: 'startup_slot',
  });
  context.config.selfUpdate = applyUpdateCheckResult(
    normalizeSelfUpdateConfig({
      ...context.config.selfUpdate,
      channel,
    }),
    checkResult,
    decision.slot || ''
  );
  await persistSelfUpdateState(context);
  return buildUpdateData(checkResult, context.config.selfUpdate.skipVersion);
}

async function maybePromptInteractiveUpgrade(context, startupUpdate) {
  if (!startupUpdate || !startupUpdate.hasUpdate || startupUpdate.skippedByUser) {
    return false;
  }

  printSection('可用更新');
  printTextRows('更新提示', [
    {
      label: '版本',
      value: `当前 v${startupUpdate.currentVersion || '-'} -> 最新 v${startupUpdate.latestVersion || '-'}`,
    },
    { label: '来源', value: startupUpdate.sourceUsed || '-' },
    { label: '通道', value: channelLabel(startupUpdate.channel) },
  ]);

  const choice = await askSelect({
    message: '检测到新版本，是否升级？',
    default: 'npm',
    choices: [
      { name: '通过 npm 升级（默认）', value: 'npm' },
      { name: '通过 GitHub 脚本升级', value: 'github-script' },
      { name: '稍后提醒', value: 'later' },
      { name: '跳过该版本（不再提醒）', value: 'skip-version' },
    ],
  });

  if (choice === 'later') {
    return false;
  }
  if (choice === 'skip-version') {
    context.config.selfUpdate = normalizeSelfUpdateConfig({
      ...context.config.selfUpdate,
      skipVersion: startupUpdate.latestVersion || '',
    });
    await persistSelfUpdateState(context);
    console.log(`已记录：v${startupUpdate.latestVersion} 将不再自动提醒。`);
    return false;
  }

  const confirmed = await askConfirm({
    message: `确认升级到 v${startupUpdate.latestVersion}？`,
    default: true,
  });
  if (!confirmed) {
    return false;
  }

  const upgrade = runUpgrade({
    method: choice,
    packageName: PACKAGE_NAME,
    targetVersion: startupUpdate.latestVersion,
    githubOwner: UPDATE_REPO_OWNER,
    githubRepo: UPDATE_REPO_NAME,
  });
  if (!upgrade.ok) {
    printTextRows('升级结果', [
      { label: '状态', value: '失败' },
      { label: '方式', value: choice },
      { label: '命令', value: upgrade.command },
      { label: '错误', value: upgrade.error || upgrade.stderr || 'unknown_error' },
    ]);
    return false;
  }

  context.config.selfUpdate = normalizeSelfUpdateConfig({
    ...context.config.selfUpdate,
    skipVersion: '',
    lastKnownLatest: startupUpdate.latestVersion || '',
    lastKnownSource: choice,
  });
  await persistSelfUpdateState(context);
  const syncResult = await executeSkillSync({
    context,
    method: normalizeSkillSyncMethod(choice),
    dryRun: false,
    expectedAppVersion: startupUpdate.latestVersion || '',
    requestedVersion: startupUpdate.latestVersion || '',
    useExternalCommand: true,
  });
  printTextRows('升级结果', [
    { label: '状态', value: '成功' },
    { label: '方式', value: choice },
    { label: '版本', value: `v${startupUpdate.latestVersion}` },
  ]);
  printTextRows('Skills 同步', [
    { label: '方式', value: skillSyncMethodLabel(syncResult.method) },
    { label: '状态', value: syncResult.ok ? '成功' : '失败' },
    { label: '匹配状态', value: syncResult.after.statusLabel || '-' },
    { label: '命令', value: syncResult.skillSync?.command || '-' },
  ]);
  if (!syncResult.ok) {
    printTextRows('Skills 提示', [
      {
        label: '建议',
        value: syncResult.after.recommendation || '请执行 wecom-cleaner --sync-skills 重试。',
      },
      { label: '错误', value: syncResult.skillSync?.error || 'skills_sync_failed' },
    ]);
  }
  console.log('升级已完成，建议重新启动 wecom-cleaner 后继续。');
  return true;
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
  if (action === MODES.CHECK_UPDATE) {
    return runCheckUpdateModeNonInteractive(context, cliArgs, warnings);
  }
  if (action === MODES.UPGRADE) {
    return runUpgradeModeNonInteractive(context, cliArgs, warnings);
  }
  if (action === MODES.SYNC_SKILLS) {
    return runSyncSkillsModeNonInteractive(context, cliArgs, warnings);
  }
  throw new UsageError(`不支持的无交互动作: ${action}`);
}

function phaseMatchedTargets(action, result) {
  const summary = result?.summary || {};
  if (action === MODES.CLEANUP_MONTHLY || action === MODES.SPACE_GOVERNANCE) {
    return Number(summary.matchedTargets || 0);
  }
  if (action === MODES.RESTORE) {
    return Number(summary.entryCount || 0);
  }
  if (action === MODES.RECYCLE_MAINTAIN) {
    return Number(summary.candidateCount || 0);
  }
  if (action === MODES.ANALYSIS_ONLY) {
    return Number(summary.targetCount || 0);
  }
  return 0;
}

function phaseMatchedBytes(action, result) {
  const summary = result?.summary || {};
  if (action === MODES.CLEANUP_MONTHLY || action === MODES.SPACE_GOVERNANCE || action === MODES.RESTORE) {
    return Number(summary.matchedBytes || 0);
  }
  if (action === MODES.ANALYSIS_ONLY) {
    return Number(summary.totalBytes || 0);
  }
  if (action === MODES.RECYCLE_MAINTAIN) {
    return Number(summary.deletedBytes || 0);
  }
  return 0;
}

function phaseReclaimedBytes(action, result) {
  const summary = result?.summary || {};
  if (action === MODES.RESTORE) {
    return Number(summary.restoredBytes || 0);
  }
  if (action === MODES.RECYCLE_MAINTAIN) {
    return Number(summary.deletedBytes || 0);
  }
  return Number(summary.reclaimedBytes || 0);
}

function buildTaskPhaseEntry(action, phaseName, result, durationMs) {
  const summary = result?.summary || {};
  const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  return {
    name: phaseName,
    status: 'completed',
    ok: Boolean(result?.ok),
    dryRun: result?.dryRun ?? null,
    durationMs: Math.max(0, Number(durationMs || 0)),
    summary,
    warningCount: warnings.length,
    errorCount: errors.length,
    warnings,
    errors,
    stats: {
      matchedTargets: phaseMatchedTargets(action, result),
      matchedBytes: phaseMatchedBytes(action, result),
      reclaimedBytes: phaseReclaimedBytes(action, result),
      successCount: Number(summary.successCount || 0),
      skippedCount: Number(summary.skippedCount || 0),
      failedCount: Number(summary.failedCount || summary.failedBatches || 0),
      batchId: summary.batchId || null,
    },
    userFacingSummary: buildUserFacingSummary(action, result),
  };
}

function buildSkippedTaskPhase(phaseName, reason) {
  return {
    name: phaseName,
    status: 'skipped',
    reason,
    ok: true,
    dryRun: null,
    durationMs: 0,
    summary: {},
    warningCount: 0,
    errorCount: 0,
    warnings: [],
    errors: [],
    stats: {
      matchedTargets: 0,
      matchedBytes: 0,
      reclaimedBytes: 0,
      successCount: 0,
      skippedCount: 0,
      failedCount: 0,
      batchId: null,
    },
    userFacingSummary: {},
  };
}

function buildTaskCardBreakdown(action, report) {
  const matched = report?.matched || {};
  if (action === MODES.CLEANUP_MONTHLY || action === MODES.ANALYSIS_ONLY) {
    return {
      byCategory: summarizeDimensionRows(matched.categoryStats, { labelKey: 'categoryLabel' }, 16),
      byMonth: summarizeDimensionRows(matched.monthStats, { labelKey: 'monthKey' }, 16),
      byRoot: summarizeDimensionRows(matched.rootStats, { labelKey: 'rootPath' }, 12),
      topPaths: Array.isArray(matched.topPaths)
        ? matched.topPaths.slice(0, 12).map((item) => ({
            path: item.path || '-',
            category: item.categoryLabel || item.categoryKey || '-',
            month: item.monthKey || '非月份目录',
            sizeBytes: Number(item.sizeBytes || 0),
          }))
        : [],
    };
  }
  if (action === MODES.SPACE_GOVERNANCE) {
    return {
      byCategory: summarizeDimensionRows(matched.byTargetType, { labelKey: 'targetLabel' }, 16),
      byMonth: [],
      byRoot: summarizeDimensionRows(matched.byRoot, { labelKey: 'rootPath' }, 12),
      byTier: summarizeDimensionRows(matched.byTier, { labelKey: 'tierLabel' }, 8),
      topPaths: Array.isArray(matched.topPaths)
        ? matched.topPaths.slice(0, 12).map((item) => ({
            path: item.path || '-',
            category: item.targetLabel || item.targetKey || '-',
            month: '-',
            sizeBytes: Number(item.sizeBytes || 0),
          }))
        : [],
    };
  }
  if (action === MODES.RESTORE) {
    return {
      byCategory: summarizeDimensionRows(matched.byCategory, { labelKey: 'categoryLabel' }, 16),
      byMonth: summarizeDimensionRows(matched.byMonth, { labelKey: 'monthKey' }, 16),
      byRoot: summarizeDimensionRows(matched.byRoot, { labelKey: 'rootPath' }, 12),
      topPaths: Array.isArray(matched.topEntries)
        ? matched.topEntries.slice(0, 12).map((item) => ({
            path: item.originalPath || '-',
            category: item.categoryLabel || item.categoryKey || '-',
            month: item.monthKey || '非月份目录',
            sizeBytes: Number(item.sizeBytes || 0),
          }))
        : [],
    };
  }
  if (action === MODES.RECYCLE_MAINTAIN) {
    const operations = Array.isArray(report?.operations) ? report.operations : [];
    const byStatus = operations.reduce((acc, item) => {
      const key = String(item?.status || 'unknown');
      acc.set(key, (acc.get(key) || 0) + 1);
      return acc;
    }, new Map());
    return {
      byCategory: [...byStatus.entries()].map(([label, count]) => ({
        label,
        count: Number(count || 0),
        sizeBytes: 0,
      })),
      byMonth: [],
      byRoot: [],
      topPaths: [],
    };
  }
  return {
    byCategory: [],
    byMonth: [],
    byRoot: [],
    topPaths: [],
  };
}

function buildRunTaskCard(action, runTaskMode, taskDecision, phases, finalResult) {
  const previewPhase = phases.find((item) => item.name === 'preview' && item.status === 'completed') || null;
  const executePhase = phases.find((item) => item.name === 'execute' && item.status === 'completed') || null;
  const verifyPhase = phases.find((item) => item.name === 'verify' && item.status === 'completed') || null;
  const report = finalResult?.data?.report || {};
  const breakdown = buildTaskCardBreakdown(action, report);

  let conclusion = '任务已完成。';
  if (taskDecision === 'skipped_no_target') {
    conclusion = '预演命中为 0，已按安全策略跳过真实执行。';
  } else if (taskDecision === 'preview_only') {
    conclusion = '已完成预演，本次未执行真实操作。';
  } else if (taskDecision === 'execute_only' && executePhase) {
    conclusion = executePhase.ok ? '已完成真实执行。' : '已尝试真实执行，但存在失败项。';
  } else if (taskDecision === 'executed_and_verified') {
    conclusion =
      verifyPhase && Number(verifyPhase.stats.matchedTargets || 0) === 0
        ? '已完成真实执行并通过复核，范围内无剩余目标。'
        : '已完成真实执行与复核。';
  } else if (taskDecision === 'preview_failed') {
    conclusion = '预演阶段失败，后续阶段未执行。';
  }

  return {
    action,
    actionLabel: actionDisplayName(action),
    mode: runTaskMode,
    decision: taskDecision,
    conclusion,
    phases: phases.map((item) => ({
      name: item.name,
      status: item.status,
      reason: item.reason || null,
      dryRun: item.dryRun,
      ok: item.ok,
      durationMs: item.durationMs,
      matchedTargets: Number(item?.stats?.matchedTargets || 0),
      matchedBytes: Number(item?.stats?.matchedBytes || 0),
      reclaimedBytes: Number(item?.stats?.reclaimedBytes || 0),
      successCount: Number(item?.stats?.successCount || 0),
      skippedCount: Number(item?.stats?.skippedCount || 0),
      failedCount: Number(item?.stats?.failedCount || 0),
      batchId: item?.stats?.batchId || null,
    })),
    scope: {
      accountCount: Number(finalResult?.summary?.accountCount || 0),
      monthCount: Number(finalResult?.summary?.monthCount || 0),
      categoryCount: Number(finalResult?.summary?.categoryCount || 0),
      rootPathCount: Number(finalResult?.summary?.rootPathCount || 0),
      cutoffMonth: finalResult?.summary?.cutoffMonth || null,
      selectedAccounts: uniqueStrings(finalResult?.data?.selectedAccounts || []),
      selectedMonths: uniqueStrings(finalResult?.data?.selectedMonths || []),
      selectedCategories: uniqueStrings(finalResult?.data?.selectedCategories || []),
      selectedExternalRoots: uniqueStrings(finalResult?.data?.selectedExternalRoots || []),
    },
    preview: previewPhase
      ? {
          matchedTargets: Number(previewPhase.stats.matchedTargets || 0),
          matchedBytes: Number(previewPhase.stats.matchedBytes || 0),
          reclaimedBytes: Number(previewPhase.stats.reclaimedBytes || 0),
          failedCount: Number(previewPhase.stats.failedCount || 0),
        }
      : null,
    execute: executePhase
      ? {
          successCount: Number(executePhase.stats.successCount || 0),
          skippedCount: Number(executePhase.stats.skippedCount || 0),
          failedCount: Number(executePhase.stats.failedCount || 0),
          reclaimedBytes: Number(executePhase.stats.reclaimedBytes || 0),
          batchId: executePhase.stats.batchId || null,
        }
      : null,
    verify: verifyPhase
      ? {
          matchedTargets: Number(verifyPhase.stats.matchedTargets || 0),
          matchedBytes: Number(verifyPhase.stats.matchedBytes || 0),
          failedCount: Number(verifyPhase.stats.failedCount || 0),
        }
      : null,
    breakdown,
  };
}

function withRunTaskResult(baseResult, action, runTaskMode, taskDecision, phases) {
  const output = baseResult && typeof baseResult === 'object' ? baseResult : {};
  const data = output.data && typeof output.data === 'object' ? output.data : {};
  const summary = output.summary && typeof output.summary === 'object' ? output.summary : {};
  return {
    ...output,
    summary: {
      ...summary,
      runTaskMode,
      taskDecision,
      phaseCount: phases.length,
    },
    data: {
      ...data,
      taskPhases: phases,
      taskCard: buildRunTaskCard(action, runTaskMode, taskDecision, phases, output),
    },
  };
}

async function runNonInteractiveTask(action, context, cliArgs) {
  const runTaskMode = normalizeRunTaskMode(cliArgs.runTask);
  if (!runTaskMode) {
    return runNonInteractiveAction(action, context, cliArgs);
  }

  if (action === MODES.SYNC_SKILLS) {
    throw new UsageError('动作 同步 Agent Skills 不支持 --run-task，请直接使用 --dry-run true|false。');
  }

  if (!isDestructiveAction(action) && runTaskMode !== RUN_TASK_PREVIEW) {
    throw new UsageError(`动作 ${actionDisplayName(action)} 仅支持 --run-task preview`);
  }
  if (
    isDestructiveAction(action) &&
    (runTaskMode === RUN_TASK_EXECUTE || runTaskMode === RUN_TASK_PREVIEW_EXECUTE_VERIFY) &&
    !cliArgs.yes
  ) {
    throw new ConfirmationRequiredError('检测到真实执行任务流程，但未提供 --yes 确认参数。');
  }

  const execPhase = async (phaseName, phaseArgs) => {
    const startedAt = Date.now();
    const result = await runNonInteractiveAction(action, context, phaseArgs);
    return {
      result,
      phase: buildTaskPhaseEntry(action, phaseName, result, Date.now() - startedAt),
    };
  };

  if (runTaskMode === RUN_TASK_PREVIEW) {
    const previewArgs = isDestructiveAction(action)
      ? { ...cliArgs, dryRun: true, yes: false, runTask: null }
      : { ...cliArgs, runTask: null };
    const preview = await execPhase('preview', previewArgs);
    return withRunTaskResult(preview.result, action, runTaskMode, 'preview_only', [preview.phase]);
  }

  if (runTaskMode === RUN_TASK_EXECUTE) {
    const executeArgs = isDestructiveAction(action)
      ? { ...cliArgs, dryRun: false, yes: true, runTask: null }
      : { ...cliArgs, runTask: null };
    const execute = await execPhase('execute', executeArgs);
    return withRunTaskResult(execute.result, action, runTaskMode, 'execute_only', [execute.phase]);
  }

  const previewArgs = { ...cliArgs, dryRun: true, yes: false, runTask: null };
  const preview = await execPhase('preview', previewArgs);
  if (!preview.result.ok) {
    const phases = [
      preview.phase,
      buildSkippedTaskPhase('execute', 'preview_failed'),
      buildSkippedTaskPhase('verify', 'preview_failed'),
    ];
    return withRunTaskResult(preview.result, action, runTaskMode, 'preview_failed', phases);
  }

  if (phaseMatchedTargets(action, preview.result) <= 0) {
    const phases = [
      preview.phase,
      buildSkippedTaskPhase('execute', 'no_target'),
      buildSkippedTaskPhase('verify', 'no_execute'),
    ];
    return withRunTaskResult(preview.result, action, runTaskMode, 'skipped_no_target', phases);
  }

  const executeArgs = { ...cliArgs, dryRun: false, yes: true, runTask: null };
  const execute = await execPhase('execute', executeArgs);
  const verify = await execPhase('verify', previewArgs);
  return withRunTaskResult(execute.result, action, runTaskMode, 'executed_and_verified', [
    preview.phase,
    execute.phase,
    verify.phase,
  ]);
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
        { label: '自动', value: '自动探测目录默认已纳入，可按需取消' },
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
        { label: '策略', value: '默认/手动/自动目录都已预选，可按需取消' },
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

async function runCheckUpdateMode(context, cliArgs = {}) {
  const channel = resolveUpdateChannel(cliArgs, context.config);
  const startedAt = Date.now();
  const skillBinding = await inspectSkillBindingSafe(context, context.appMeta?.version || '');
  const skills = summarizeSkillBinding(skillBinding);
  const checkResult = await checkLatestVersion({
    currentVersion: context.appMeta?.version || '0.0.0',
    packageName: PACKAGE_NAME,
    githubOwner: UPDATE_REPO_OWNER,
    githubRepo: UPDATE_REPO_NAME,
    channel,
    timeoutMs: UPDATE_TIMEOUT_MS,
    reason: 'manual',
  });

  context.config.selfUpdate = applyUpdateCheckResult(
    normalizeSelfUpdateConfig({
      ...context.config.selfUpdate,
      channel,
    }),
    checkResult,
    ''
  );
  await persistSelfUpdateState(context);

  const payload = {
    ok: checkResult.checked,
    action: MODES.CHECK_UPDATE,
    dryRun: null,
    summary: {
      checked: Boolean(checkResult.checked),
      hasUpdate: Boolean(checkResult.hasUpdate),
      currentVersion: checkResult.currentVersion || '-',
      latestVersion: checkResult.latestVersion || '-',
      source: checkResult.sourceUsed || 'none',
      sourceChain: deriveUpdateSourceChain(
        {
          source: checkResult.sourceUsed || 'none',
        },
        checkResult
      ),
      channel: checkResult.channel || channel,
      skippedByUser: shouldSkipVersion(checkResult, context.config.selfUpdate.skipVersion),
      skillsStatus: skills.status,
      skillsMatched: skills.matched,
      skillsInstalledVersion: skills.installedSkillVersion || '-',
      skillsBoundAppVersion: skills.installedRequiredAppVersion || '-',
    },
    warnings: uniqueStrings([
      ...collectUpdateFallbackWarnings(checkResult),
      ...collectSkillBindingWarnings(skillBinding),
    ]),
    errors:
      checkResult.checked && checkResult.sourceUsed !== 'none'
        ? []
        : Array.isArray(checkResult.errors)
          ? checkResult.errors.map((message) => ({
              code: 'E_UPDATE_CHECK_FAILED',
              message,
            }))
          : [],
    data: {
      update: buildUpdateData(checkResult, context.config.selfUpdate.skipVersion),
      skills,
    },
    meta: {
      app: APP_NAME,
      package: PACKAGE_NAME,
      version: context.appMeta?.version || '0.0.0',
      timestamp: Date.now(),
      durationMs: Date.now() - startedAt,
      output: OUTPUT_TEXT,
      engine: context.lastRunEngineUsed || (context.nativeCorePath ? 'zig_ready' : 'node'),
    },
  };

  if (payload.summary.hasUpdate && !payload.summary.skippedByUser) {
    payload.warnings.push(updateWarningMessage(payload.data.update, context.config.selfUpdate.skipVersion));
  }
  printCheckUpdateTextResult(payload);

  const upgraded = await maybePromptInteractiveUpgrade(context, payload.data.update);
  if (upgraded) {
    return;
  }

  if (!skills.matched) {
    const syncNow = await askConfirm({
      message: '检测到 skills 与当前程序版本不匹配，是否现在同步？',
      default: true,
    });
    if (syncNow) {
      await runSyncSkillsMode(context, {
        skillSyncMethod: normalizeSkillSyncMethod(cliArgs.skillSyncMethod || 'npm'),
      });
    }
  }
}

async function runSyncSkillsMode(context, cliArgs = {}) {
  const method =
    typeof cliArgs.skillSyncMethod === 'string' && cliArgs.skillSyncMethod.trim()
      ? normalizeSkillSyncMethod(cliArgs.skillSyncMethod)
      : await askSelect({
          message: '请选择 skills 同步方式',
          default: 'npm',
          choices: [
            { name: 'npm（默认，使用本地随包 skills）', value: 'npm' },
            { name: 'GitHub 脚本（按版本下载）', value: 'github-script' },
          ],
        });

  const dryRun =
    typeof cliArgs.dryRun === 'boolean'
      ? cliArgs.dryRun
      : await askConfirm({
          message: '先进行 skills 同步预演？',
          default: true,
        });

  if (!dryRun) {
    const confirmed = await askConfirm({
      message: '将写入 Codex skills 目录，确认继续？',
      default: true,
    });
    if (!confirmed) {
      console.log('已取消 skills 同步。');
      return;
    }
  }

  const startedAt = Date.now();
  const result = await runSyncSkillsModeNonInteractive(
    context,
    {
      ...cliArgs,
      skillSyncMethod: method,
      dryRun,
    },
    []
  );
  const payload = {
    ...result,
    meta: {
      app: APP_NAME,
      package: PACKAGE_NAME,
      version: context.appMeta?.version || '0.0.0',
      timestamp: Date.now(),
      durationMs: Date.now() - startedAt,
      output: OUTPUT_TEXT,
      engine: context.lastRunEngineUsed || (context.nativeCorePath ? 'zig_ready' : 'node'),
    },
  };
  printSyncSkillsTextResult(payload);
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
  if (mode === MODES.CHECK_UPDATE) {
    await runCheckUpdateMode(context, options.cliArgs || {});
    return;
  }
  if (mode === MODES.SYNC_SKILLS) {
    await runSyncSkillsMode(context, options.cliArgs || {});
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
    const skillSummary = summarizeSkillBinding(
      await inspectSkillBindingSafe(context, context.appMeta?.version || '')
    );
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
      skillSummary,
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
        { name: '检查更新与升级', value: MODES.CHECK_UPDATE },
        { name: '同步 Agent Skills', value: MODES.SYNC_SKILLS },
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
      cliArgs: {},
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
    readOnlyConfig,
  };

  let lockHandle = null;
  if (lockMode !== MODES.DOCTOR) {
    lockHandle = await acquireExecutionLock(config.stateRoot, lockMode, { force: cliArgs.force });
  }

  try {
    const startupUpdate = await maybeRunStartupUpdateCheck(context, cliArgs, action, interactiveMode);

    if (interactiveMode) {
      const upgraded = await maybePromptInteractiveUpgrade(context, startupUpdate);
      if (upgraded) {
        return;
      }
      if (interactiveStartMode !== MODES.START) {
        await runMode(interactiveStartMode, context, {
          jsonOutput: false,
          force: cliArgs.force,
          cliArgs,
        });
        return;
      }
      await runInteractiveLoop(context);
      return;
    }

    const startedAt = Date.now();
    let result = await runNonInteractiveTask(action, context, cliArgs);
    if (action !== MODES.CHECK_UPDATE && action !== MODES.UPGRADE) {
      result = attachStartupUpdateToResult(result, startupUpdate, context.config.selfUpdate.skipVersion);
    }
    result = {
      ...(result || {}),
      data: {
        ...((result && result.data) || {}),
        userFacingSummary: buildUserFacingSummary(action, result),
      },
    };
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
