import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { appendJsonLine, ensureDir, pathExists } from './utils.js';

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

export async function executeCleanup({
  targets,
  recycleRoot,
  indexPath,
  dryRun,
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
        dryRun: false,
        error: message,
      });
    }
  }

  return summary;
}
