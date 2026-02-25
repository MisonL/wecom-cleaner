#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkbox, confirm, input, select } from '@inquirer/prompts';
import {
  CACHE_CATEGORIES,
  MODES,
  PACKAGE_NAME,
  APP_NAME,
  APP_ASCII_LOGO,
} from './constants.js';
import { loadAliases, loadConfig, parseCliArgs, saveAliases, saveConfig } from './config.js';
import { detectNativeCore } from './native-bridge.js';
import { discoverAccounts, collectAvailableMonths, collectCleanupTargets, analyzeCacheFootprint } from './scanner.js';
import { executeCleanup } from './cleanup.js';
import { listRestorableBatches, restoreBatch } from './restore.js';
import { printAnalysisSummary } from './analysis.js';
import {
  compareMonthKey,
  expandHome,
  formatBytes,
  formatLocalDate,
  monthByDaysBefore,
  normalizeMonthKey,
  padToWidth,
  printProgress,
  printSection,
  renderTable,
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

function categoryChoices(defaultKeys = []) {
  const defaultSet = new Set(defaultKeys);
  return CACHE_CATEGORIES.map((cat) => ({
    name: `${cat.label} (${cat.key}) - ${cat.desc}`,
    value: cat.key,
    checked: defaultSet.size === 0 ? true : defaultSet.has(cat.key),
  }));
}

function formatEngineStatus({ nativeCorePath, lastRunEngineUsed }) {
  if (!nativeCorePath) {
    return 'Zig核心:未启用(Node)';
  }
  if (lastRunEngineUsed === 'zig') {
    return 'Zig核心:已启用(运行中)';
  }
  if (lastRunEngineUsed === 'node') {
    return 'Zig核心:已探测(本次回退Node)';
  }
  return 'Zig核心:已探测(待使用)';
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

function printHeader({ config, accountCount, nativeCorePath, lastRunEngineUsed, appMeta }) {
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

async function runCleanupMode(context) {
  const { config, aliases, nativeCorePath } = context;

  const accounts = await discoverAccounts(config.rootDir, aliases);
  const selectedAccountIds = await chooseAccounts(accounts, '年月清理');
  if (selectedAccountIds.length === 0) {
    return;
  }

  const allCategoryKeys = CACHE_CATEGORIES.map((x) => x.key);
  const availableMonths = await collectAvailableMonths(accounts, selectedAccountIds, allCategoryKeys);

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

  const selectedAccountIds = await chooseAccounts(accounts, '会话分析（只读）');
  if (selectedAccountIds.length === 0) {
    return;
  }

  const selectedCategories = await askCheckbox({
    message: '选择分析范围（缓存类型）',
    required: true,
    choices: categoryChoices(config.defaultCategories),
    validate: (values) => (values.length > 0 ? true : '至少选择一个类型'),
  });

  printSection('分析中');
  const result = await analyzeCacheFootprint({
    accounts,
    selectedAccountIds,
    categoryKeys: selectedCategories,
    nativeCorePath,
    onProgress: (current, total) => printProgress('分析目录', current, total),
  });
  context.lastRunEngineUsed = result.engineUsed;

  printSection('分析结果（只读）');
  printAnalysisSummary(result);
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

async function askOutOfProfileRisk(risk) {
  console.log('\n[高危] 检测到恢复目标不在企业微信 Profiles 根目录内。');
  console.log(`Profiles 根目录: ${risk.profileRoot}`);
  console.log(`恢复目标路径  : ${risk.originalPath}`);

  const firstConfirm = await askConfirm({
    message: '继续恢复到根目录外路径？',
    default: false,
  });

  let allow = false;
  if (firstConfirm) {
    const secondConfirm = await askConfirm({
      message: '再次确认：我已知晓风险并继续恢复',
      default: false,
    });
    allow = Boolean(secondConfirm);
  }

  const applyToAll = await askConfirm({
    message: '后续同类高危路径是否沿用本策略？',
    default: false,
  });

  return { allow, applyToAll };
}

async function runRestoreMode(context) {
  const { config } = context;

  const batches = await listRestorableBatches(config.indexPath);
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
  const result = await restoreBatch({
    batch,
    indexPath: config.indexPath,
    onProgress: (current, total) => printProgress('恢复目录', current, total),
    onConflict: askConflictResolution,
    onRiskConfirm: askOutOfProfileRisk,
    profileRoot: config.rootDir,
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
        { name: `回收区目录: ${config.recycleRoot}`, value: 'recycle' },
        { name: `默认 dry-run: ${config.dryRunDefault ? '开' : '关'}`, value: 'dryrun' },
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
  if (mode === MODES.RESTORE) {
    await runRestoreMode(context);
    return;
  }
  if (mode === MODES.SETTINGS) {
    await runSettingsMode(context);
    return;
  }
}

async function main() {
  const cliArgs = parseCliArgs(process.argv.slice(2));
  const config = await loadConfig(cliArgs);
  const aliases = await loadAliases(config.aliasPath);

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const projectRoot = path.resolve(__dirname, '..');
  const nativeCorePath = await detectNativeCore(projectRoot);
  const appMeta = await loadAppMeta(projectRoot);

  const context = { config, aliases, nativeCorePath, appMeta };

  if (cliArgs.mode) {
    await runMode(cliArgs.mode, context);
    return;
  }

  while (true) {
    const accounts = await discoverAccounts(config.rootDir, context.aliases);
    printHeader({
      config,
      accountCount: accounts.length,
      nativeCorePath,
      lastRunEngineUsed: context.lastRunEngineUsed || null,
      appMeta: context.appMeta,
    });

    const mode = await askSelect({
      message: '开始菜单：请选择功能',
      default: MODES.CLEANUP_MONTHLY,
      choices: [
        { name: '年月清理（默认，可执行删除）', value: MODES.CLEANUP_MONTHLY },
        { name: '会话分析（只读，不处理）', value: MODES.ANALYSIS_ONLY },
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
  console.error('运行失败:', error instanceof Error ? error.message : error);
  process.exit(1);
});
