import { readJson, writeJson } from './utils.js';

function normalizeTaskSnapshot(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    protocolVersion: String(source.protocolVersion || '1'),
    action: source.action || '',
    actionLabel: source.actionLabel || '',
    ok: Boolean(source.ok),
    dryRun: typeof source.dryRun === 'boolean' ? source.dryRun : null,
    timestamp: Number.isFinite(Number(source.timestamp)) ? Number(source.timestamp) : 0,
    durationMs: Number.isFinite(Number(source.durationMs)) ? Number(source.durationMs) : 0,
    engine: source.engine || '',
    summary: source.summary && typeof source.summary === 'object' ? source.summary : {},
    taskCard: source.taskCard && typeof source.taskCard === 'object' ? source.taskCard : {},
    userFacingSummary:
      source.userFacingSummary && typeof source.userFacingSummary === 'object'
        ? source.userFacingSummary
        : {},
    warnings: Array.isArray(source.warnings) ? source.warnings.map((item) => String(item || '')) : [],
    errors: Array.isArray(source.errors)
      ? source.errors.map((item) => ({
          code: item?.code || '',
          message: item?.message || '',
          path: item?.path || '',
        }))
      : [],
  };
}

export async function loadLatestTask(latestTaskPath) {
  return normalizeTaskSnapshot(await readJson(latestTaskPath, {}));
}

export async function saveLatestTask(latestTaskPath, payload = {}) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  const meta = payload?.meta && typeof payload.meta === 'object' ? payload.meta : {};
  const snapshot = normalizeTaskSnapshot({
    protocolVersion: data.protocolVersion || '1',
    action: payload.action || '',
    actionLabel: data.taskCard?.actionLabel || '',
    ok: payload.ok,
    dryRun: payload.dryRun,
    timestamp: meta.timestamp || Date.now(),
    durationMs: meta.durationMs || 0,
    engine: meta.engine || '',
    summary: payload.summary || {},
    taskCard: data.taskCard || {},
    userFacingSummary: data.userFacingSummary || {},
    warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
    errors: Array.isArray(payload.errors) ? payload.errors : [],
  });
  await writeJson(latestTaskPath, snapshot);
  return snapshot;
}
