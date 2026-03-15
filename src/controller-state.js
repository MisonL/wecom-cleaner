import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ensureDir, readJson, writeJson } from './utils.js';

function safeId(text = '') {
  return (
    String(text || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'task'
  );
}

function makeRecordId(prefix) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 14);
  const rand = Math.random().toString(16).slice(2, 8);
  return `${prefix}-${stamp}-${rand}`;
}

export function defaultControllerStatePaths(stateRoot) {
  const root = path.resolve(String(stateRoot || '.'));
  return {
    plansRoot: path.join(root, 'plans'),
    runsRoot: path.join(root, 'runs'),
    eventsPath: path.join(root, 'events.jsonl'),
  };
}

export async function ensureControllerStateDirs(paths) {
  await ensureDir(paths.plansRoot);
  await ensureDir(paths.runsRoot);
  await ensureDir(path.dirname(paths.eventsPath));
}

export async function appendControllerEvent(eventsPath, event) {
  await ensureDir(path.dirname(eventsPath));
  await fs.appendFile(eventsPath, `${JSON.stringify(event)}\n`, 'utf-8');
}

export async function savePlanRecord(paths, record) {
  await ensureControllerStateDirs(paths);
  const planId = record.planId || makeRecordId(safeId(record.kind || 'plan'));
  const next = { ...record, planId };
  await writeJson(path.join(paths.plansRoot, `${planId}.json`), next);
  await appendControllerEvent(paths.eventsPath, {
    type: 'plan_saved',
    planId,
    kind: next.kind,
    action: next.action,
    createdAt: next.createdAt || Date.now(),
  });
  return next;
}

export async function loadPlanRecord(paths, planId) {
  return readJson(path.join(paths.plansRoot, `${planId}.json`), null);
}

export async function saveRunRecord(paths, record) {
  await ensureControllerStateDirs(paths);
  const runId = record.runId || makeRecordId(safeId(record.kind || 'run'));
  const next = { ...record, runId };
  await writeJson(path.join(paths.runsRoot, `${runId}.json`), next);
  await appendControllerEvent(paths.eventsPath, {
    type: 'run_saved',
    runId,
    planId: next.planId || null,
    kind: next.kind,
    action: next.action,
    createdAt: next.createdAt || Date.now(),
  });
  return next;
}

async function writeUpdatedRunRecord(paths, runId, record) {
  await ensureControllerStateDirs(paths);
  const next = { ...record, runId };
  await writeJson(path.join(paths.runsRoot, `${runId}.json`), next);
  await appendControllerEvent(paths.eventsPath, {
    type: 'run_updated',
    runId,
    planId: next.planId || null,
    kind: next.kind,
    action: next.action,
    updatedAt: Date.now(),
  });
  return next;
}

export async function loadRunRecord(paths, runId) {
  return readJson(path.join(paths.runsRoot, `${runId}.json`), null);
}

export async function updateRunRecord(paths, runId, patch) {
  const current = (await loadRunRecord(paths, runId)) || { runId };
  return writeUpdatedRunRecord(paths, runId, { ...current, ...patch, runId });
}
