import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { appendJsonLine, ensureDir, pathExists } from './utils.js';
import { classifyErrorType, ERROR_TYPES } from './error-taxonomy.js';

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

async function removePath(targetPath) {
  await fs.rm(targetPath, { recursive: true, force: true });
}

function buildRenameTarget(originalPath) {
  const ts = Date.now();
  return `${originalPath}.restored-${ts}`;
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
  for (const rootPath of rootPaths) {
    if (!rootPath) {
      continue;
    }
    if (isPathWithinRoot(rootPath, targetPath)) {
      return true;
    }
  }
  return false;
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
        reason: 'realpath_failed',
      };
    }
    return {
      ok: true,
      resolvedPath: targetReal,
      source: 'existing',
    };
  }

  const ancestor = await resolveExistingAncestorRealpath(targetAbs);
  if (!ancestor) {
    return {
      ok: false,
      reason: 'missing_existing_ancestor',
    };
  }

  const rel = path.relative(ancestor.ancestorPath, targetAbs);
  return {
    ok: true,
    resolvedPath: path.resolve(ancestor.ancestorRealPath, rel || '.'),
    source: 'ancestor',
  };
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

async function buildRestoreValidationState({
  profileRoot,
  extraProfileRoots,
  recycleRoot,
  governanceRoot,
  extraGovernanceRoots,
}) {
  const profileRootsRaw = normalizeRootList([profileRoot, ...(extraProfileRoots || [])]);
  const governanceRootsRaw = normalizeRootList([governanceRoot, ...(extraGovernanceRoots || [])]);
  const recycleRootRaw = normalizeRootList([recycleRoot])[0] || null;

  const [profileRootsReal, governanceRootsReal, recycleRootReal] = await Promise.all([
    resolveRootsRealpath(profileRootsRaw),
    resolveRootsRealpath(governanceRootsRaw),
    recycleRootRaw ? safeRealpath(recycleRootRaw) : Promise.resolve(null),
  ]);

  return {
    profileRootsRaw,
    governanceRootsRaw,
    recycleRootRaw,
    profileRootsReal,
    governanceRootsReal,
    recycleRootReal,
  };
}

async function streamJsonRows(filePath, onRow) {
  const exists = await pathExists(filePath);
  if (!exists) {
    return;
  }

  const input = createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      const text = String(line || '').trim();
      if (!text) {
        continue;
      }
      try {
        const row = JSON.parse(text);
        await onRow(row);
      } catch {
        // 忽略损坏的 JSONL 行，继续处理后续记录
      }
    }
  } catch {
    // 忽略流读取异常，交由上层根据结果做兜底
  } finally {
    rl.close();
    input.close();
  }
}

async function validateRestoreEntryPath({ originalPath, recyclePath, scope, validationState }) {
  if (typeof originalPath !== 'string' || typeof recyclePath !== 'string' || !originalPath || !recyclePath) {
    return 'invalid_path_record';
  }

  if (validationState.recycleRootRaw) {
    if (!validationState.recycleRootReal) {
      return 'missing_recycle_root';
    }

    const recycleChecked = await resolvePathForBoundaryCheck(recyclePath);
    if (!recycleChecked.ok) {
      return 'recycle_path_unresolvable';
    }

    const recycleInside = isPathWithinResolvedRoot(
      validationState.recycleRootReal,
      recycleChecked.resolvedPath
    );
    if (!recycleInside) {
      const rawInside = isPathWithinRoot(validationState.recycleRootRaw, recyclePath);
      return rawInside ? 'recycle_symlink_escape' : 'recycle_outside_recycle_root';
    }
  }

  const governanceScope = scope === 'space_governance';
  const sourceRootsRaw = governanceScope
    ? validationState.governanceRootsRaw
    : validationState.profileRootsRaw;
  const sourceRootsReal = governanceScope
    ? validationState.governanceRootsReal
    : validationState.profileRootsReal;
  if (sourceRootsReal.length === 0) {
    return 'missing_allowed_root';
  }

  const sourceChecked = await resolvePathForBoundaryCheck(originalPath);
  if (!sourceChecked.ok) {
    return 'source_path_unresolvable';
  }

  const sourceInside = isPathWithinAnyResolvedRoot(sourceRootsReal, sourceChecked.resolvedPath);
  if (!sourceInside) {
    const rawInside = isPathWithinAnyRoot(sourceRootsRaw, originalPath);
    if (rawInside) {
      return 'source_symlink_escape';
    }
    return governanceScope ? 'source_outside_governance_root' : 'source_outside_profile_root';
  }

  return null;
}

function buildRestoreAuditMeta(entry = {}) {
  return {
    accountId: entry.accountId || null,
    accountShortId: entry.accountShortId || null,
    userName: entry.userName || null,
    corpName: entry.corpName || null,
    categoryKey: entry.categoryKey || null,
    categoryLabel: entry.categoryLabel || null,
    monthKey: entry.monthKey || null,
    targetKey: entry.targetKey || null,
    tier: entry.tier || null,
    sizeBytes: Number(entry.sizeBytes || 0),
  };
}

export async function listRestorableBatches(indexPath, options = {}) {
  const recycleRoot = typeof options.recycleRoot === 'string' ? options.recycleRoot : null;
  const restoredSet = new Set();
  const cleanupRows = new Map();

  await streamJsonRows(indexPath, async (row) => {
    if (!row || typeof row !== 'object') {
      return;
    }
    if (row.action === 'restore' && row.status === 'success' && typeof row.recyclePath === 'string') {
      restoredSet.add(row.recyclePath);
      cleanupRows.delete(row.recyclePath);
      return;
    }
    if (row.action === 'cleanup' && row.status === 'success' && typeof row.recyclePath === 'string') {
      if (!restoredSet.has(row.recyclePath)) {
        cleanupRows.set(row.recyclePath, row);
      }
    }
  });

  const batches = new Map();

  for (const row of cleanupRows.values()) {
    if (recycleRoot && !isPathWithinRoot(recycleRoot, row.recyclePath)) {
      continue;
    }

    const recycleExists = await pathExists(row.recyclePath);
    if (!recycleExists) {
      continue;
    }

    const batchId = row.batchId || 'unknown';
    if (!batches.has(batchId)) {
      batches.set(batchId, {
        batchId,
        firstTime: row.time || Date.now(),
        entries: [],
        totalBytes: 0,
      });
    }
    const batch = batches.get(batchId);
    batch.firstTime = Math.min(batch.firstTime, row.time || batch.firstTime);
    batch.entries.push(row);
    batch.totalBytes += Number(row.sizeBytes || 0);
  }

  return [...batches.values()].sort((a, b) => b.firstTime - a.firstTime);
}

export async function restoreBatch({
  batch,
  indexPath,
  onConflict,
  onProgress,
  dryRun = false,
  profileRoot = null,
  extraProfileRoots = [],
  recycleRoot = null,
  governanceRoot = null,
  extraGovernanceRoots = [],
}) {
  const summary = {
    batchId: batch.batchId,
    successCount: 0,
    skipCount: 0,
    failCount: 0,
    restoredBytes: 0,
    errors: [],
  };

  const validationState = await buildRestoreValidationState({
    profileRoot,
    extraProfileRoots,
    recycleRoot,
    governanceRoot,
    extraGovernanceRoots,
  });

  let applyAllAction = null;
  const total = batch.entries.length;

  for (let i = 0; i < total; i += 1) {
    const entry = batch.entries[i];
    if (typeof onProgress === 'function') {
      onProgress(i + 1, total);
    }

    const recyclePath = entry.recyclePath;
    const originalPath = entry.sourcePath;
    const scope = typeof entry.scope === 'string' && entry.scope ? entry.scope : 'cleanup_monthly';
    const auditMeta = buildRestoreAuditMeta(entry);
    const invalidPathReason = await validateRestoreEntryPath({
      originalPath,
      recyclePath,
      scope,
      validationState,
    });

    if (invalidPathReason) {
      summary.skipCount += 1;
      await appendJsonLine(indexPath, {
        action: 'restore',
        time: Date.now(),
        scope,
        batchId: batch.batchId,
        recyclePath,
        sourcePath: originalPath,
        ...auditMeta,
        status: 'skipped_invalid_path',
        error_type: ERROR_TYPES.PATH_VALIDATION_FAILED,
        invalid_reason: invalidPathReason,
        profile_root: profileRoot,
        extra_profile_roots: extraProfileRoots,
        recycle_root: recycleRoot,
        governance_root: governanceRoot,
        extra_governance_roots: extraGovernanceRoots,
      });
      continue;
    }

    if (!(await pathExists(recyclePath))) {
      summary.skipCount += 1;
      await appendJsonLine(indexPath, {
        action: 'restore',
        time: Date.now(),
        scope,
        batchId: batch.batchId,
        recyclePath,
        sourcePath: originalPath,
        ...auditMeta,
        status: 'skipped_missing_recycle',
        error_type: ERROR_TYPES.PATH_NOT_FOUND,
        profile_root: profileRoot,
        extra_profile_roots: extraProfileRoots,
        recycle_root: recycleRoot,
        governance_root: governanceRoot,
        extra_governance_roots: extraGovernanceRoots,
      });
      continue;
    }

    let targetPath = originalPath;
    let strategy = applyAllAction;
    let conflictStrategy = null;
    let wouldOverwrite = false;

    const sourceExists = await pathExists(originalPath);
    if (sourceExists) {
      if (!strategy && typeof onConflict === 'function') {
        const resolved = await onConflict({
          originalPath,
          recyclePath,
          entry,
        });
        strategy = resolved?.action || 'skip';
        if (resolved?.applyToAll) {
          applyAllAction = strategy;
        }
      }

      if (!strategy) {
        strategy = 'skip';
      }
      conflictStrategy = strategy;
      wouldOverwrite = strategy === 'overwrite';

      if (strategy === 'skip') {
        summary.skipCount += 1;
        await appendJsonLine(indexPath, {
          action: 'restore',
          time: Date.now(),
          scope,
          batchId: batch.batchId,
          recyclePath,
          sourcePath: originalPath,
          ...auditMeta,
          status: 'skipped_conflict',
          error_type: ERROR_TYPES.CONFLICT,
          profile_root: profileRoot,
          extra_profile_roots: extraProfileRoots,
          recycle_root: recycleRoot,
          governance_root: governanceRoot,
          extra_governance_roots: extraGovernanceRoots,
        });
        continue;
      }

      if (strategy === 'rename') {
        targetPath = buildRenameTarget(originalPath);
      }
    }

    if (dryRun) {
      summary.successCount += 1;
      summary.restoredBytes += Number(entry.sizeBytes || 0);

      await appendJsonLine(indexPath, {
        action: 'restore',
        time: Date.now(),
        scope,
        batchId: batch.batchId,
        recyclePath,
        sourcePath: originalPath,
        restoredPath: targetPath,
        ...auditMeta,
        status: 'dry_run',
        dryRun: true,
        conflict_strategy: conflictStrategy,
        would_overwrite: wouldOverwrite,
        profile_root: profileRoot,
        extra_profile_roots: extraProfileRoots,
        recycle_root: recycleRoot,
        governance_root: governanceRoot,
        extra_governance_roots: extraGovernanceRoots,
      });
      continue;
    }

    try {
      if (sourceExists && strategy === 'overwrite') {
        await removePath(originalPath);
      }
      await movePath(recyclePath, targetPath);
      summary.successCount += 1;
      summary.restoredBytes += Number(entry.sizeBytes || 0);

      await appendJsonLine(indexPath, {
        action: 'restore',
        time: Date.now(),
        scope,
        batchId: batch.batchId,
        recyclePath,
        sourcePath: originalPath,
        restoredPath: targetPath,
        ...auditMeta,
        status: 'success',
        dryRun: false,
        profile_root: profileRoot,
        extra_profile_roots: extraProfileRoots,
        recycle_root: recycleRoot,
        governance_root: governanceRoot,
        extra_governance_roots: extraGovernanceRoots,
      });
    } catch (error) {
      summary.failCount += 1;
      summary.errors.push({
        recyclePath,
        sourcePath: originalPath,
        message: error instanceof Error ? error.message : String(error),
      });

      await appendJsonLine(indexPath, {
        action: 'restore',
        time: Date.now(),
        scope,
        batchId: batch.batchId,
        recyclePath,
        sourcePath: originalPath,
        ...auditMeta,
        status: 'failed',
        error_type: classifyErrorType(error instanceof Error ? error.message : String(error)),
        dryRun: false,
        error: error instanceof Error ? error.message : String(error),
        profile_root: profileRoot,
        extra_profile_roots: extraProfileRoots,
        recycle_root: recycleRoot,
        governance_root: governanceRoot,
        extra_governance_roots: extraGovernanceRoots,
      });
    }
  }

  return summary;
}
