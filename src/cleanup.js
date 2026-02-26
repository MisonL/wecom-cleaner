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

  return summary;
}
