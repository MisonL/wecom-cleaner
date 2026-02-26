import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { acquireLock, breakLock, LockHeldError, resolveLockPath } from '../src/lock.js';
import { makeTempDir, removeDir } from './helpers/temp.js';

test('resolveLockPath 与 acquireLock/release 链路正常', async (t) => {
  const root = await makeTempDir('wecom-lock-basic-');
  t.after(async () => removeDir(root));

  const lockPath = resolveLockPath(root);
  assert.equal(lockPath, path.join(root, '.wecom-cleaner.lock'));

  const lock = await acquireLock(root, 'cleanup_monthly');
  const raw = await fs.readFile(lockPath, 'utf-8');
  const payload = JSON.parse(raw);
  assert.equal(payload.pid, process.pid);
  assert.equal(payload.mode, 'cleanup_monthly');

  await lock.release();
  const existsAfterRelease = await fs
    .stat(lockPath)
    .then(() => true)
    .catch(() => false);
  assert.equal(existsAfterRelease, false);
});

test('acquireLock 能识别运行中锁并自动恢复陈旧锁', async (t) => {
  const root = await makeTempDir('wecom-lock-held-');
  t.after(async () => removeDir(root));

  const active = await acquireLock(root, 'analysis_only');
  await assert.rejects(
    () => acquireLock(root, 'restore'),
    (error) => error instanceof LockHeldError && error.isStale === false
  );
  await active.release();

  const lockPath = resolveLockPath(root);
  await fs.writeFile(
    lockPath,
    `${JSON.stringify(
      {
        pid: -1,
        mode: 'stale',
        startedAt: Date.now() - 3600_000,
        hostname: 'localhost',
      },
      null,
      2
    )}\n`,
    'utf-8'
  );

  const recovered = await acquireLock(root, 'restore');
  assert.equal(recovered.lockInfo.pid, process.pid);
  assert.equal(recovered.lockInfo.mode, 'restore');
  assert.equal(recovered.lockInfo.recoveredFromStale, true);
  await recovered.release();

  await fs.writeFile(
    lockPath,
    `${JSON.stringify(
      {
        pid: -1,
        mode: 'stale',
        startedAt: Date.now() - 3600_000,
        hostname: 'localhost',
      },
      null,
      2
    )}\n`,
    'utf-8'
  );
  await assert.rejects(
    () => acquireLock(root, 'restore', { allowStaleBreak: false }),
    (error) => error instanceof LockHeldError && error.isStale === true
  );

  await breakLock(lockPath);
  const existsAfterBreak = await fs
    .stat(lockPath)
    .then(() => true)
    .catch(() => false);
  assert.equal(existsAfterBreak, false);
});
