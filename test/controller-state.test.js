import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  defaultControllerStatePaths,
  loadPlanRecord,
  loadRunRecord,
  savePlanRecord,
  saveRunRecord,
  updateRunRecord,
} from '../src/controller-state.js';
import { makeTempDir, removeDir } from './helpers/temp.js';

test('controller-state 可保存计划、运行和事件日志', async (t) => {
  const root = await makeTempDir('wecom-controller-state-');
  t.after(async () => removeDir(root));

  const paths = defaultControllerStatePaths(root);
  const plan = await savePlanRecord(paths, {
    kind: 'plan_monthly_cleanup',
    action: 'cleanup_monthly',
    createdAt: 1,
    baseLegacyArgv: ['--cleanup-monthly'],
  });
  const run = await saveRunRecord(paths, {
    kind: 'plan_monthly_cleanup',
    action: 'cleanup_monthly',
    planId: plan.planId,
    createdAt: 2,
    executeLegacyArgv: ['--cleanup-monthly', '--run-task', 'execute'],
  });
  const updatedRun = await updateRunRecord(paths, run.runId, {
    verifiedAt: 3,
    verifyLegacyArgv: ['--cleanup-monthly', '--run-task', 'preview'],
  });

  const loadedPlan = await loadPlanRecord(paths, plan.planId);
  const loadedRun = await loadRunRecord(paths, run.runId);
  const events = String(await fs.readFile(path.join(root, 'events.jsonl'), 'utf-8'))
    .trim()
    .split(/\r?\n/);

  assert.equal(loadedPlan.planId, plan.planId);
  assert.equal(loadedRun.runId, run.runId);
  assert.equal(updatedRun.verifiedAt, 3);
  assert.equal(events.length, 3);
  assert.equal(JSON.parse(events[0]).type, 'plan_saved');
  assert.equal(JSON.parse(events[1]).type, 'run_saved');
  assert.equal(JSON.parse(events[2]).type, 'run_updated');
});
