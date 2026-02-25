import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const NATIVE_CACHE_DIR = 'native-cache';
const DEFAULT_DOWNLOAD_BASE_URL = 'https://raw.githubusercontent.com/MisonL/wecom-cleaner/main/native/bin';
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15_000;

function resolveRuntimeTarget() {
  const runtimePlatform = process.platform;
  const runtimeArch = process.arch;

  const osTag =
    runtimePlatform === 'win32'
      ? 'windows'
      : runtimePlatform === 'darwin'
        ? 'darwin'
        : runtimePlatform === 'linux'
          ? 'linux'
          : runtimePlatform;

  const archTag =
    runtimeArch === 'x64'
      ? 'x64'
      : runtimeArch === 'arm64'
        ? 'arm64'
        : runtimeArch === 'x86_64'
          ? 'x64'
          : runtimeArch === 'aarch64'
            ? 'arm64'
            : runtimeArch;

  const ext = osTag === 'windows' ? '.exe' : '';
  const binaryName = `wecom-cleaner-core${ext}`;
  return {
    osTag,
    archTag,
    targetTag: `${osTag}-${archTag}`,
    binaryName,
  };
}

function resolveBundledBinaryPath(projectRoot, target) {
  return path.join(projectRoot, 'native', 'bin', target.targetTag, target.binaryName);
}

function resolveCachedBinaryPath(stateRoot, target) {
  return path.join(stateRoot, NATIVE_CACHE_DIR, target.targetTag, target.binaryName);
}

async function isExecutableFile(filePath) {
  return fs
    .stat(filePath)
    .then((s) => s.isFile())
    .catch(() => false);
}

async function probeNativeCore(binPath) {
  const exists = await isExecutableFile(binPath);
  if (!exists) {
    return false;
  }

  const probe = spawnSync(binPath, ['--ping'], {
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
  });

  if (probe.status !== 0) {
    return false;
  }

  try {
    const payload = JSON.parse((probe.stdout || '').trim());
    return payload?.ok === true && payload?.engine === 'zig';
  } catch {
    return false;
  }
}

function shouldAutoRepair() {
  const raw = String(process.env.WECOM_CLEANER_NATIVE_AUTO_REPAIR || 'true').toLowerCase().trim();
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off');
}

function getDownloadBaseUrl() {
  const raw = process.env.WECOM_CLEANER_NATIVE_BASE_URL;
  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim().replace(/\/+$/, '');
  }
  return DEFAULT_DOWNLOAD_BASE_URL;
}

function getDownloadTimeoutMs() {
  const raw = Number.parseInt(process.env.WECOM_CLEANER_NATIVE_DOWNLOAD_TIMEOUT_MS || '', 10);
  if (Number.isFinite(raw) && raw >= 1_000) {
    return raw;
  }
  return DEFAULT_DOWNLOAD_TIMEOUT_MS;
}

async function downloadNativeCore(url, destinationPath) {
  const timeout = getDownloadTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  const tmpPath = `${destinationPath}.tmp-${Date.now()}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = Buffer.from(await response.arrayBuffer());
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.writeFile(tmpPath, data);
    await fs.chmod(tmpPath, 0o755).catch(() => {});
    await fs.rename(tmpPath, destinationPath);
  } finally {
    clearTimeout(timer);
    await fs.rm(tmpPath, { force: true }).catch(() => {});
  }
}

async function repairNativeCore({ stateRoot, target }) {
  if (!stateRoot) {
    return {
      nativeCorePath: null,
      repairNote: '自动修复: 无可写状态目录，已继续使用Node',
    };
  }

  const destinationPath = resolveCachedBinaryPath(stateRoot, target);
  const downloadUrl = `${getDownloadBaseUrl()}/${target.targetTag}/${target.binaryName}`;

  try {
    await downloadNativeCore(downloadUrl, destinationPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      nativeCorePath: null,
      repairNote: `自动修复: 下载失败(${message})，已继续使用Node`,
    };
  }

  const valid = await probeNativeCore(destinationPath);
  if (!valid) {
    await fs.rm(destinationPath, { force: true }).catch(() => {});
    return {
      nativeCorePath: null,
      repairNote: '自动修复: 下载结果不可用，已继续使用Node',
    };
  }

  return {
    nativeCorePath: destinationPath,
    repairNote: `自动修复: Zig核心已恢复(${target.targetTag})`,
  };
}

export async function detectNativeCore(projectRoot, options = {}) {
  const stateRoot = typeof options.stateRoot === 'string' ? options.stateRoot : null;
  const target = resolveRuntimeTarget();

  const bundledPath = resolveBundledBinaryPath(projectRoot, target);
  const bundledOk = await probeNativeCore(bundledPath);
  if (bundledOk) {
    return { nativeCorePath: bundledPath, repairNote: null };
  }

  if (stateRoot) {
    const cachedPath = resolveCachedBinaryPath(stateRoot, target);
    const cachedOk = await probeNativeCore(cachedPath);
    if (cachedOk) {
      return {
        nativeCorePath: cachedPath,
        repairNote: '自动修复: 已使用本地缓存的Zig核心',
      };
    }
  }

  if (!shouldAutoRepair()) {
    return { nativeCorePath: null, repairNote: null };
  }

  return repairNativeCore({ stateRoot, target });
}
