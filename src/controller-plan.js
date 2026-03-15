import { createHash } from 'node:crypto';

function stableHash(rows = []) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(rows));
  return hash.digest('hex');
}

function normalizeStringList(values = []) {
  return [...new Set(values.map((item) => String(item || '').trim()).filter(Boolean))];
}

function stripValueFlags(argv = [], flags = []) {
  const stripSet = new Set(flags);
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (stripSet.has(token)) {
      i += 1;
      continue;
    }
    out.push(token);
  }
  return out;
}

function appendCsvFlag(argv, flag, values = []) {
  const normalized = normalizeStringList(values);
  if (normalized.length === 0) {
    return argv;
  }
  return [...argv, flag, normalized.join(',')];
}

function appendBooleanFlag(argv, flag, value) {
  if (typeof value !== 'boolean') {
    return argv;
  }
  return [...argv, flag, value ? 'true' : 'false'];
}

export function buildCleanupSelectionSignature(targets = []) {
  const rows = (Array.isArray(targets) ? targets : [])
    .map((item) => ({
      accountId: item?.accountId || '',
      categoryKey: item?.categoryKey || '',
      isExternalStorage: Boolean(item?.isExternalStorage),
      monthKey: item?.monthKey || '',
      path: item?.path || '',
      sizeBytes: Number(item?.sizeBytes || 0),
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return stableHash(rows);
}

export function buildGovernanceSelectionSignature(targets = []) {
  const rows = (Array.isArray(targets) ? targets : [])
    .map((item) => ({
      accountId: item?.accountId || '',
      id: item?.id || '',
      path: item?.path || '',
      recentlyActive: Boolean(item?.recentlyActive),
      sizeBytes: Number(item?.sizeBytes || 0),
      suggested: Boolean(item?.suggested),
      targetKey: item?.targetKey || '',
      tier: item?.tier || '',
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return stableHash(rows);
}

export function buildFrozenPlanLegacyArgv(action, sourceArgv = [], payload = {}) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};

  if (action === 'cleanup_monthly') {
    let next = stripValueFlags(sourceArgv, [
      '--run-task',
      '--accounts',
      '--months',
      '--cutoff-month',
      '--categories',
      '--include-non-month-dirs',
      '--external-roots',
      '--external-roots-source',
    ]);
    next = appendCsvFlag(next, '--accounts', data.selectedAccounts);
    next = appendCsvFlag(next, '--months', data.selectedMonths);
    next = appendCsvFlag(next, '--categories', data.selectedCategories);
    next = appendBooleanFlag(next, '--include-non-month-dirs', data.includeNonMonthDirs);
    next = appendCsvFlag(next, '--external-roots', data.selectedExternalRoots);
    return next;
  }

  if (action === 'space_governance') {
    let next = stripValueFlags(sourceArgv, [
      '--run-task',
      '--accounts',
      '--external-roots',
      '--external-roots-source',
    ]);
    next = appendCsvFlag(next, '--accounts', data.selectedAccounts);
    next = appendCsvFlag(next, '--external-roots', data.selectedExternalRoots);
    return next;
  }

  return stripValueFlags(sourceArgv, ['--run-task']);
}
