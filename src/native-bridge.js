import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const NATIVE_CACHE_DIR = 'native-cache';
const MANIFEST_RELATIVE_PATH = path.join('native', 'manifest.json');
const DEFAULT_DOWNLOAD_BASE_URL = 'https://raw.githubusercontent.com/MisonL/wecom-cleaner/v0.1.0/native/bin';
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

function getDownloadBaseUrlOverride() {
  const raw = process.env.WECOM_CLEANER_NATIVE_BASE_URL;
  if (typeof raw === 'string' && raw.trim()) {
    return raw.trim().replace(/\/+$/, '');
  }
  return null;
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

function normalizeSha256(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const normalized = raw.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

async function calculateFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => {
      hash.update(chunk);
    });
    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });
  });
}

async function readNativeManifest(projectRoot) {
  const manifestPath = path.join(projectRoot, MANIFEST_RELATIVE_PATH);
  try {
    const text = await fs.readFile(manifestPath, 'utf-8');
    const payload = JSON.parse(text);
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function resolveManifestTarget(manifest, target) {
  if (!manifest || typeof manifest !== 'object' || !manifest.targets || typeof manifest.targets !== 'object') {
    return null;
  }

  const raw = manifest.targets[target.targetTag];
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  return {
    binaryName: typeof raw.binaryName === 'string' && raw.binaryName.trim() ? raw.binaryName.trim() : target.binaryName,
    sha256: normalizeSha256(raw.sha256),
    url: typeof raw.url === 'string' && raw.url.trim() ? raw.url.trim() : null,
  };
}

function resolveManifestVersion(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    return null;
  }
  if (typeof manifest.version === 'string' && manifest.version.trim()) {
    return manifest.version.trim();
  }
  return null;
}

function resolveDownloadUrl({ target, manifest, manifestTarget }) {
  const fileName = manifestTarget?.binaryName || target.binaryName;
  const overrideBaseUrl = getDownloadBaseUrlOverride();
  if (overrideBaseUrl) {
    return `${overrideBaseUrl}/${target.targetTag}/${fileName}`;
  }

  if (manifestTarget?.url) {
    return manifestTarget.url;
  }

  const manifestBaseUrl =
    typeof manifest?.baseUrl === 'string' && manifest.baseUrl.trim()
      ? manifest.baseUrl.trim().replace(/\/+$/, '')
      : null;

  if (manifestBaseUrl) {
    return `${manifestBaseUrl}/${target.targetTag}/${fileName}`;
  }

  return `${DEFAULT_DOWNLOAD_BASE_URL}/${target.targetTag}/${fileName}`;
}

async function verifySha256OrReason(filePath, expectedSha256) {
  const expected = normalizeSha256(expectedSha256);
  if (!expected) {
    return { ok: false, reason: 'missing_expected', actual: null };
  }
  try {
    const actual = await calculateFileSha256(filePath);
    if (actual === expected) {
      return { ok: true, reason: null, actual };
    }
    return { ok: false, reason: 'sha256_mismatch', actual };
  } catch {
    return { ok: false, reason: 'sha256_failed', actual: null };
  }
}

function formatHashShort(hashValue) {
  if (typeof hashValue !== 'string' || hashValue.length < 12) {
    return 'unknown';
  }
  return `${hashValue.slice(0, 8)}...${hashValue.slice(-4)}`;
}

async function repairNativeCore({ stateRoot, target, manifest, manifestTarget }) {
  if (!stateRoot) {
    return {
      nativeCorePath: null,
      repairNote: '自动修复: 无可写状态目录，已继续使用Node',
    };
  }

  if (!manifestTarget) {
    return {
      nativeCorePath: null,
      repairNote: `自动修复: 当前平台(${target.targetTag})缺少可信核心清单，已继续使用Node`,
    };
  }

  if (!manifestTarget.sha256) {
    return {
      nativeCorePath: null,
      repairNote: `自动修复: 当前平台(${target.targetTag})缺少SHA256校验值，已继续使用Node`,
    };
  }

  const destinationPath = resolveCachedBinaryPath(stateRoot, target);
  const downloadUrl = resolveDownloadUrl({ target, manifest, manifestTarget });

  try {
    await downloadNativeCore(downloadUrl, destinationPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      nativeCorePath: null,
      repairNote: `自动修复: 下载失败(${message})，已继续使用Node`,
    };
  }

  const digestResult = await verifySha256OrReason(destinationPath, manifestTarget.sha256);
  if (!digestResult.ok) {
    await fs.rm(destinationPath, { force: true }).catch(() => {});
    if (digestResult.reason === 'sha256_mismatch') {
      return {
        nativeCorePath: null,
        repairNote: `自动修复: 校验失败(SHA256不匹配，实际 ${formatHashShort(digestResult.actual)})，已继续使用Node`,
      };
    }
    return {
      nativeCorePath: null,
      repairNote: '自动修复: 校验失败(SHA256计算异常)，已继续使用Node',
    };
  }

  const valid = await probeNativeCore(destinationPath);
  if (!valid) {
    await fs.rm(destinationPath, { force: true }).catch(() => {});
    return {
      nativeCorePath: null,
      repairNote: '自动修复: 下载结果探针失败(--ping异常)，已继续使用Node',
    };
  }

  const manifestVersion = resolveManifestVersion(manifest);
  const versionText = manifestVersion ? `, v${manifestVersion}` : '';
  return {
    nativeCorePath: destinationPath,
    repairNote: `自动修复: Zig核心已恢复(${target.targetTag}${versionText})`,
  };
}

export async function detectNativeCore(projectRoot, options = {}) {
  const stateRoot = typeof options.stateRoot === 'string' ? options.stateRoot : null;
  const target = resolveRuntimeTarget();
  const manifest = await readNativeManifest(projectRoot);
  const manifestTarget = resolveManifestTarget(manifest, target);

  const bundledPath = resolveBundledBinaryPath(projectRoot, target);
  const bundledOk = await probeNativeCore(bundledPath);
  if (bundledOk) {
    return { nativeCorePath: bundledPath, repairNote: null };
  }

  let cacheCheckNote = null;
  if (stateRoot) {
    const cachedPath = resolveCachedBinaryPath(stateRoot, target);
    const cachedExists = await isExecutableFile(cachedPath);
    if (cachedExists) {
      if (!manifestTarget?.sha256) {
        await fs.rm(cachedPath, { force: true }).catch(() => {});
        cacheCheckNote = `自动修复: 本地缓存缺少可信SHA256清单(${target.targetTag})`;
      } else {
        const digestResult = await verifySha256OrReason(cachedPath, manifestTarget.sha256);
        if (!digestResult.ok) {
          await fs.rm(cachedPath, { force: true }).catch(() => {});
          cacheCheckNote =
            digestResult.reason === 'sha256_mismatch'
              ? `自动修复: 本地缓存校验失败(SHA256不匹配，实际 ${formatHashShort(digestResult.actual)})`
              : '自动修复: 本地缓存校验失败(SHA256计算异常)';
        }
      }

      if (await isExecutableFile(cachedPath)) {
        const cachedOk = await probeNativeCore(cachedPath);
        if (cachedOk) {
          return {
            nativeCorePath: cachedPath,
            repairNote: '自动修复: 已使用本地缓存并通过校验的Zig核心',
          };
        }
        await fs.rm(cachedPath, { force: true }).catch(() => {});
        cacheCheckNote = cacheCheckNote || '自动修复: 本地缓存探针失败(--ping异常)';
      }
    }
  }

  if (!shouldAutoRepair()) {
    return { nativeCorePath: null, repairNote: cacheCheckNote };
  }

  const repaired = await repairNativeCore({ stateRoot, target, manifest, manifestTarget });
  if (cacheCheckNote && repaired.repairNote && !repaired.nativeCorePath) {
    return {
      nativeCorePath: null,
      repairNote: `${cacheCheckNote}；${repaired.repairNote}`,
    };
  }
  return repaired;
}
