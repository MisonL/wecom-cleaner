import { promises as fs } from 'node:fs';
import path from 'node:path';
import { appendJsonLine, ensureDir, pathExists, readJsonLines } from './utils.js';

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

export async function listRestorableBatches(indexPath) {
  const rows = await readJsonLines(indexPath);
  const restoredSet = new Set(
    rows
      .filter((row) => row?.action === 'restore' && row?.status === 'success' && typeof row.recyclePath === 'string')
      .map((row) => row.recyclePath)
  );

  const cleanupRows = rows.filter((row) => row?.action === 'cleanup' && typeof row.recyclePath === 'string');
  const batches = new Map();

  for (const row of cleanupRows) {
    if (restoredSet.has(row.recyclePath)) {
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
  onRiskConfirm,
  onProgress,
  profileRoot = null,
}) {
  const summary = {
    batchId: batch.batchId,
    successCount: 0,
    skipCount: 0,
    failCount: 0,
    restoredBytes: 0,
    errors: [],
  };

  let applyAllAction = null;
  let applyAllRiskAllow = null;
  const total = batch.entries.length;

  for (let i = 0; i < total; i += 1) {
    const entry = batch.entries[i];
    if (typeof onProgress === 'function') {
      onProgress(i + 1, total);
    }

    const recyclePath = entry.recyclePath;
    const originalPath = entry.sourcePath;
    const outOfProfileRoot = Boolean(profileRoot) && !isPathWithinRoot(profileRoot, originalPath);
    let riskConfirmed = null;

    if (!(await pathExists(recyclePath))) {
      summary.skipCount += 1;
      await appendJsonLine(indexPath, {
        action: 'restore',
        time: Date.now(),
        batchId: batch.batchId,
        recyclePath,
        sourcePath: originalPath,
        status: 'skipped_missing_recycle',
        risk: outOfProfileRoot ? 'out_of_profile_root' : null,
        user_confirmed: outOfProfileRoot ? Boolean(riskConfirmed) : null,
        profile_root: outOfProfileRoot ? profileRoot : null,
      });
      continue;
    }

    if (outOfProfileRoot) {
      let allow = applyAllRiskAllow;
      if (allow === null) {
        if (typeof onRiskConfirm === 'function') {
          const resolved = await onRiskConfirm({
            originalPath,
            recyclePath,
            profileRoot,
            entry,
          });
          allow = Boolean(resolved?.allow);
          if (resolved?.applyToAll) {
            applyAllRiskAllow = allow;
          }
        } else {
          allow = true;
        }
      }
      riskConfirmed = Boolean(allow);
      if (!riskConfirmed) {
        summary.skipCount += 1;
        await appendJsonLine(indexPath, {
          action: 'restore',
          time: Date.now(),
          batchId: batch.batchId,
          recyclePath,
          sourcePath: originalPath,
          status: 'skipped_risk_rejected',
          risk: 'out_of_profile_root',
          user_confirmed: false,
          profile_root: profileRoot,
        });
        continue;
      }
    }

    let targetPath = originalPath;
    let strategy = applyAllAction;

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

      if (strategy === 'skip') {
        summary.skipCount += 1;
        await appendJsonLine(indexPath, {
          action: 'restore',
          time: Date.now(),
          batchId: batch.batchId,
          recyclePath,
          sourcePath: originalPath,
          status: 'skipped_conflict',
          risk: outOfProfileRoot ? 'out_of_profile_root' : null,
          user_confirmed: outOfProfileRoot ? Boolean(riskConfirmed) : null,
          profile_root: outOfProfileRoot ? profileRoot : null,
        });
        continue;
      }

      if (strategy === 'overwrite') {
        await removePath(originalPath);
      }

      if (strategy === 'rename') {
        targetPath = buildRenameTarget(originalPath);
      }
    }

    try {
      await movePath(recyclePath, targetPath);
      summary.successCount += 1;
      summary.restoredBytes += Number(entry.sizeBytes || 0);

      await appendJsonLine(indexPath, {
        action: 'restore',
        time: Date.now(),
        batchId: batch.batchId,
        recyclePath,
        sourcePath: originalPath,
        restoredPath: targetPath,
        status: 'success',
        risk: outOfProfileRoot ? 'out_of_profile_root' : null,
        user_confirmed: outOfProfileRoot ? Boolean(riskConfirmed) : null,
        profile_root: outOfProfileRoot ? profileRoot : null,
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
        batchId: batch.batchId,
        recyclePath,
        sourcePath: originalPath,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        risk: outOfProfileRoot ? 'out_of_profile_root' : null,
        user_confirmed: outOfProfileRoot ? Boolean(riskConfirmed) : null,
        profile_root: outOfProfileRoot ? profileRoot : null,
      });
    }
  }

  return summary;
}
