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

function batchRootPath(recycleRoot, batchId) {
  return path.join(path.resolve(recycleRoot), String(batchId || ''));
}

export async function collectRecycleStats({ indexPath, recycleRoot }) {
  await ensureDir(recycleRoot);
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
  const before = await collectRecycleStats({ indexPath, recycleRoot });
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

    if (dryRun) {
      summary.deletedBatches += 1;
      summary.deletedBytes += Number(batch.totalBytes || 0);
      continue;
    }

    const targetBatchRoot = batchRootPath(recycleRoot, batch.batchId);
    try {
      await fs.rm(targetBatchRoot, { recursive: true, force: true });
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
