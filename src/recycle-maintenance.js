import { promises as fs } from 'node:fs';
import path from 'node:path';
import { listRestorableBatches } from './restore.js';
import { appendJsonLine, calculateDirectorySize, ensureDir } from './utils.js';
import { classifyErrorType, ERROR_TYPES } from './error-taxonomy.js';

const GB = 1024 * 1024 * 1024;

function normalizePositiveInt(rawValue, fallbackValue, minValue = 1) {
  const num = Number.parseInt(String(rawValue ?? ''), 10);
  if (!Number.isFinite(num) || num < minValue) {
    return fallbackValue;
  }
  return num;
}

export function normalizeRecycleRetention(input, fallback = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const fallbackEnabled = typeof fallback.enabled === 'boolean' ? fallback.enabled : true;
  const fallbackMaxAgeDays = normalizePositiveInt(fallback.maxAgeDays, 30);
  const fallbackMinKeepBatches = normalizePositiveInt(fallback.minKeepBatches, 20);
  const fallbackSizeThresholdGB = normalizePositiveInt(fallback.sizeThresholdGB, 20);

  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : fallbackEnabled,
    maxAgeDays: normalizePositiveInt(source.maxAgeDays, fallbackMaxAgeDays),
    minKeepBatches: normalizePositiveInt(source.minKeepBatches, fallbackMinKeepBatches),
    sizeThresholdGB: normalizePositiveInt(source.sizeThresholdGB, fallbackSizeThresholdGB),
    lastRunAt: Number.isFinite(Number(source.lastRunAt))
      ? Number(source.lastRunAt)
      : Number(fallback.lastRunAt || 0),
  };
}

function bytesThreshold(policy) {
  return Math.max(1, Number(policy.sizeThresholdGB || 20)) * GB;
}

function ageDays(tsMillis, nowMillis) {
  const delta = Math.max(0, Number(nowMillis) - Number(tsMillis || 0));
  return Math.floor(delta / (24 * 3600 * 1000));
}

function isPathWithinRoot(rootPath, targetPath) {
  const rootAbs = path.resolve(String(rootPath || ''));
  const targetAbs = path.resolve(String(targetPath || ''));
  const rel = path.relative(rootAbs, targetAbs);
  if (!rel) {
    return true;
  }
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function resolveBatchRootFromEntries(recycleRoot, batch) {
  const recycleRootAbs = path.resolve(String(recycleRoot || ''));
  const entries = Array.isArray(batch?.entries) ? batch.entries : [];
  if (entries.length === 0) {
    return {
      ok: false,
      invalidReason: 'empty_batch_entries',
    };
  }

  const rootSet = new Set();
  for (const entry of entries) {
    const recyclePath = String(entry?.recyclePath || '').trim();
    if (!recyclePath) {
      return {
        ok: false,
        invalidReason: 'invalid_recycle_path',
      };
    }

    const recyclePathAbs = path.resolve(recyclePath);
    if (!isPathWithinRoot(recycleRootAbs, recyclePathAbs)) {
      return {
        ok: false,
        invalidReason: 'recycle_path_outside_recycle_root',
      };
    }

    const batchRootAbs = path.dirname(recyclePathAbs);
    if (!isPathWithinRoot(recycleRootAbs, batchRootAbs)) {
      return {
        ok: false,
        invalidReason: 'batch_root_outside_recycle_root',
      };
    }
    if (batchRootAbs === recycleRootAbs) {
      return {
        ok: false,
        invalidReason: 'batch_root_is_recycle_root',
      };
    }
    rootSet.add(batchRootAbs);
  }

  if (rootSet.size !== 1) {
    return {
      ok: false,
      invalidReason: 'inconsistent_batch_roots',
    };
  }

  return {
    ok: true,
    batchRoot: [...rootSet][0],
  };
}

export async function collectRecycleStats({ indexPath, recycleRoot, createIfMissing = true }) {
  if (createIfMissing) {
    await ensureDir(recycleRoot);
  } else {
    const recycleExists = await fs
      .stat(recycleRoot)
      .then((stat) => stat.isDirectory())
      .catch(() => false);
    if (!recycleExists) {
      return {
        batches: [],
        totalBatches: 0,
        totalBytes: 0,
        indexedBytes: 0,
        oldestTime: null,
      };
    }
  }

  const batches = await listRestorableBatches(indexPath, { recycleRoot });
  const totalBatches = batches.length;
  const indexedBytes = batches.reduce((acc, batch) => acc + Number(batch.totalBytes || 0), 0);
  const totalBytes = await calculateDirectorySize(recycleRoot);
  const oldestTime =
    totalBatches > 0 ? Math.min(...batches.map((item) => Number(item.firstTime || Date.now()))) : null;

  return {
    batches,
    totalBatches,
    totalBytes,
    indexedBytes,
    oldestTime,
  };
}

export function selectBatchesForMaintenance(batches, policy, now = Date.now()) {
  const normalized = [...(Array.isArray(batches) ? batches : [])].sort((a, b) => b.firstTime - a.firstTime);
  const minKeep = Math.max(0, Number(policy.minKeepBatches || 0));
  const maxAge = Math.max(1, Number(policy.maxAgeDays || 30));
  const thresholdBytes = bytesThreshold(policy);
  const totalBytes = normalized.reduce((acc, batch) => acc + Number(batch.totalBytes || 0), 0);

  const keepRecent = normalized.slice(0, minKeep);
  const keepSet = new Set(keepRecent.map((item) => item.batchId));
  const candidateMap = new Map();

  const ageCandidates = normalized.filter((batch) => {
    if (keepSet.has(batch.batchId)) {
      return false;
    }
    return ageDays(batch.firstTime, now) >= maxAge;
  });
  for (const batch of ageCandidates) {
    candidateMap.set(batch.batchId, {
      ...batch,
      selectedBy: 'age',
    });
  }

  let estimatedAfterBytes =
    totalBytes - [...candidateMap.values()].reduce((acc, batch) => acc + Number(batch.totalBytes || 0), 0);

  if (estimatedAfterBytes > thresholdBytes) {
    const extraBySize = normalized
      .filter((batch) => !keepSet.has(batch.batchId) && !candidateMap.has(batch.batchId))
      .sort((a, b) => a.firstTime - b.firstTime);

    for (const batch of extraBySize) {
      candidateMap.set(batch.batchId, {
        ...batch,
        selectedBy: 'size',
      });
      estimatedAfterBytes -= Number(batch.totalBytes || 0);
      if (estimatedAfterBytes <= thresholdBytes) {
        break;
      }
    }
  }

  const candidates = [...candidateMap.values()].sort((a, b) => b.firstTime - a.firstTime);

  return {
    keepRecent,
    candidates,
    totalBytes,
    thresholdBytes,
    estimatedAfterBytes: Math.max(0, estimatedAfterBytes),
  };
}

export async function maintainRecycleBin({ indexPath, recycleRoot, policy, dryRun, onProgress }) {
  const normalizedPolicy = normalizeRecycleRetention(policy);
  const now = Date.now();
  const before = await collectRecycleStats({
    indexPath,
    recycleRoot,
    createIfMissing: !dryRun,
  });
  const selected = selectBatchesForMaintenance(before.batches, normalizedPolicy, now);
  const thresholdBytes = selected.thresholdBytes;

  const summary = {
    dryRun: Boolean(dryRun),
    policy: normalizedPolicy,
    before,
    thresholdBytes,
    overThreshold: before.totalBytes > thresholdBytes,
    candidateCount: selected.candidates.length,
    selectedByAge: selected.candidates.filter((item) => item.selectedBy === 'age').length,
    selectedBySize: selected.candidates.filter((item) => item.selectedBy === 'size').length,
    deletedBatches: 0,
    deletedBytes: 0,
    failBatches: 0,
    errors: [],
  };

  if (!normalizedPolicy.enabled) {
    await appendJsonLine(indexPath, {
      action: 'recycle_maintain',
      time: now,
      status: 'skipped_disabled',
      dryRun: Boolean(dryRun),
      recycle_root: recycleRoot,
      policy: normalizedPolicy,
      before_batches: before.totalBatches,
      before_bytes: before.totalBytes,
      deleted_batches: 0,
      deleted_bytes: 0,
      remaining_batches: before.totalBatches,
      remaining_bytes: before.totalBytes,
    });
    return {
      ...summary,
      after: before,
      status: 'skipped_disabled',
    };
  }

  if (selected.candidates.length === 0) {
    await appendJsonLine(indexPath, {
      action: 'recycle_maintain',
      time: now,
      status: 'skipped_no_candidate',
      dryRun: Boolean(dryRun),
      recycle_root: recycleRoot,
      policy: normalizedPolicy,
      before_batches: before.totalBatches,
      before_bytes: before.totalBytes,
      deleted_batches: 0,
      deleted_bytes: 0,
      remaining_batches: before.totalBatches,
      remaining_bytes: before.totalBytes,
    });
    return {
      ...summary,
      after: before,
      status: 'skipped_no_candidate',
    };
  }

  for (let i = 0; i < selected.candidates.length; i += 1) {
    const batch = selected.candidates[i];
    if (typeof onProgress === 'function') {
      onProgress(i + 1, selected.candidates.length);
    }

    const resolvedBatchRoot = resolveBatchRootFromEntries(recycleRoot, batch);
    if (!resolvedBatchRoot.ok) {
      summary.failBatches += 1;
      summary.errors.push({
        batchId: batch.batchId,
        message: `批次路径校验失败: ${resolvedBatchRoot.invalidReason}`,
        errorType: ERROR_TYPES.PATH_VALIDATION_FAILED,
        invalidReason: resolvedBatchRoot.invalidReason,
      });
      continue;
    }

    if (dryRun) {
      summary.deletedBatches += 1;
      summary.deletedBytes += Number(batch.totalBytes || 0);
      continue;
    }

    try {
      await fs.rm(resolvedBatchRoot.batchRoot, { recursive: true, force: true });
      summary.deletedBatches += 1;
      summary.deletedBytes += Number(batch.totalBytes || 0);
    } catch (error) {
      summary.failBatches += 1;
      const message = error instanceof Error ? error.message : String(error);
      summary.errors.push({
        batchId: batch.batchId,
        message,
        errorType: classifyErrorType(message),
      });
    }
  }

  const after = dryRun ? before : await collectRecycleStats({ indexPath, recycleRoot });
  const status = summary.failBatches > 0 ? 'partial_failed' : dryRun ? 'dry_run' : 'success';

  await appendJsonLine(indexPath, {
    action: 'recycle_maintain',
    time: Date.now(),
    status,
    dryRun: Boolean(dryRun),
    recycle_root: recycleRoot,
    policy: normalizedPolicy,
    threshold_bytes: thresholdBytes,
    over_threshold: summary.overThreshold,
    before_batches: before.totalBatches,
    before_bytes: before.totalBytes,
    deleted_batches: summary.deletedBatches,
    deleted_bytes: summary.deletedBytes,
    failed_batches: summary.failBatches,
    selected_by_age: summary.selectedByAge,
    selected_by_size: summary.selectedBySize,
    remaining_batches: after.totalBatches,
    remaining_bytes: after.totalBytes,
    error_type: summary.failBatches > 0 ? summary.errors[0]?.errorType || ERROR_TYPES.UNKNOWN : null,
  });

  return {
    ...summary,
    after,
    status,
  };
}
