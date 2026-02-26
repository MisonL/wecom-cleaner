import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectRecycleStats, normalizeRecycleRetention } from './recycle-maintenance.js';
import { detectExternalStorageRoots, discoverAccounts } from './scanner.js';

const STATUS_PASS = 'pass';
const STATUS_WARN = 'warn';
const STATUS_FAIL = 'fail';
const DEFAULT_PROBE_TIMEOUT_MS = 3_000;

function resolveProbeTimeoutMs() {
  const raw = Number.parseInt(String(process.env.WECOM_CLEANER_NATIVE_PROBE_TIMEOUT_MS || ''), 10);
  if (Number.isFinite(raw) && raw >= 500) {
    return raw;
  }
  return DEFAULT_PROBE_TIMEOUT_MS;
}

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

async function pathExists(targetPath) {
  return fs
    .stat(targetPath)
    .then(() => true)
    .catch(() => false);
}

async function pathWritable(targetPath) {
  try {
    await fs.access(targetPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function pathReadable(targetPath) {
  try {
    await fs.access(targetPath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function buildCheck(id, title, status, detail, suggestion = '') {
  return {
    id,
    title,
    status,
    detail,
    suggestion,
  };
}

function probeNativeBinary(binPath) {
  const timeoutMs = resolveProbeTimeoutMs();
  const probe = spawnSync(binPath, ['--ping'], {
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
    timeout: timeoutMs,
  });

  if (probe.error) {
    if (probe.error?.code === 'ETIMEDOUT') {
      return {
        ok: false,
        detail: `探针超时(${timeoutMs}ms)`,
      };
    }
    return {
      ok: false,
      detail: `探针异常(${probe.error.message || 'unknown'})`,
    };
  }

  if (probe.signal) {
    return {
      ok: false,
      detail: `探针被信号中断(${probe.signal})`,
    };
  }

  if (probe.status !== 0) {
    return {
      ok: false,
      detail: `探针失败(${probe.status ?? 'unknown'})`,
    };
  }

  try {
    const payload = JSON.parse(String(probe.stdout || '').trim());
    if (payload?.ok === true && payload?.engine === 'zig') {
      return {
        ok: true,
        detail: '探针通过',
      };
    }
    return {
      ok: false,
      detail: '探针返回格式异常',
    };
  } catch {
    return {
      ok: false,
      detail: '探针输出非JSON',
    };
  }
}

function overallStatus(checks) {
  if (checks.some((item) => item.status === STATUS_FAIL)) {
    return STATUS_FAIL;
  }
  if (checks.some((item) => item.status === STATUS_WARN)) {
    return STATUS_WARN;
  }
  return STATUS_PASS;
}

async function readManifest(projectRoot) {
  const manifestPath = path.join(projectRoot, 'native', 'manifest.json');
  try {
    const text = await fs.readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(text);
    return {
      manifestPath,
      exists: true,
      parsed,
    };
  } catch {
    return {
      manifestPath,
      exists: false,
      parsed: null,
    };
  }
}

export async function runDoctor({ config, aliases, projectRoot, appVersion }) {
  const checks = [];
  const rootDir = path.resolve(String(config.rootDir || ''));
  const stateRoot = path.resolve(String(config.stateRoot || ''));
  const recycleRoot = path.resolve(String(config.recycleRoot || ''));
  const indexDir = path.dirname(
    path.resolve(String(config.indexPath || path.join(stateRoot, 'index.jsonl')))
  );

  const rootExists = await pathExists(rootDir);
  const rootReadable = rootExists ? await pathReadable(rootDir) : false;
  checks.push(
    buildCheck(
      'profile_root',
      'Profile 根目录',
      rootExists && rootReadable ? STATUS_PASS : STATUS_FAIL,
      rootExists ? (rootReadable ? `可读: ${rootDir}` : `存在但不可读: ${rootDir}`) : `不存在: ${rootDir}`,
      rootExists && rootReadable ? '' : '请在“交互配置”中修正根目录并确认权限。'
    )
  );

  const stateExists = await pathExists(stateRoot);
  const stateWritable = stateExists ? await pathWritable(stateRoot) : false;
  checks.push(
    buildCheck(
      'state_root',
      '状态目录',
      stateExists && stateWritable ? STATUS_PASS : stateExists ? STATUS_WARN : STATUS_FAIL,
      stateExists
        ? stateWritable
          ? `可写: ${stateRoot}`
          : `存在但不可写: ${stateRoot}`
        : `不存在: ${stateRoot}`,
      stateExists && stateWritable ? '' : '请确认状态目录存在且当前用户有写权限。'
    )
  );

  const recycleExists = await pathExists(recycleRoot);
  const recycleWritable = recycleExists ? await pathWritable(recycleRoot) : false;
  checks.push(
    buildCheck(
      'recycle_root',
      '回收区目录',
      recycleExists && recycleWritable ? STATUS_PASS : recycleExists ? STATUS_WARN : STATUS_FAIL,
      recycleExists
        ? recycleWritable
          ? `可写: ${recycleRoot}`
          : `存在但不可写: ${recycleRoot}`
        : `不存在: ${recycleRoot}`,
      recycleExists && recycleWritable ? '' : '请确认回收区目录可写，避免删除/恢复失败。'
    )
  );

  const indexDirExists = await pathExists(indexDir);
  const indexDirWritable = indexDirExists ? await pathWritable(indexDir) : false;
  checks.push(
    buildCheck(
      'index_dir',
      '索引目录',
      indexDirExists && indexDirWritable ? STATUS_PASS : indexDirExists ? STATUS_WARN : STATUS_FAIL,
      indexDirExists
        ? indexDirWritable
          ? `可写: ${indexDir}`
          : `存在但不可写: ${indexDir}`
        : `不存在: ${indexDir}`,
      indexDirExists && indexDirWritable ? '' : '请确认 index.jsonl 所在目录可写。'
    )
  );

  const accounts = await discoverAccounts(rootDir, aliases || {});
  checks.push(
    buildCheck(
      'accounts',
      '账号发现',
      accounts.length > 0 ? STATUS_PASS : STATUS_WARN,
      `识别到 ${accounts.length} 个账号`,
      accounts.length > 0 ? '' : '请确认 Profile 根目录是否指向真实企业微信数据目录。'
    )
  );

  const externalStorage = await detectExternalStorageRoots({
    configuredRoots: config.externalStorageRoots,
    profilesRoot: rootDir,
    autoDetect: config.externalStorageAutoDetect !== false,
    returnMeta: true,
  });
  const sourceCounts = externalStorage.meta?.sourceCounts || { builtin: 0, configured: 0, auto: 0 };
  checks.push(
    buildCheck(
      'external_storage',
      '文件存储目录识别',
      externalStorage.roots.length > 0 ? STATUS_PASS : STATUS_WARN,
      `共 ${externalStorage.roots.length} 个（默认${sourceCounts.builtin || 0}/手动${sourceCounts.configured || 0}/自动${sourceCounts.auto || 0}）`,
      externalStorage.roots.length > 0 ? '' : '若您修改过企业微信文件存储路径，请在设置中手动追加。'
    )
  );

  const target = resolveRuntimeTarget();
  const manifest = await readManifest(projectRoot);
  const manifestTarget = manifest.parsed?.targets?.[target.targetTag] || null;
  const manifestVersion = String(manifest.parsed?.version || '').trim();
  const versionMatched = manifestVersion && appVersion ? manifestVersion === appVersion : true;

  checks.push(
    buildCheck(
      'native_manifest',
      'Native 清单(manifest)',
      manifest.exists && manifestTarget ? (versionMatched ? STATUS_PASS : STATUS_WARN) : STATUS_WARN,
      manifest.exists
        ? manifestTarget
          ? `存在目标 ${target.targetTag}${manifestVersion ? `，版本 ${manifestVersion}` : ''}`
          : `缺少目标 ${target.targetTag}`
        : 'manifest.json 不存在',
      manifest.exists && manifestTarget
        ? versionMatched
          ? ''
          : `manifest 版本(${manifestVersion})与应用版本(${appVersion})不一致，建议发布时同步。`
        : '请检查 native/manifest.json 是否包含当前平台目标。'
    )
  );

  const bundledPath = path.join(projectRoot, 'native', 'bin', target.targetTag, target.binaryName);
  const bundledExists = await pathExists(bundledPath);
  const bundledProbe = bundledExists ? probeNativeBinary(bundledPath) : { ok: false, detail: '未找到二进制' };
  checks.push(
    buildCheck(
      'native_bundled',
      '随包 Zig 核心',
      bundledProbe.ok ? STATUS_PASS : STATUS_WARN,
      bundledExists ? `${bundledPath}（${bundledProbe.detail}）` : `缺失: ${bundledPath}`,
      bundledProbe.ok ? '' : '可执行 npm run build:native:release 重新构建。'
    )
  );

  const cachedPath = path.join(stateRoot, 'native-cache', target.targetTag, target.binaryName);
  const cachedExists = await pathExists(cachedPath);
  const cachedProbe = cachedExists ? probeNativeBinary(cachedPath) : { ok: false, detail: '未命中缓存' };
  checks.push(
    buildCheck(
      'native_cache',
      '缓存 Zig 核心',
      cachedProbe.ok ? STATUS_PASS : STATUS_WARN,
      cachedExists ? `${cachedPath}（${cachedProbe.detail}）` : `缺失: ${cachedPath}`,
      cachedProbe.ok ? '' : '首次运行可由自动修复下载，或手动构建后再运行。'
    )
  );

  const retention = normalizeRecycleRetention(config.recycleRetention);
  const recycleStats = await collectRecycleStats({
    indexPath: config.indexPath,
    recycleRoot: config.recycleRoot,
    createIfMissing: false,
  });
  const thresholdBytes = Math.max(1, Number(retention.sizeThresholdGB || 20)) * 1024 * 1024 * 1024;
  const recycleOverThreshold = recycleStats.totalBytes > thresholdBytes;
  checks.push(
    buildCheck(
      'recycle_health',
      '回收区健康',
      recycleOverThreshold ? STATUS_WARN : STATUS_PASS,
      `批次 ${recycleStats.totalBatches} 个，容量 ${recycleStats.totalBytes} bytes，阈值 ${thresholdBytes} bytes`,
      recycleOverThreshold ? '建议执行回收区治理（--recycle-maintain）。' : ''
    )
  );

  const summary = {
    pass: checks.filter((item) => item.status === STATUS_PASS).length,
    warn: checks.filter((item) => item.status === STATUS_WARN).length,
    fail: checks.filter((item) => item.status === STATUS_FAIL).length,
  };

  const recommendations = checks.filter((item) => item.suggestion).map((item) => item.suggestion);

  return {
    generatedAt: Date.now(),
    overall: overallStatus(checks),
    runtime: {
      os: target.osTag,
      arch: target.archTag,
      targetTag: target.targetTag,
    },
    checks,
    summary,
    metrics: {
      accountCount: accounts.length,
      externalStorageCount: externalStorage.roots.length,
      recycleBatchCount: recycleStats.totalBatches,
      recycleBytes: recycleStats.totalBytes,
      recycleThresholdBytes: thresholdBytes,
      recycleOverThreshold,
    },
    recommendations,
  };
}
