import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function resolveNativeBinaryPath(projectRoot) {
  const platform = process.platform;
  const arch = process.arch;
  const ext = platform === 'win32' ? '.exe' : '';
  return path.join(projectRoot, 'native', 'bin', `${platform}-${arch}`, `wecom-cleaner-core${ext}`);
}

export async function detectNativeCore(projectRoot) {
  const binPath = resolveNativeBinaryPath(projectRoot);
  const exists = await fs
    .stat(binPath)
    .then((s) => s.isFile())
    .catch(() => false);
  if (!exists) {
    return null;
  }

  const probe = spawnSync(binPath, ['--ping'], {
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
  });

  if (probe.status !== 0) {
    return null;
  }

  try {
    const payload = JSON.parse((probe.stdout || '').trim());
    if (payload?.ok === true && payload?.engine === 'zig') {
      return binPath;
    }
  } catch {
    // ignore parse error and fallback to JS engine
  }

  return null;
}
