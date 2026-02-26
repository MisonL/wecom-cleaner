import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { appendJsonLine, ensureDir, pathExists } from './utils.js';
import { classifyErrorType, ERROR_TYPES } from './error-taxonomy.js';

function generateBatchId() {
  const date = new Date();
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const rand = crypto.randomBytes(3).toString('hex');
  return `${y}${m}${d}-${hh}${mm}${ss}-${rand}`;
}

async function movePath(src, dest) {
  await ensureDir(path.dirname(dest));
  try {
    await fs.rename(src, dest);
    return;
  } catch (error) {
    if (error?.code !== 'EXDEV') {
      throw error;
    }
  }

  await fs.cp(src, dest, { recursive: true, force: true });
  await fs.rm(src, { recursive: true, force: true });
}

function escapePathForName(srcPath) {
  const base = path.basename(srcPath).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base || 'unknown';
}

function resolveCleanupTargetRoot(target = {}) {
  const accountPath = String(target.accountPath || '').trim();
  const categoryPath = String(target.categoryPath || '').trim();
  if (accountPath && categoryPath) {
    return path.resolve(accountPath, categoryPath);
  }
  if (accountPath) {
    return path.resolve(accountPath);
  }
  if (target.path) {
    return path.dirname(path.resolve(target.path));
  }
  return null;
}

function createBreakdownRow(seed = {}) {
  return {
    ...seed,
    totalCount: 0,
    totalBytes: 0,
    successCount: 0,
    successBytes: 0,
    skippedCount: 0,
    skippedBytes: 0,
    failedCount: 0,
    failedBytes: 0,
    dryRunCount: 0,
    dryRunBytes: 0,
  };
}

function applyBreakdownStatus(row, statusKey, sizeBytes) {
  const bytes = Number(sizeBytes || 0);
  row.totalCount += 1;
  row.totalBytes += bytes;
  if (statusKey === 'success') {
    row.successCount += 1;
    row.successBytes += bytes;
    return;
  }
  if (statusKey === 'skipped') {
    row.skippedCount += 1;
    row.skippedBytes += bytes;
    return;
  }
  if (statusKey === 'failed') {
    row.failedCount += 1;
    row.failedBytes += bytes;
    return;
  }
  row.dryRunCount += 1;
  row.dryRunBytes += bytes;
}

function pushTopPathSample(samples, sample, limit = 20) {
  samples.push(sample);
  samples.sort((a, b) => Number(b.sizeBytes || 0) - Number(a.sizeBytes || 0));
  if (samples.length > limit) {
    samples.length = limit;
  }
}

function createCleanupBreakdownTracker(topPathLimit = 20) {
  return {
    byCategory: new Map(),
    byMonth: new Map(),
    byRoot: new Map(),
    status: {
      success: { count: 0, bytes: 0 },
      skipped: { count: 0, bytes: 0 },
      failed: { count: 0, bytes: 0 },
      dryRun: { count: 0, bytes: 0 },
    },
    topPaths: [],
    topPathLimit,
  };
}

function updateCleanupBreakdown(tracker, target, statusKey, statusLabel) {
  const bytes = Number(target?.sizeBytes || 0);

  if (!tracker.status[statusKey]) {
    tracker.status[statusKey] = { count: 0, bytes: 0 };
  }
  tracker.status[statusKey].count += 1;
  tracker.status[statusKey].bytes += bytes;

  const categoryKey = String(target?.categoryKey || 'unknown');
  if (!tracker.byCategory.has(categoryKey)) {
    tracker.byCategory.set(
      categoryKey,
      createBreakdownRow({
        categoryKey,
        categoryLabel: target?.categoryLabel || categoryKey,
      })
    );
  }
  applyBreakdownStatus(tracker.byCategory.get(categoryKey), statusKey, bytes);

  const monthKey = String(target?.monthKey || '非月份目录');
  if (!tracker.byMonth.has(monthKey)) {
    tracker.byMonth.set(monthKey, createBreakdownRow({ monthKey }));
  }
  applyBreakdownStatus(tracker.byMonth.get(monthKey), statusKey, bytes);

  const rootPath = resolveCleanupTargetRoot(target);
  const rootKey = rootPath || '(unknown)';
  if (!tracker.byRoot.has(rootKey)) {
    tracker.byRoot.set(
      rootKey,
      createBreakdownRow({
        rootPath: rootPath || null,
        rootType: target?.isExternalStorage ? 'external' : 'profile',
      })
    );
  }
  applyBreakdownStatus(tracker.byRoot.get(rootKey), statusKey, bytes);

  pushTopPathSample(
    tracker.topPaths,
    {
      path: target?.path || null,
      sizeBytes: bytes,
      status: statusLabel,
      categoryKey,
      categoryLabel: target?.categoryLabel || categoryKey,
      monthKey: target?.monthKey || null,
      accountShortId: target?.accountShortId || null,
      isExternalStorage: Boolean(target?.isExternalStorage),
    },
    tracker.topPathLimit
  );
}

function sortBreakdownRowsByBytes(rows = []) {
  return [...rows].sort((a, b) => {
    const bytesDiff = Number(b.totalBytes || 0) - Number(a.totalBytes || 0);
    if (bytesDiff !== 0) {
      return bytesDiff;
    }
    return Number(b.totalCount || 0) - Number(a.totalCount || 0);
  });
}

function sortMonthBreakdownRows(rows = []) {
  const nonMonthKey = '非月份目录';
  return [...rows].sort((a, b) => {
    const aMonth = String(a.monthKey || nonMonthKey);
    const bMonth = String(b.monthKey || nonMonthKey);
    if (aMonth === nonMonthKey && bMonth !== nonMonthKey) {
      return 1;
    }
    if (aMonth !== nonMonthKey && bMonth === nonMonthKey) {
      return -1;
    }
    if (aMonth === bMonth) {
      return Number(b.totalBytes || 0) - Number(a.totalBytes || 0);
    }
    return aMonth.localeCompare(bMonth);
  });
}

function finalizeCleanupBreakdown(tracker) {
  return {
    byStatus: tracker.status,
    byCategory: sortBreakdownRowsByBytes([...tracker.byCategory.values()]),
    byMonth: sortMonthBreakdownRows([...tracker.byMonth.values()]),
    byRoot: sortBreakdownRowsByBytes([...tracker.byRoot.values()]),
    topPaths: [...tracker.topPaths],
  };
}

function normalizeRootList(rootPaths) {
  return [
    ...new Set(
      (rootPaths || [])
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .map((item) => path.resolve(item))
    ),
  ];
}

function isPathWithinRoot(rootPath, targetPath) {
  const rootAbs = path.resolve(rootPath);
  const targetAbs = path.resolve(targetPath);
  const rel = path.relative(rootAbs, targetAbs);
  if (!rel) {
    return true;
  }
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isPathWithinAnyRoot(rootPaths, targetPath) {
  for (const rootPath of rootPaths || []) {
    if (!rootPath) {
      continue;
    }
    if (isPathWithinRoot(rootPath, targetPath)) {
      return true;
    }
  }
  return false;
}

async function safeRealpath(targetPath) {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return null;
  }
}

async function resolveExistingAncestorRealpath(targetPathAbs) {
  let current = path.resolve(targetPathAbs);
  while (true) {
    const real = await safeRealpath(current);
    if (real) {
      return {
        ancestorPath: current,
        ancestorRealPath: real,
      };
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function resolvePathForBoundaryCheck(targetPath) {
  const targetAbs = path.resolve(targetPath);
  const stat = await fs.lstat(targetAbs).catch(() => null);
  if (stat) {
    const targetReal = await safeRealpath(targetAbs);
    if (!targetReal) {
      return {
        ok: false,
      };
    }
    return {
      ok: true,
      resolvedPath: targetReal,
    };
  }

  const ancestor = await resolveExistingAncestorRealpath(targetAbs);
  if (!ancestor) {
    return {
      ok: false,
    };
  }

  const rel = path.relative(ancestor.ancestorPath, targetAbs);
  return {
    ok: true,
    resolvedPath: path.resolve(ancestor.ancestorRealPath, rel || '.'),
  };
}

function isPathWithinResolvedRoot(rootPathResolved, targetPathResolved) {
  const rel = path.relative(rootPathResolved, targetPathResolved);
  if (!rel) {
    return true;
  }
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function isPathWithinAnyResolvedRoot(rootPathsResolved, targetPathResolved) {
  for (const rootPathResolved of rootPathsResolved || []) {
    if (!rootPathResolved) {
      continue;
    }
    if (isPathWithinResolvedRoot(rootPathResolved, targetPathResolved)) {
      return true;
    }
  }
  return false;
}

async function resolveRootsRealpath(rootPaths) {
  const resolved = [];
  for (const rootPath of normalizeRootList(rootPaths)) {
    const real = await safeRealpath(rootPath);
    if (!real) {
      continue;
    }
    resolved.push(real);
  }
  return [...new Set(resolved)];
}

async function buildCleanupValidationState(allowedRoots) {
  const allowedRootsRaw = normalizeRootList(allowedRoots);
  const allowedRootsReal = await resolveRootsRealpath(allowedRootsRaw);
  return {
    allowedRootsRaw,
    allowedRootsReal,
  };
}

async function validateCleanupTargetPath(targetPath, validationState) {
  if (!validationState || !Array.isArray(validationState.allowedRootsRaw)) {
    return 'missing_allowed_root';
  }
  if (validationState.allowedRootsReal.length === 0) {
    return 'missing_allowed_root';
  }

  const sourceChecked = await resolvePathForBoundaryCheck(targetPath);
  if (!sourceChecked.ok) {
    return 'source_path_unresolvable';
  }

  const sourceInside = isPathWithinAnyResolvedRoot(
    validationState.allowedRootsReal,
    sourceChecked.resolvedPath
  );
  if (sourceInside) {
    return null;
  }

  const rawInside = isPathWithinAnyRoot(validationState.allowedRootsRaw, targetPath);
  if (rawInside) {
    return 'source_symlink_escape';
  }
  return 'source_outside_allowed_root';
}

export async function executeCleanup({
  targets,
  recycleRoot,
  indexPath,
  dryRun,
  allowedRoots = [],
  scope = 'cleanup_monthly',
  shouldSkip,
  onProgress,
}) {
  const batchId = generateBatchId();
  const batchRoot = dryRun ? null : path.join(recycleRoot, batchId);
  if (batchRoot) {
    await ensureDir(batchRoot);
  }

  const summary = {
    batchId,
    dryRun: Boolean(dryRun),
    successCount: 0,
    skippedCount: 0,
    failedCount: 0,
    reclaimedBytes: 0,
    errors: [],
  };
  const validationState = await buildCleanupValidationState(allowedRoots);
  const breakdownTracker = createCleanupBreakdownTracker();

  const total = targets.length;

  for (let i = 0; i < total; i += 1) {
    const target = targets[i];
    if (typeof onProgress === 'function') {
      onProgress(i + 1, total);
    }

    let skipByPolicy = null;
    if (typeof shouldSkip === 'function') {
      skipByPolicy = await shouldSkip(target);
    }
    if (typeof skipByPolicy === 'string' && skipByPolicy) {
      summary.skippedCount += 1;
      updateCleanupBreakdown(breakdownTracker, target, 'skipped', skipByPolicy);
      await appendJsonLine(indexPath, {
        action: 'cleanup',
        time: Date.now(),
        scope,
        batchId,
        sourcePath: target.path,
        recyclePath: null,
        accountId: target.accountId,
        accountShortId: target.accountShortId,
        userName: target.userName,
        corpName: target.corpName,
        categoryKey: target.categoryKey,
        categoryLabel: target.categoryLabel,
        monthKey: target.monthKey,
        sizeBytes: target.sizeBytes,
        targetKey: target.targetKey || null,
        tier: target.tier || null,
        status: skipByPolicy,
        error_type: ERROR_TYPES.POLICY_SKIPPED,
        dryRun: Boolean(dryRun),
      });
      continue;
    }

    const exists = await pathExists(target.path);
    if (!exists) {
      summary.skippedCount += 1;
      updateCleanupBreakdown(breakdownTracker, target, 'skipped', 'skipped_missing_source');
      await appendJsonLine(indexPath, {
        action: 'cleanup',
        time: Date.now(),
        scope,
        batchId,
        sourcePath: target.path,
        recyclePath: null,
        accountId: target.accountId,
        accountShortId: target.accountShortId,
        userName: target.userName,
        corpName: target.corpName,
        categoryKey: target.categoryKey,
        categoryLabel: target.categoryLabel,
        monthKey: target.monthKey,
        sizeBytes: target.sizeBytes,
        targetKey: target.targetKey || null,
        tier: target.tier || null,
        status: 'skipped_missing_source',
        error_type: ERROR_TYPES.PATH_NOT_FOUND,
        dryRun: Boolean(dryRun),
      });
      continue;
    }

    const invalidPathReason = await validateCleanupTargetPath(target.path, validationState);
    if (invalidPathReason) {
      summary.skippedCount += 1;
      updateCleanupBreakdown(breakdownTracker, target, 'skipped', 'skipped_invalid_path');
      await appendJsonLine(indexPath, {
        action: 'cleanup',
        time: Date.now(),
        scope,
        batchId,
        sourcePath: target.path,
        recyclePath: null,
        accountId: target.accountId,
        accountShortId: target.accountShortId,
        userName: target.userName,
        corpName: target.corpName,
        categoryKey: target.categoryKey,
        categoryLabel: target.categoryLabel,
        monthKey: target.monthKey,
        sizeBytes: target.sizeBytes,
        targetKey: target.targetKey || null,
        tier: target.tier || null,
        status: 'skipped_invalid_path',
        error_type: ERROR_TYPES.PATH_VALIDATION_FAILED,
        invalid_reason: invalidPathReason,
        allowed_roots: validationState.allowedRootsRaw,
        dryRun: Boolean(dryRun),
      });
      continue;
    }

    if (dryRun) {
      summary.successCount += 1;
      summary.reclaimedBytes += target.sizeBytes;
      updateCleanupBreakdown(breakdownTracker, target, 'dryRun', 'dry_run');
      await appendJsonLine(indexPath, {
        action: 'cleanup',
        time: Date.now(),
        scope,
        batchId,
        sourcePath: target.path,
        recyclePath: null,
        accountId: target.accountId,
        accountShortId: target.accountShortId,
        userName: target.userName,
        corpName: target.corpName,
        categoryKey: target.categoryKey,
        categoryLabel: target.categoryLabel,
        monthKey: target.monthKey,
        sizeBytes: target.sizeBytes,
        targetKey: target.targetKey || null,
        tier: target.tier || null,
        status: 'dry_run',
        dryRun: true,
      });
      continue;
    }

    const destName = `${String(i + 1).padStart(4, '0')}_${escapePathForName(target.path)}`;
    const recyclePath = path.join(batchRoot, destName);

    try {
      await movePath(target.path, recyclePath);
      summary.successCount += 1;
      summary.reclaimedBytes += target.sizeBytes;
      updateCleanupBreakdown(breakdownTracker, target, 'success', 'success');

      const now = Date.now();
      await appendJsonLine(indexPath, {
        action: 'cleanup',
        time: now,
        scope,
        batchId,
        sourcePath: target.path,
        recyclePath,
        accountId: target.accountId,
        accountShortId: target.accountShortId,
        userName: target.userName,
        corpName: target.corpName,
        categoryKey: target.categoryKey,
        categoryLabel: target.categoryLabel,
        monthKey: target.monthKey,
        sizeBytes: target.sizeBytes,
        targetKey: target.targetKey || null,
        tier: target.tier || null,
        status: 'success',
        dryRun: false,
      });
    } catch (error) {
      summary.failedCount += 1;
      const message = error instanceof Error ? error.message : String(error);
      summary.errors.push({
        path: target.path,
        message,
      });
      updateCleanupBreakdown(breakdownTracker, target, 'failed', 'failed');
      await appendJsonLine(indexPath, {
        action: 'cleanup',
        time: Date.now(),
        scope,
        batchId,
        sourcePath: target.path,
        recyclePath,
        accountId: target.accountId,
        accountShortId: target.accountShortId,
        userName: target.userName,
        corpName: target.corpName,
        categoryKey: target.categoryKey,
        categoryLabel: target.categoryLabel,
        monthKey: target.monthKey,
        sizeBytes: target.sizeBytes,
        targetKey: target.targetKey || null,
        tier: target.tier || null,
        status: 'failed',
        error_type: classifyErrorType(message),
        dryRun: false,
        error: message,
      });
    }
  }

  summary.breakdown = finalizeCleanupBreakdown(breakdownTracker);
  return summary;
}
