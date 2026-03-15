import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadLatestTask, saveLatestTask } from '../src/task-state.js';
import { makeTempDir, removeDir } from './helpers/temp.js';

test('task-state 可写入并读取最近任务快照', async (t) => {
  const root = await makeTempDir('wecom-task-state-');
  t.after(async () => removeDir(root));

  const latestTaskPath = path.join(root, 'latest-task.json');
  await saveLatestTask(latestTaskPath, {
    action: 'analysis_only',
    ok: true,
    dryRun: null,
    warnings: ['w1'],
    errors: [{ code: 'E1', message: 'm1', path: '/tmp/demo' }],
    data: {
      protocolVersion: '1',
      userFacingSummary: {
        scopeNotes: ['只读'],
      },
      taskCard: {
        actionLabel: '会话分析（只读）',
        conclusion: '已完成检查，本次未执行任何改动。',
      },
    },
    meta: {
      timestamp: 123,
      durationMs: 45,
      engine: 'zig',
    },
  });

  const snapshot = await loadLatestTask(latestTaskPath);
  assert.equal(snapshot.action, 'analysis_only');
  assert.equal(snapshot.protocolVersion, '1');
  assert.equal(snapshot.actionLabel, '会话分析（只读）');
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.timestamp, 123);
  assert.equal(snapshot.durationMs, 45);
  assert.equal(snapshot.engine, 'zig');
  assert.equal(snapshot.taskCard.conclusion, '已完成检查，本次未执行任何改动。');
  assert.deepEqual(snapshot.userFacingSummary.scopeNotes, ['只读']);
  assert.equal(snapshot.warnings.length, 1);
  assert.equal(snapshot.errors[0].code, 'E1');
});
