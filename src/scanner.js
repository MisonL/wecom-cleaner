import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CACHE_CATEGORIES,
  CATEGORY_MAP,
  CJK_TEXT_RE,
  EMAIL_RE,
  USER_LABEL_STOPWORDS,
  CORP_LABEL_STOPWORDS,
} from './constants.js';
import {
  calculateDirectorySize,
  decodeBase64Utf8,
  mapLimit,
  normalizeMonthKey,
  shortId,
  sortMonthKeys,
} from './utils.js';

const CATEGORY_BY_KEY = new Map(CACHE_CATEGORIES.map((item) => [item.key, item]));

async function readCurrentProfileId(rootDir) {
  const settingPath = path.join(rootDir, 'setting.json');
  try {
    const raw = await fs.readFile(settingPath, 'utf-8');
    const json = JSON.parse(raw);
    const value = json?.CurrentProfile;
    if (typeof value === 'string' && value) {
      return value;
    }
    return null;
  } catch {
    return null;
  }
}

function pickFirstEmail(text) {
  const source = text || '';
  for (const match of source.matchAll(EMAIL_RE)) {
    const email = match[0];
    if (!email) {
      continue;
    }
    if (email.toLowerCase().endsWith('@wework.qpic.cn')) {
      continue;
    }
    return email;
  }
  return null;
}

function pickFirstCjk(text, stopwords) {
  const source = text || '';
  for (const match of source.matchAll(CJK_TEXT_RE)) {
    const token = match[0];
    if (!token || stopwords.has(token)) {
      continue;
    }
    if (token.startsWith('帮助企业') || token.startsWith('实现移动化办公')) {
      continue;
    }
    return token;
  }
  return null;
}

async function extractIdentity(profilePath) {
  const ioPath = path.join(profilePath, 'io_data.json');
  try {
    const raw = await fs.readFile(ioPath, 'utf-8');
    const json = JSON.parse(raw);
    const userText = decodeBase64Utf8(json?.user_info);
    const corpText = decodeBase64Utf8(json?.corp_info);

    const userName = pickFirstCjk(userText, USER_LABEL_STOPWORDS) || pickFirstEmail(userText);
    const corpName = pickFirstCjk(corpText, CORP_LABEL_STOPWORDS);
    return {
      userName: userName || null,
      corpName: corpName || null,
    };
  } catch {
    return { userName: null, corpName: null };
  }
}

async function listSubDirectories(targetPath) {
  try {
    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function parseDuOutput(stdout) {
  const map = new Map();
  const lines = String(stdout || '').split(/\r?\n/);
  for (const line of lines) {
    if (!line) {
      continue;
    }
    const idx = line.indexOf('\t');
    if (idx <= 0) {
      continue;
    }
    const sizeRaw = line.slice(0, idx);
    const p = line.slice(idx + 1);
    const size = Number(sizeRaw);
    if (!Number.isFinite(size)) {
      continue;
    }
    map.set(p, Math.max(0, size));
  }
  return map;
}

async function calculateSizesByNative(candidates, nativeCorePath, onProgress) {
  const chunkSize = 200;
  let done = 0;

  for (let i = 0; i < candidates.length; i += chunkSize) {
    const chunk = candidates.slice(i, i + chunkSize);
    const args = ['du', ...chunk.map((item) => item.path)];
    const result = spawnSync(nativeCorePath, args, {
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    });

    if (result.status !== 0) {
      throw new Error(result.stderr || `native core exited with code ${result.status}`);
    }

    const sizeMap = parseDuOutput(result.stdout);
    for (const item of chunk) {
      item.sizeBytes = sizeMap.get(item.path) ?? 0;
      done += 1;
      if (typeof onProgress === 'function') {
        onProgress(done, candidates.length);
      }
    }
  }
}

export async function discoverAccounts(rootDir, aliases = {}) {
  const currentProfileId = await readCurrentProfileId(rootDir);

  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const accounts = [];

  for (const id of dirs) {
    const profilePath = path.join(rootDir, id);
    const cachesPath = path.join(profilePath, 'Caches');
    const ioPath = path.join(profilePath, 'io_data.json');

    const hasCaches = await fs
      .stat(cachesPath)
      .then((s) => s.isDirectory())
      .catch(() => false);
    const hasIo = await fs
      .stat(ioPath)
      .then((s) => s.isFile())
      .catch(() => false);

    if (!hasCaches && !hasIo) {
      continue;
    }

    const identity = await extractIdentity(profilePath);
    const alias = aliases[id] || {};

    const userName = (alias.userName || identity.userName || '未知用户').trim();
    const corpName = (alias.corpName || identity.corpName || '未知企业').trim();

    const stat = await fs.stat(profilePath).catch(() => null);

    accounts.push({
      id,
      shortId: shortId(id),
      profilePath,
      userName,
      corpName,
      isCurrent: id === currentProfileId,
      mtimeMs: stat?.mtimeMs || 0,
    });
  }

  accounts.sort((a, b) => {
    if (a.isCurrent && !b.isCurrent) {
      return -1;
    }
    if (!a.isCurrent && b.isCurrent) {
      return 1;
    }
    return b.mtimeMs - a.mtimeMs;
  });

  return accounts;
}

export async function collectAvailableMonths(accounts, selectedAccountIds, categoryKeys) {
  const selectedSet = new Set(selectedAccountIds || []);
  const months = [];

  for (const account of accounts) {
    if (selectedSet.size > 0 && !selectedSet.has(account.id)) {
      continue;
    }
    for (const key of categoryKeys) {
      const category = CATEGORY_BY_KEY.get(key);
      if (!category) {
        continue;
      }
      const categoryPath = path.join(account.profilePath, category.relativePath);
      const children = await listSubDirectories(categoryPath);
      for (const child of children) {
        const monthKey = normalizeMonthKey(child);
        if (monthKey) {
          months.push(monthKey);
        }
      }
    }
  }

  return sortMonthKeys(months, 'asc');
}

export async function collectCleanupTargets({
  accounts,
  selectedAccountIds,
  categoryKeys,
  monthFilters,
  includeNonMonthDirs,
  nativeCorePath,
  sizeConcurrency = 4,
  onProgress,
}) {
  const selectedSet = new Set(selectedAccountIds || []);
  const normalizedMonths = (monthFilters || []).map((x) => normalizeMonthKey(x)).filter(Boolean);
  const monthSet = normalizedMonths.length > 0 ? new Set(normalizedMonths) : null;

  const candidates = [];

  for (const account of accounts) {
    if (selectedSet.size > 0 && !selectedSet.has(account.id)) {
      continue;
    }
    for (const key of categoryKeys) {
      const category = CATEGORY_BY_KEY.get(key);
      if (!category) {
        continue;
      }

      const rootPath = path.join(account.profilePath, category.relativePath);
      const children = await listSubDirectories(rootPath);

      for (const child of children) {
        const absPath = path.join(rootPath, child);
        const monthKey = normalizeMonthKey(child);
        const isMonthDir = Boolean(monthKey);

        const includeMonth = isMonthDir && (!monthSet || monthSet.has(monthKey));
        const includeNonMonth = !isMonthDir && Boolean(includeNonMonthDirs);

        if (!includeMonth && !includeNonMonth) {
          continue;
        }

        candidates.push({
          accountId: account.id,
          accountShortId: account.shortId,
          userName: account.userName,
          corpName: account.corpName,
          accountPath: account.profilePath,
          categoryKey: key,
          categoryLabel: category.label,
          categoryPath: category.relativePath,
          monthKey: monthKey || null,
          isMonthDir,
          directoryName: child,
          path: absPath,
          sizeBytes: 0,
        });
      }
    }
  }

  let engineUsed = nativeCorePath ? 'zig' : 'node';
  let nativeFallbackReason = null;

  let nativeFailed = false;
  if (nativeCorePath) {
    try {
      await calculateSizesByNative(candidates, nativeCorePath, onProgress);
    } catch (error) {
      nativeFailed = true;
      engineUsed = 'node';
      nativeFallbackReason =
        error instanceof Error && error.message
          ? `zig核心扫描失败: ${error.message}`
          : 'zig核心扫描失败，已回退Node引擎';
    }
  }

  if (!nativeCorePath || nativeFailed) {
    engineUsed = 'node';
    let progress = 0;
    await mapLimit(candidates, sizeConcurrency, async (item) => {
      const sizeBytes = await calculateDirectorySize(item.path);
      item.sizeBytes = sizeBytes;
      progress += 1;
      if (typeof onProgress === 'function') {
        onProgress(progress, candidates.length);
      }
    });
  }

  candidates.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return {
    targets: candidates,
    engineUsed,
    nativeFallbackReason,
  };
}

export async function analyzeCacheFootprint({
  accounts,
  selectedAccountIds,
  categoryKeys,
  nativeCorePath,
  onProgress,
}) {
  const scan = await collectCleanupTargets({
    accounts,
    selectedAccountIds,
    categoryKeys,
    monthFilters: [],
    includeNonMonthDirs: true,
    nativeCorePath,
    onProgress,
  });
  const targets = scan.targets;

  let totalBytes = 0;
  const accountMap = new Map();
  const categoryMap = new Map();
  const monthMap = new Map();

  for (const target of targets) {
    totalBytes += target.sizeBytes;

    const accountKey = target.accountId;
    const categoryKey = target.categoryKey;
    const monthKey = target.monthKey || '非月份目录';

    if (!accountMap.has(accountKey)) {
      accountMap.set(accountKey, {
        accountId: target.accountId,
        userName: target.userName,
        corpName: target.corpName,
        shortId: target.accountShortId,
        sizeBytes: 0,
        count: 0,
      });
    }
    if (!categoryMap.has(categoryKey)) {
      categoryMap.set(categoryKey, {
        categoryKey,
        categoryLabel: CATEGORY_MAP.get(categoryKey)?.label || categoryKey,
        sizeBytes: 0,
        count: 0,
      });
    }
    if (!monthMap.has(monthKey)) {
      monthMap.set(monthKey, {
        monthKey,
        sizeBytes: 0,
        count: 0,
      });
    }

    const accountRow = accountMap.get(accountKey);
    accountRow.sizeBytes += target.sizeBytes;
    accountRow.count += 1;

    const categoryRow = categoryMap.get(categoryKey);
    categoryRow.sizeBytes += target.sizeBytes;
    categoryRow.count += 1;

    const monthRow = monthMap.get(monthKey);
    monthRow.sizeBytes += target.sizeBytes;
    monthRow.count += 1;
  }

  const accountsSummary = [...accountMap.values()].sort((a, b) => b.sizeBytes - a.sizeBytes);
  const categoriesSummary = [...categoryMap.values()].sort((a, b) => b.sizeBytes - a.sizeBytes);
  const monthsSummary = [...monthMap.values()].sort((a, b) => b.sizeBytes - a.sizeBytes);

  return {
    targets,
    totalBytes,
    accountsSummary,
    categoriesSummary,
    monthsSummary,
    engineUsed: scan.engineUsed,
    nativeFallbackReason: scan.nativeFallbackReason,
  };
}
