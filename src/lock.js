import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCK_FILE_NAME = '.wecom-cleaner.lock';

export class LockHeldError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'LockHeldError';
    this.lockPath = options.lockPath || null;
    this.lockInfo = options.lockInfo || null;
    this.isStale = Boolean(options.isStale);
  }
}

function isValidPid(pid) {
  return Number.isInteger(pid) && pid > 0;
}

function isProcessRunning(pid) {
  if (!isValidPid(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === 'ESRCH') {
      return false;
    }
    return true;
  }
}

async function readLockInfo(lockPath) {
  try {
    const raw = await fs.readFile(lockPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeLockFile(lockPath, payload) {
  const handle = await fs.open(lockPath, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  } finally {
    await handle.close().catch(() => {});
  }
}

export function resolveLockPath(stateRoot) {
  return path.join(path.resolve(String(stateRoot || '.')), LOCK_FILE_NAME);
}

export async function breakLock(lockPath) {
  await fs.rm(lockPath, { force: true });
}

export async function acquireLock(stateRoot, mode, options = {}) {
  const allowStaleBreak = options.allowStaleBreak !== false;
  const lockPath = resolveLockPath(stateRoot);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  const payloadBase = {
    pid: process.pid,
    mode: String(mode || 'unknown'),
    startedAt: Date.now(),
    hostname: os.hostname(),
    version: process.env.npm_package_version || null,
  };

  let recoveredFromStale = false;
  let staleLockInfo = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const payload = recoveredFromStale
      ? {
          ...payloadBase,
          recoveredFromStale: true,
          recoveredAt: Date.now(),
          staleLockPid: staleLockInfo?.pid || null,
        }
      : payloadBase;

    try {
      await writeLockFile(lockPath, payload);
      return {
        lockPath,
        lockInfo: payload,
        async release() {
          await fs.rm(lockPath, { force: true }).catch(() => {});
        },
      };
    } catch (error) {
      if (error && error.code !== 'EEXIST') {
        throw error;
      }

      const lockInfo = await readLockInfo(lockPath);
      const lockPid = Number.parseInt(String(lockInfo?.pid || ''), 10);
      const isStale = !isProcessRunning(lockPid);

      if (isStale && allowStaleBreak && attempt === 0) {
        staleLockInfo = lockInfo;
        recoveredFromStale = true;
        await fs.rm(lockPath, { force: true }).catch(() => {});
        continue;
      }

      throw new LockHeldError('检测到另一个实例正在运行', {
        lockPath,
        lockInfo,
        isStale,
      });
    }
  }

  throw new LockHeldError('检测到锁文件冲突，且自动恢复失败', {
    lockPath,
    lockInfo: staleLockInfo,
    isStale: Boolean(staleLockInfo),
  });
}
