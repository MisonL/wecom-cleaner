import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  CACHE_CATEGORIES,
  CATEGORY_MAP,
  SPACE_GOVERNANCE_TARGETS,
  SPACE_GOVERNANCE_TIERS,
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
  inferDataRootFromProfilesRoot,
} from './utils.js';

const CATEGORY_BY_KEY = new Map(CACHE_CATEGORIES.map((item) => [item.key, item]));
const WWSECURITY_KEY = 'wwsecurity';
const EXTERNAL_STORAGE_CACHE_RELATIVE = path.join('WXWork Files', 'Caches');
const EXTERNAL_SOURCE_BUILTIN = 'builtin';
const EXTERNAL_SOURCE_CONFIGURED = 'configured';
const EXTERNAL_SOURCE_AUTO = 'auto';
const EXTERNAL_STORAGE_SCAN_MAX_DEPTH_DEFAULT = 2;
const EXTERNAL_STORAGE_SCAN_MAX_VISITS_DEFAULT = 400;
const EXTERNAL_STORAGE_CACHE_TTL_MS_DEFAULT = 15_000;
const EXTERNAL_STORAGE_KNOWN_CATEGORY_DIRS = new Set(
  CACHE_CATEGORIES.map((item) => {
    const relativePath = String(item?.relativePath || '');
    if (!relativePath.startsWith('Caches/')) {
      return null;
    }
    const suffix = relativePath.slice('Caches/'.length);
    const [head] = suffix.split(/[\\/]+/).filter(Boolean);
    return head ? head.toLowerCase() : null;
  }).filter(Boolean)
);
const EXTERNAL_STORAGE_SCAN_SKIP_NAMES = new Set([
  '.',
  '..',
  'Library',
  'Applications',
  'Movies',
  'Music',
  'Pictures',
  'node_modules',
  '.Trash',
  '.Trashes',
  '.Spotlight-V100',
  '.fseventsd',
  '.TemporaryItems',
  '.DocumentRevisions-V100',
]);
const externalStorageDetectCache = new Map();

function parseBooleanEnv(rawValue, fallbackValue) {
  if (typeof rawValue !== 'string') {
    return fallbackValue;
  }
  const normalized = rawValue.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return fallbackValue;
}

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

async function listDirectoryEntries(targetPath) {
  try {
    return await fs.readdir(targetPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function listSubDirectories(targetPath) {
  const entries = await listDirectoryEntries(targetPath);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function listDirectFiles(targetPath) {
  const entries = await listDirectoryEntries(targetPath);
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

async function isDirectoryPath(targetPath) {
  const stat = await fs.stat(targetPath).catch(() => null);
  return Boolean(stat?.isDirectory());
}

async function detectExternalStorageMarkers(cacheRoot) {
  const entries = await listDirectoryEntries(cacheRoot);
  const categoryDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const knownCategoryDirs = categoryDirs.filter((name) =>
    EXTERNAL_STORAGE_KNOWN_CATEGORY_DIRS.has(name.toLowerCase())
  );

  let monthLikeCategoryCount = 0;
  for (const categoryName of knownCategoryDirs) {
    const childDirs = await listSubDirectories(path.join(cacheRoot, categoryName));
    if (childDirs.some((dirName) => normalizeMonthKey(dirName))) {
      monthLikeCategoryCount += 1;
    }
  }

  return {
    knownCategoryCount: knownCategoryDirs.length,
    monthLikeCategoryCount,
  };
}

async function isLikelyExternalStorageRoot(rootPath, options = {}) {
  const strictMarkers = options.strictMarkers === true;
  const cacheRoot = path.join(rootPath, EXTERNAL_STORAGE_CACHE_RELATIVE);
  if (!(await isDirectoryPath(cacheRoot))) {
    return false;
  }

  if (!strictMarkers) {
    return true;
  }

  const markers = await detectExternalStorageMarkers(cacheRoot);
  if (markers.monthLikeCategoryCount >= 1) {
    return true;
  }
  return markers.knownCategoryCount >= 2;
}

function normalizeExternalStorageRootCandidate(rawPath) {
  const input = String(rawPath || '').trim();
  if (!input) {
    return null;
  }
  const normalized = path.resolve(input);
  const lower = normalized.toLowerCase();
  const wxworkFilesSuffix = `${path.sep}wxwork files`;
  const cachesSuffix = `${wxworkFilesSuffix}${path.sep}caches`;

  if (lower.endsWith(cachesSuffix)) {
    return path.dirname(path.dirname(normalized));
  }
  if (lower.endsWith(wxworkFilesSuffix)) {
    return path.dirname(normalized);
  }
  return normalized;
}

async function resolveExternalStorageRoot(rawPath, options = {}) {
  const root = normalizeExternalStorageRootCandidate(rawPath);
  if (!root) {
    return null;
  }
  const likely = await isLikelyExternalStorageRoot(root, options);
  if (!likely) {
    return null;
  }
  return root;
}

function normalizeRootListForCache(rawList) {
  return [
    ...new Set(
      (rawList || [])
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .map((item) => path.resolve(item))
    ),
  ].sort();
}

function buildExternalDetectCacheKey(options = {}, resolvedAutoDetect = null) {
  const configuredRoots = normalizeRootListForCache(options.configuredRoots);
  const searchBaseRoots = normalizeRootListForCache(options.searchBaseRoots);
  const profilesRoot = String(options.profilesRoot || '').trim()
    ? path.resolve(String(options.profilesRoot || '').trim())
    : '';
  const autoDetect =
    typeof resolvedAutoDetect === 'boolean' ? resolvedAutoDetect : options.autoDetect !== false;
  const searchMaxDepth = Number(options.searchMaxDepth || EXTERNAL_STORAGE_SCAN_MAX_DEPTH_DEFAULT);
  const searchVisitLimit = Number(options.searchVisitLimit || EXTERNAL_STORAGE_SCAN_MAX_VISITS_DEFAULT);
  return JSON.stringify({
    configuredRoots,
    searchBaseRoots,
    profilesRoot,
    autoDetect,
    searchMaxDepth,
    searchVisitLimit,
  });
}

function collectBuiltInStorageRootCandidates(options = {}) {
  const candidates = [];
  const profilesRoot = String(options.profilesRoot || '').trim();
  if (profilesRoot) {
    const dataRoot = inferDataRootFromProfilesRoot(profilesRoot);
    if (dataRoot) {
      candidates.push(path.join(dataRoot, 'Documents'));
    }
  }
  return [...new Set(candidates.map((item) => path.resolve(item)))];
}

async function collectDefaultExternalSearchBaseRoots() {
  const bases = new Set();
  const home = os.homedir();
  bases.add(path.join(home, 'Documents'));

  const volumeEntries = await fs.readdir('/Volumes', { withFileTypes: true }).catch(() => []);
  for (const entry of volumeEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    bases.add(path.join('/Volumes', entry.name));
  }

  const resolved = [];
  for (const base of bases) {
    if (!base) {
      continue;
    }
    const ok = await isDirectoryPath(base);
    if (ok) {
      resolved.push(path.resolve(base));
    }
  }
  resolved.sort();
  return resolved;
}

function shouldSkipExternalScanDir(name) {
  if (!name) {
    return false;
  }
  if (name.startsWith('.')) {
    return true;
  }
  if (EXTERNAL_STORAGE_SCAN_SKIP_NAMES.has(name)) {
    return true;
  }
  return false;
}

async function findExternalStorageRootsByStructure(baseRoots, options = {}) {
  const maxDepth = Math.max(1, Number(options.searchMaxDepth || EXTERNAL_STORAGE_SCAN_MAX_DEPTH_DEFAULT));
  const visitLimit = Math.max(
    200,
    Number(options.searchVisitLimit || EXTERNAL_STORAGE_SCAN_MAX_VISITS_DEFAULT)
  );
  const uniqueBaseRoots = [
    ...new Set(
      (baseRoots || [])
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .map((item) => path.resolve(item))
    ),
  ];
  const found = new Set();
  const truncatedRoots = [];
  let searchedRootsCount = 0;
  let visitedDirs = 0;

  for (const baseRoot of uniqueBaseRoots) {
    const baseExists = await isDirectoryPath(baseRoot);
    if (!baseExists) {
      continue;
    }

    searchedRootsCount += 1;
    const queue = [{ dir: baseRoot, depth: 0 }];
    const visited = new Set();
    let visitCount = 0;

    while (queue.length > 0) {
      if (visitCount >= visitLimit) {
        truncatedRoots.push(baseRoot);
        break;
      }

      const current = queue.shift();
      if (!current) {
        continue;
      }
      const dir = current.dir;
      if (!dir || visited.has(dir)) {
        continue;
      }
      visited.add(dir);
      visitCount += 1;
      visitedDirs += 1;

      const markerPath = path.join(dir, EXTERNAL_STORAGE_CACHE_RELATIVE);
      if (await isDirectoryPath(markerPath)) {
        found.add(dir);
        continue;
      }

      if (current.depth >= maxDepth) {
        continue;
      }

      const entries = await listDirectoryEntries(dir);
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        if (shouldSkipExternalScanDir(entry.name)) {
          continue;
        }
        queue.push({
          dir: path.join(dir, entry.name),
          depth: current.depth + 1,
        });
      }
    }
  }

  const roots = [...found].sort();
  return {
    roots,
    meta: {
      searchedRootsCount,
      autoDetectedRootCount: roots.length,
      truncatedRoots,
      visitedDirs,
    },
  };
}

function resolveExternalCategoryRoot(externalStorageRoot, categoryRelativePath) {
  if (!String(categoryRelativePath || '').startsWith('Caches/')) {
    return null;
  }
  const suffix = categoryRelativePath.slice('Caches/'.length);
  return path.join(externalStorageRoot, EXTERNAL_STORAGE_CACHE_RELATIVE, suffix);
}

function wildcardSegmentToRegExp(segment) {
  const escaped = segment
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

async function resolveRelativePathMatches(basePath, relativePath) {
  const segments = String(relativePath || '')
    .split(/[\\/]+/)
    .filter(Boolean);
  if (segments.length === 0) {
    return [];
  }

  const results = [];

  async function walk(currentPath, index) {
    if (index >= segments.length) {
      const stat = await fs.stat(currentPath).catch(() => null);
      if (stat && (stat.isDirectory() || stat.isFile())) {
        results.push({ path: currentPath, stat });
      }
      return;
    }

    const segment = segments[index];
    const isLast = index === segments.length - 1;

    if (!segment.includes('*')) {
      const nextPath = path.join(currentPath, segment);
      const stat = await fs.stat(nextPath).catch(() => null);
      if (!stat) {
        return;
      }
      if (!isLast && !stat.isDirectory()) {
        return;
      }
      if (isLast && !stat.isDirectory() && !stat.isFile()) {
        return;
      }
      await walk(nextPath, index + 1);
      return;
    }

    const matcher = wildcardSegmentToRegExp(segment);
    const entries = await listDirectoryEntries(currentPath);
    for (const entry of entries) {
      if (!matcher.test(entry.name)) {
        continue;
      }
      if (!isLast && !entry.isDirectory()) {
        continue;
      }
      if (isLast && !entry.isDirectory() && !entry.isFile()) {
        continue;
      }
      await walk(path.join(currentPath, entry.name), index + 1);
    }
  }

  await walk(basePath, 0);

  const dedup = new Map();
  for (const item of results) {
    dedup.set(item.path, item);
  }
  return [...dedup.values()];
}

async function collectRecursiveDirectoryCandidates(rootPath, maxDepth = 2) {
  const candidates = [];
  const safeDepth = Math.max(1, Number(maxDepth || 1));

  async function walk(currentPath, depth) {
    const entries = await listDirectoryEntries(currentPath);
    const dirEntries = entries.filter((entry) => entry.isDirectory());
    if (dirEntries.length === 0) {
      if (currentPath !== rootPath) {
        candidates.push({
          name: path.relative(rootPath, currentPath),
          path: currentPath,
          isDirectory: true,
        });
      }
      return;
    }

    for (const entry of dirEntries) {
      const absPath = path.join(currentPath, entry.name);
      const nextDepth = depth + 1;
      if (nextDepth >= safeDepth) {
        candidates.push({
          name: path.relative(rootPath, absPath),
          path: absPath,
          isDirectory: true,
        });
        continue;
      }
      await walk(absPath, nextDepth);
    }
  }

  await walk(rootPath, 0);

  if (candidates.length === 0) {
    const topDirs = await listSubDirectories(rootPath);
    for (const name of topDirs) {
      candidates.push({
        name,
        path: path.join(rootPath, name),
        isDirectory: true,
      });
    }
  }

  return candidates;
}

async function collectCategoryDirectoryCandidates(categoryKey, rootPath) {
  if (categoryKey === WWSECURITY_KEY) {
    return collectRecursiveDirectoryCandidates(rootPath, 2);
  }
  const children = await listSubDirectories(rootPath);
  return children.map((name) => ({
    name,
    path: path.join(rootPath, name),
    isDirectory: true,
  }));
}

async function collectCategoryDirectFileCandidates(rootPath) {
  const files = await listDirectFiles(rootPath);
  return files.map((name) => ({
    name,
    path: path.join(rootPath, name),
    isDirectory: false,
  }));
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

async function calculateSizesByNode(candidates, sizeConcurrency, onProgress) {
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

async function calculateSizesWithEngine({ candidates, nativeCorePath, sizeConcurrency = 4, onProgress }) {
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
    await calculateSizesByNode(candidates, sizeConcurrency, onProgress);
  }

  return { engineUsed, nativeFallbackReason };
}

export async function detectExternalStorageRoots(options = {}) {
  const configuredRoots = Array.isArray(options.configuredRoots) ? options.configuredRoots : [];
  const builtInCandidates = collectBuiltInStorageRootCandidates(options);
  const autoDetect =
    typeof options.autoDetect === 'boolean'
      ? options.autoDetect
      : parseBooleanEnv(process.env.WECOM_CLEANER_EXTERNAL_AUTO_DETECT, true);
  const returnMeta = options.returnMeta === true;
  const cacheKey = buildExternalDetectCacheKey(options, autoDetect);
  const cacheTtlMs = Math.max(0, Number(options.cacheTtlMs || EXTERNAL_STORAGE_CACHE_TTL_MS_DEFAULT));
  if (cacheTtlMs > 0) {
    const cached = externalStorageDetectCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      if (returnMeta) {
        return {
          roots: [...cached.roots],
          meta: {
            ...(cached.meta || {}),
            fromCache: true,
          },
        };
      }
      return [...cached.roots];
    }
  }

  const resolved = [];
  const seen = new Set();
  const sourceByRoot = new Map();
  let autoDetectMeta = {
    searchedRootsCount: 0,
    autoDetectedRootCount: 0,
    truncatedRoots: [],
    visitedDirs: 0,
    autoRejectedRootCount: 0,
  };

  for (const candidate of builtInCandidates) {
    const root = await resolveExternalStorageRoot(candidate, { strictMarkers: true });
    if (!root || seen.has(root)) {
      continue;
    }
    seen.add(root);
    resolved.push(root);
    sourceByRoot.set(root, EXTERNAL_SOURCE_BUILTIN);
  }

  for (const candidate of configuredRoots) {
    const root = await resolveExternalStorageRoot(candidate, { strictMarkers: false });
    if (!root || seen.has(root)) {
      continue;
    }
    seen.add(root);
    resolved.push(root);
    sourceByRoot.set(root, EXTERNAL_SOURCE_CONFIGURED);
  }

  if (autoDetect) {
    const baseRoots =
      Array.isArray(options.searchBaseRoots) && options.searchBaseRoots.length > 0
        ? options.searchBaseRoots
        : await collectDefaultExternalSearchBaseRoots();
    const autoScan = await findExternalStorageRootsByStructure(baseRoots, options);
    autoDetectMeta = {
      ...autoScan.meta,
      autoRejectedRootCount: 0,
    };
    for (const root of autoScan.roots) {
      const normalized = await resolveExternalStorageRoot(root, { strictMarkers: true });
      if (!normalized || seen.has(normalized)) {
        if (!normalized) {
          autoDetectMeta.autoRejectedRootCount += 1;
        }
        continue;
      }
      seen.add(normalized);
      resolved.push(normalized);
      sourceByRoot.set(normalized, EXTERNAL_SOURCE_AUTO);
    }
    autoDetectMeta.autoDetectedRootCount = Math.max(
      0,
      autoScan.roots.length - autoDetectMeta.autoRejectedRootCount
    );
  }

  resolved.sort();
  const rootSources = Object.fromEntries(
    resolved.map((item) => [item, sourceByRoot.get(item) || EXTERNAL_SOURCE_AUTO])
  );
  const sourceCounts = {
    [EXTERNAL_SOURCE_BUILTIN]: 0,
    [EXTERNAL_SOURCE_CONFIGURED]: 0,
    [EXTERNAL_SOURCE_AUTO]: 0,
  };
  for (const source of Object.values(rootSources)) {
    if (source === EXTERNAL_SOURCE_BUILTIN) {
      sourceCounts[EXTERNAL_SOURCE_BUILTIN] += 1;
      continue;
    }
    if (source === EXTERNAL_SOURCE_CONFIGURED) {
      sourceCounts[EXTERNAL_SOURCE_CONFIGURED] += 1;
      continue;
    }
    sourceCounts[EXTERNAL_SOURCE_AUTO] += 1;
  }

  const meta = {
    searchedRootsCount: autoDetectMeta.searchedRootsCount,
    autoDetectedRootCount: autoDetectMeta.autoDetectedRootCount,
    autoRejectedRootCount: autoDetectMeta.autoRejectedRootCount,
    truncatedRoots: autoDetectMeta.truncatedRoots,
    visitedDirs: autoDetectMeta.visitedDirs,
    resolvedRootCount: resolved.length,
    rootSources,
    sourceCounts,
    fromCache: false,
  };

  if (cacheTtlMs > 0) {
    externalStorageDetectCache.set(cacheKey, {
      roots: [...resolved],
      meta,
      expiresAt: Date.now() + cacheTtlMs,
    });
    if (externalStorageDetectCache.size > 32) {
      externalStorageDetectCache.clear();
    }
  }

  if (returnMeta) {
    return {
      roots: [...resolved],
      meta,
    };
  }
  return resolved;
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

export async function collectAvailableMonths(
  accounts,
  selectedAccountIds,
  categoryKeys,
  externalStorageRoots = []
) {
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
      const children = await collectCategoryDirectoryCandidates(key, categoryPath);
      for (const child of children) {
        const monthKey = normalizeMonthKey(path.basename(child.name));
        if (monthKey) {
          months.push(monthKey);
        }
      }
    }
  }

  for (const externalRoot of externalStorageRoots || []) {
    for (const key of categoryKeys) {
      const category = CATEGORY_BY_KEY.get(key);
      if (!category) {
        continue;
      }
      const categoryPath = resolveExternalCategoryRoot(externalRoot, category.relativePath);
      if (!categoryPath) {
        continue;
      }
      const children = await collectCategoryDirectoryCandidates(key, categoryPath);
      for (const child of children) {
        const monthKey = normalizeMonthKey(path.basename(child.name));
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
  externalStorageRoots = [],
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
      const dirCandidates = await collectCategoryDirectoryCandidates(key, rootPath);

      for (const child of dirCandidates) {
        const monthKey = normalizeMonthKey(path.basename(child.name));
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
          directoryName: child.name,
          path: child.path,
          isDirectory: child.isDirectory,
          sizeBytes: 0,
        });
      }

      if (includeNonMonthDirs) {
        const fileCandidates = await collectCategoryDirectFileCandidates(rootPath);
        for (const file of fileCandidates) {
          candidates.push({
            accountId: account.id,
            accountShortId: account.shortId,
            userName: account.userName,
            corpName: account.corpName,
            accountPath: account.profilePath,
            categoryKey: key,
            categoryLabel: category.label,
            categoryPath: category.relativePath,
            monthKey: null,
            isMonthDir: false,
            directoryName: file.name,
            path: file.path,
            isDirectory: false,
            sizeBytes: 0,
          });
        }
      }
    }
  }

  for (const externalRoot of externalStorageRoots || []) {
    const externalLabel = `外部存储(${path.basename(externalRoot) || 'WXWork_Data'})`;
    const externalId = `external:${externalRoot}`;

    for (const key of categoryKeys) {
      const category = CATEGORY_BY_KEY.get(key);
      if (!category) {
        continue;
      }

      const rootPath = resolveExternalCategoryRoot(externalRoot, category.relativePath);
      if (!rootPath) {
        continue;
      }

      const dirCandidates = await collectCategoryDirectoryCandidates(key, rootPath);
      for (const child of dirCandidates) {
        const monthKey = normalizeMonthKey(path.basename(child.name));
        const isMonthDir = Boolean(monthKey);

        const includeMonth = isMonthDir && (!monthSet || monthSet.has(monthKey));
        const includeNonMonth = !isMonthDir && Boolean(includeNonMonthDirs);

        if (!includeMonth && !includeNonMonth) {
          continue;
        }

        candidates.push({
          accountId: externalId,
          accountShortId: '外部存储',
          userName: externalLabel,
          corpName: externalRoot,
          accountPath: externalRoot,
          categoryKey: key,
          categoryLabel: `${category.label}(外部)`,
          categoryPath: path.relative(externalRoot, rootPath) || rootPath,
          monthKey: monthKey || null,
          isMonthDir,
          directoryName: child.name,
          path: child.path,
          isDirectory: child.isDirectory,
          sizeBytes: 0,
          externalStorageRoot: externalRoot,
          isExternalStorage: true,
        });
      }

      if (includeNonMonthDirs) {
        const fileCandidates = await collectCategoryDirectFileCandidates(rootPath);
        for (const file of fileCandidates) {
          candidates.push({
            accountId: externalId,
            accountShortId: '外部存储',
            userName: externalLabel,
            corpName: externalRoot,
            accountPath: externalRoot,
            categoryKey: key,
            categoryLabel: `${category.label}(外部)`,
            categoryPath: path.relative(externalRoot, rootPath) || rootPath,
            monthKey: null,
            isMonthDir: false,
            directoryName: file.name,
            path: file.path,
            isDirectory: false,
            sizeBytes: 0,
            externalStorageRoot: externalRoot,
            isExternalStorage: true,
          });
        }
      }
    }
  }

  const { engineUsed, nativeFallbackReason } = await calculateSizesWithEngine({
    candidates,
    nativeCorePath,
    sizeConcurrency,
    onProgress,
  });

  candidates.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return {
    targets: candidates,
    engineUsed,
    nativeFallbackReason,
  };
}

export async function scanSpaceGovernanceTargets({
  accounts,
  selectedAccountIds,
  rootDir,
  externalStorageRoots = [],
  nativeCorePath,
  autoSuggest = {},
  sizeConcurrency = 4,
  onProgress,
}) {
  const dataRoot = inferDataRootFromProfilesRoot(rootDir);
  const selectedSet = new Set(selectedAccountIds || []);
  const activeAccounts =
    selectedSet.size > 0 ? accounts.filter((account) => selectedSet.has(account.id)) : [...accounts];

  const candidates = [];

  for (const target of SPACE_GOVERNANCE_TARGETS) {
    if (target.scope === 'profile') {
      for (const account of activeAccounts) {
        const matches = await resolveRelativePathMatches(account.profilePath, target.relativePath);
        for (const matched of matches) {
          const absPath = matched.path;
          const relPath = path.relative(account.profilePath, absPath) || target.relativePath;
          const idSuffix = relPath.replace(/[\\/]/g, '|');

          candidates.push({
            id: `${target.key}:${account.id}:${idSuffix}`,
            scope: 'space_governance',
            path: absPath,
            directoryName: path.basename(absPath),
            sizeBytes: 0,
            mtimeMs: matched.stat?.mtimeMs || 0,
            targetKey: target.key,
            targetLabel: target.label,
            targetDesc: target.desc,
            tier: target.tier,
            deletable: target.deletable !== false && target.tier !== SPACE_GOVERNANCE_TIERS.PROTECTED,
            accountId: account.id,
            accountShortId: account.shortId,
            userName: account.userName,
            corpName: account.corpName,
            accountPath: account.profilePath,
            categoryKey: target.key,
            categoryLabel: target.label,
            monthKey: null,
            categoryPath: relPath,
          });
        }
      }
      continue;
    }

    if (!dataRoot) {
      continue;
    }
    const matches = await resolveRelativePathMatches(dataRoot, target.relativePath);
    for (const matched of matches) {
      const absPath = matched.path;
      const relPath = path.relative(dataRoot, absPath) || target.relativePath;
      const idSuffix = relPath.replace(/[\\/]/g, '|');

      candidates.push({
        id: `${target.key}:global:${idSuffix}`,
        scope: 'space_governance',
        path: absPath,
        directoryName: path.basename(absPath),
        sizeBytes: 0,
        mtimeMs: matched.stat?.mtimeMs || 0,
        targetKey: target.key,
        targetLabel: target.label,
        targetDesc: target.desc,
        tier: target.tier,
        deletable: target.deletable !== false && target.tier !== SPACE_GOVERNANCE_TIERS.PROTECTED,
        accountId: null,
        accountShortId: '-',
        userName: '全局',
        corpName: '-',
        accountPath: dataRoot,
        categoryKey: target.key,
        categoryLabel: target.label,
        monthKey: null,
        categoryPath: relPath,
      });
    }
  }

  for (const externalRoot of externalStorageRoots || []) {
    const cacheRoot = path.join(externalRoot, EXTERNAL_STORAGE_CACHE_RELATIVE);
    const stat = await fs.stat(cacheRoot).catch(() => null);
    if (!stat || !stat.isDirectory()) {
      continue;
    }

    const relPath = path.relative(externalRoot, cacheRoot) || cacheRoot;
    const idSuffix = `${externalRoot}:${relPath}`.replace(/[\\/]/g, '|');
    const labelSuffix = path.basename(externalRoot) || 'WXWork_Data';

    candidates.push({
      id: `external_wxwork_files_caches:global:${idSuffix}`,
      scope: 'space_governance',
      path: cacheRoot,
      directoryName: path.basename(cacheRoot),
      sizeBytes: 0,
      mtimeMs: stat.mtimeMs || 0,
      targetKey: 'external_wxwork_files_caches',
      targetLabel: `外部文件缓存目录(${labelSuffix})`,
      targetDesc: '企业微信外部文件存储缓存目录，清理后可按需重新下载。',
      tier: SPACE_GOVERNANCE_TIERS.CAUTION,
      deletable: true,
      accountId: null,
      accountShortId: '外部存储',
      userName: '外部存储',
      corpName: externalRoot,
      accountPath: externalRoot,
      categoryKey: 'external_wxwork_files_caches',
      categoryLabel: `外部文件缓存目录(${labelSuffix})`,
      monthKey: null,
      categoryPath: relPath,
      externalStorageRoot: externalRoot,
      isExternalStorage: true,
    });
  }

  const sizeResult = await calculateSizesWithEngine({
    candidates,
    nativeCorePath,
    sizeConcurrency,
    onProgress,
  });

  const suggestSizeThresholdMB = Number(autoSuggest.sizeThresholdMB || 512);
  const suggestIdleDays = Number(autoSuggest.idleDays || 7);
  const suggestSizeThresholdBytes = Math.max(1, suggestSizeThresholdMB) * 1024 * 1024;
  const suggestIdleMs = Math.max(1, suggestIdleDays) * 24 * 3600 * 1000;
  const now = Date.now();

  for (const target of candidates) {
    const idleMs = Math.max(0, now - Number(target.mtimeMs || 0));
    const idleDays = idleMs / (24 * 3600 * 1000);
    const recentlyActive = idleMs < suggestIdleMs;
    const suggested =
      target.deletable &&
      target.sizeBytes >= suggestSizeThresholdBytes &&
      !recentlyActive &&
      target.tier !== SPACE_GOVERNANCE_TIERS.PROTECTED;

    target.idleDays = idleDays;
    target.recentlyActive = recentlyActive;
    target.suggested = suggested;
  }

  candidates.sort((a, b) => b.sizeBytes - a.sizeBytes);

  let totalBytes = 0;
  const byTierMap = new Map();
  for (const target of candidates) {
    totalBytes += target.sizeBytes;
    const tier = target.tier;
    if (!byTierMap.has(tier)) {
      byTierMap.set(tier, {
        tier,
        count: 0,
        sizeBytes: 0,
        suggestedCount: 0,
      });
    }
    const row = byTierMap.get(tier);
    row.count += 1;
    row.sizeBytes += target.sizeBytes;
    row.suggestedCount += target.suggested ? 1 : 0;
  }

  return {
    targets: candidates,
    totalBytes,
    byTier: [...byTierMap.values()],
    dataRoot,
    suggestSizeThresholdMB,
    suggestIdleDays,
    engineUsed: sizeResult.engineUsed,
    nativeFallbackReason: sizeResult.nativeFallbackReason,
  };
}

export async function analyzeCacheFootprint({
  accounts,
  selectedAccountIds,
  categoryKeys,
  externalStorageRoots = [],
  nativeCorePath,
  onProgress,
}) {
  const scan = await collectCleanupTargets({
    accounts,
    selectedAccountIds,
    categoryKeys,
    monthFilters: [],
    includeNonMonthDirs: true,
    externalStorageRoots,
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
