import { spawnSync } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_NPM_REGISTRY_BASE_URL = 'https://registry.npmjs.org';
const DEFAULT_GITHUB_API_BASE_URL = 'https://api.github.com';

function parseSemver(rawVersion) {
  const text = String(rawVersion || '')
    .trim()
    .replace(/^v/i, '');
  const matched = text.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!matched) {
    return null;
  }
  return {
    raw: text,
    major: Number.parseInt(matched[1], 10),
    minor: Number.parseInt(matched[2], 10),
    patch: Number.parseInt(matched[3], 10),
    prerelease: matched[4] || '',
  };
}

function comparePrerelease(a, b) {
  const aText = String(a || '');
  const bText = String(b || '');
  if (!aText && !bText) {
    return 0;
  }
  if (!aText) {
    return 1;
  }
  if (!bText) {
    return -1;
  }
  const aSegs = aText.split('.');
  const bSegs = bText.split('.');
  const max = Math.max(aSegs.length, bSegs.length);
  for (let i = 0; i < max; i += 1) {
    const aSeg = aSegs[i];
    const bSeg = bSegs[i];
    if (aSeg === undefined) {
      return -1;
    }
    if (bSeg === undefined) {
      return 1;
    }
    const aNum = /^\d+$/.test(aSeg) ? Number.parseInt(aSeg, 10) : null;
    const bNum = /^\d+$/.test(bSeg) ? Number.parseInt(bSeg, 10) : null;
    if (aNum !== null && bNum !== null) {
      if (aNum !== bNum) {
        return aNum > bNum ? 1 : -1;
      }
      continue;
    }
    if (aNum !== null) {
      return -1;
    }
    if (bNum !== null) {
      return 1;
    }
    if (aSeg !== bSeg) {
      return aSeg > bSeg ? 1 : -1;
    }
  }
  return 0;
}

export function compareVersion(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) {
    return 0;
  }
  if (left.major !== right.major) {
    return left.major > right.major ? 1 : -1;
  }
  if (left.minor !== right.minor) {
    return left.minor > right.minor ? 1 : -1;
  }
  if (left.patch !== right.patch) {
    return left.patch > right.patch ? 1 : -1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

export function isValidSemver(version) {
  return Boolean(parseSemver(version));
}

export function normalizeVersion(version) {
  const parsed = parseSemver(version);
  return parsed ? parsed.raw : '';
}

function isPrerelease(version) {
  const parsed = parseSemver(version);
  return Boolean(parsed?.prerelease);
}

export function defaultSelfUpdateConfig() {
  return {
    enabled: true,
    channel: 'stable',
    checkSchedule: 'tri_daily',
    autoCheckOnStartup: true,
    lastCheckAt: 0,
    lastCheckSlot: '',
    lastKnownLatest: '',
    lastKnownSource: '',
    skipVersion: '',
  };
}

export function normalizeSelfUpdateConfig(input, fallback = defaultSelfUpdateConfig()) {
  const source = input && typeof input === 'object' ? input : {};
  const fallbackConfig = fallback && typeof fallback === 'object' ? fallback : defaultSelfUpdateConfig();
  const channel =
    source.channel === 'pre' ? 'pre' : source.channel === 'stable' ? 'stable' : fallbackConfig.channel;
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : Boolean(fallbackConfig.enabled),
    channel,
    checkSchedule:
      typeof source.checkSchedule === 'string' && source.checkSchedule.trim()
        ? source.checkSchedule.trim()
        : fallbackConfig.checkSchedule,
    autoCheckOnStartup:
      typeof source.autoCheckOnStartup === 'boolean'
        ? source.autoCheckOnStartup
        : Boolean(fallbackConfig.autoCheckOnStartup),
    lastCheckAt: Number.isFinite(Number(source.lastCheckAt))
      ? Number(source.lastCheckAt)
      : Number(fallbackConfig.lastCheckAt || 0),
    lastCheckSlot:
      typeof source.lastCheckSlot === 'string' && source.lastCheckSlot.trim()
        ? source.lastCheckSlot.trim()
        : String(fallbackConfig.lastCheckSlot || ''),
    lastKnownLatest:
      typeof source.lastKnownLatest === 'string' && source.lastKnownLatest.trim()
        ? normalizeVersion(source.lastKnownLatest)
        : normalizeVersion(fallbackConfig.lastKnownLatest),
    lastKnownSource:
      typeof source.lastKnownSource === 'string' && source.lastKnownSource.trim()
        ? source.lastKnownSource.trim()
        : String(fallbackConfig.lastKnownSource || ''),
    skipVersion:
      typeof source.skipVersion === 'string' && source.skipVersion.trim()
        ? normalizeVersion(source.skipVersion)
        : normalizeVersion(fallbackConfig.skipVersion),
  };
}

export function resolveCheckSlot(now = new Date()) {
  const hour = Number(now.getHours());
  if (!Number.isFinite(hour)) {
    return '';
  }
  if (hour >= 5 && hour <= 10) {
    return 'morning';
  }
  if (hour >= 11 && hour <= 15) {
    return 'noon';
  }
  if (hour >= 16 && hour <= 23) {
    return 'evening';
  }
  return '';
}

function isSameLocalDay(tsA, tsB) {
  const dateA = new Date(Number(tsA || 0));
  const dateB = new Date(Number(tsB || 0));
  return (
    dateA.getFullYear() === dateB.getFullYear() &&
    dateA.getMonth() === dateB.getMonth() &&
    dateA.getDate() === dateB.getDate()
  );
}

export function shouldCheckForUpdate(config, now = Date.now()) {
  const normalized = normalizeSelfUpdateConfig(config);
  if (!normalized.enabled || !normalized.autoCheckOnStartup) {
    return { shouldCheck: false, reason: 'disabled', slot: '' };
  }
  if (normalized.checkSchedule !== 'tri_daily') {
    return { shouldCheck: true, reason: 'custom_schedule', slot: resolveCheckSlot(new Date(now)) };
  }
  const slot = resolveCheckSlot(new Date(now));
  if (!slot) {
    return { shouldCheck: false, reason: 'quiet_time', slot: '' };
  }
  if (
    normalized.lastCheckAt > 0 &&
    isSameLocalDay(normalized.lastCheckAt, now) &&
    normalized.lastCheckSlot === slot
  ) {
    return { shouldCheck: false, reason: 'already_checked_in_slot', slot };
  }
  return { shouldCheck: true, reason: 'slot_due', slot };
}

async function fetchJson(url, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'user-agent': 'wecom-cleaner-updater',
        accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeBaseUrl(input, fallback) {
  const raw = String(input || '')
    .trim()
    .replace(/\/+$/, '');
  if (!raw) {
    return fallback;
  }
  return raw;
}

export async function fetchLatestFromNpm({
  packageName,
  channel = 'stable',
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  registryBaseUrl = process.env.WECOM_CLEANER_UPDATE_NPM_REGISTRY_URL || DEFAULT_NPM_REGISTRY_BASE_URL,
}) {
  const encoded = encodeURIComponent(String(packageName || '').trim());
  const base = normalizeBaseUrl(registryBaseUrl, DEFAULT_NPM_REGISTRY_BASE_URL);
  const url = `${base}/${encoded}`;
  const payload = await fetchJson(url, fetchImpl, timeoutMs);
  const distTags = payload?.['dist-tags'] || {};
  const latest = channel === 'pre' ? distTags.next || distTags.latest : distTags.latest;
  const version = normalizeVersion(latest);
  if (!version) {
    throw new Error('npm_dist_tag_missing');
  }
  return {
    source: 'npm',
    version,
    raw: payload,
  };
}

function normalizeGitTagVersion(tagName) {
  const normalized = normalizeVersion(tagName);
  return normalized || '';
}

function pickGithubRelease(releases, channel) {
  const list = Array.isArray(releases) ? releases : [];
  if (channel === 'pre') {
    return list.find((item) => item && item.draft !== true) || null;
  }
  return list.find((item) => item && item.draft !== true && item.prerelease !== true) || null;
}

export async function fetchLatestFromGithub({
  owner,
  repo,
  channel = 'stable',
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  apiBaseUrl = process.env.WECOM_CLEANER_UPDATE_GITHUB_API_BASE_URL || DEFAULT_GITHUB_API_BASE_URL,
}) {
  const baseRoot = normalizeBaseUrl(apiBaseUrl, DEFAULT_GITHUB_API_BASE_URL);
  const base = `${baseRoot}/repos/${owner}/${repo}`;
  if (channel === 'stable') {
    const payload = await fetchJson(`${base}/releases/latest`, fetchImpl, timeoutMs);
    const version = normalizeGitTagVersion(payload?.tag_name);
    if (!version) {
      throw new Error('github_latest_tag_missing');
    }
    return {
      source: 'github',
      version,
      raw: payload,
    };
  }

  const releases = await fetchJson(`${base}/releases?per_page=20`, fetchImpl, timeoutMs);
  const selected = pickGithubRelease(releases, channel);
  const version = normalizeGitTagVersion(selected?.tag_name);
  if (!version) {
    throw new Error('github_release_not_found');
  }
  return {
    source: 'github',
    version,
    raw: selected,
  };
}

export async function checkLatestVersion({
  currentVersion,
  packageName,
  githubOwner,
  githubRepo,
  channel = 'stable',
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  reason = 'manual',
  npmRegistryBaseUrl = process.env.WECOM_CLEANER_UPDATE_NPM_REGISTRY_URL || DEFAULT_NPM_REGISTRY_BASE_URL,
  githubApiBaseUrl = process.env.WECOM_CLEANER_UPDATE_GITHUB_API_BASE_URL || DEFAULT_GITHUB_API_BASE_URL,
}) {
  const current = normalizeVersion(currentVersion);
  const normalizedChannel = channel === 'pre' ? 'pre' : 'stable';
  const errors = [];

  try {
    const npmResult = await fetchLatestFromNpm({
      packageName,
      channel: normalizedChannel,
      fetchImpl,
      timeoutMs,
      registryBaseUrl: npmRegistryBaseUrl,
    });
    const latest = npmResult.version;
    return {
      checked: true,
      currentVersion: current,
      latestVersion: latest,
      hasUpdate: compareVersion(latest, current) > 0,
      sourceUsed: 'npm',
      channel: normalizedChannel,
      checkReason: reason,
      checkedAt: Date.now(),
      errors,
      upgradeMethods: ['npm', 'github-script'],
    };
  } catch (error) {
    errors.push(`npm检查失败: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const githubResult = await fetchLatestFromGithub({
      owner: githubOwner,
      repo: githubRepo,
      channel: normalizedChannel,
      fetchImpl,
      timeoutMs,
      apiBaseUrl: githubApiBaseUrl,
    });
    const latest = githubResult.version;
    return {
      checked: true,
      currentVersion: current,
      latestVersion: latest,
      hasUpdate: compareVersion(latest, current) > 0,
      sourceUsed: 'github',
      channel: normalizedChannel,
      checkReason: reason,
      checkedAt: Date.now(),
      errors,
      upgradeMethods: ['npm', 'github-script'],
    };
  } catch (error) {
    errors.push(`github检查失败: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    checked: false,
    currentVersion: current,
    latestVersion: null,
    hasUpdate: false,
    sourceUsed: 'none',
    channel: normalizedChannel,
    checkReason: reason,
    checkedAt: Date.now(),
    errors,
    upgradeMethods: ['npm', 'github-script'],
  };
}

export function applyUpdateCheckResult(config, checkResult, slot = '') {
  const normalized = normalizeSelfUpdateConfig(config);
  const result = checkResult && typeof checkResult === 'object' ? checkResult : {};
  normalized.lastCheckAt = Number(result.checkedAt || Date.now());
  normalized.lastCheckSlot = slot || '';
  normalized.lastKnownLatest = normalizeVersion(result.latestVersion || '');
  normalized.lastKnownSource = String(result.sourceUsed || '');
  return normalized;
}

function buildVersionRef(version) {
  const normalized = normalizeVersion(version);
  if (!normalized) {
    return '';
  }
  return normalized.startsWith('v') ? normalized : `v${normalized}`;
}

export function githubUpgradeScriptUrl({ owner, repo, version }) {
  const ref = buildVersionRef(version) || 'main';
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/scripts/upgrade.sh`;
}

export function githubSkillInstallScriptUrl({ owner, repo, version }) {
  const ref = buildVersionRef(version) || 'main';
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/scripts/install-skill.sh`;
}

function defaultRunCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
  return {
    status: Number(result.status || 0),
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error || null,
  };
}

function shellEscapeArg(rawValue) {
  const value = String(rawValue || '');
  if (!value) {
    return "''";
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function runUpgrade({
  method,
  packageName,
  targetVersion,
  githubOwner,
  githubRepo,
  runCommand = defaultRunCommand,
}) {
  const chosen = method === 'github-script' ? 'github-script' : 'npm';
  const normalizedVersion = normalizeVersion(targetVersion);
  const npmSpec = normalizedVersion ? `${packageName}@${normalizedVersion}` : `${packageName}@latest`;

  if (chosen === 'npm') {
    const result = runCommand('npm', ['i', '-g', npmSpec]);
    return {
      method: chosen,
      targetVersion: normalizedVersion || 'latest',
      command: `npm i -g ${npmSpec}`,
      ok: result.status === 0 && !result.error,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error ? String(result.error.message || result.error) : '',
    };
  }

  const scriptUrl = githubUpgradeScriptUrl({
    owner: githubOwner,
    repo: githubRepo,
    version: normalizedVersion || 'main',
  });
  const versionArg = normalizedVersion ? ` --version ${normalizedVersion}` : '';
  const commandText = `curl -fsSL ${scriptUrl} | bash -s --${versionArg}`;
  const result = runCommand('bash', ['-lc', commandText]);
  return {
    method: chosen,
    targetVersion: normalizedVersion || 'latest',
    command: commandText,
    ok: result.status === 0 && !result.error,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error ? String(result.error.message || result.error) : '',
  };
}

export function runSkillsUpgrade({
  method,
  targetVersion,
  targetRoot = '',
  githubOwner,
  githubRepo,
  runCommand = defaultRunCommand,
}) {
  const chosen = method === 'github-script' ? 'github-script' : 'npm';
  const normalizedVersion = normalizeVersion(targetVersion);
  const normalizedTargetRoot = String(targetRoot || '').trim();

  if (chosen === 'npm') {
    const args = ['install', '--force'];
    if (normalizedTargetRoot) {
      args.push('--target', normalizedTargetRoot);
    }
    const result = runCommand('wecom-cleaner-skill', args);
    return {
      method: chosen,
      targetVersion: normalizedVersion || 'current',
      command: `wecom-cleaner-skill ${args.join(' ')}`,
      ok: result.status === 0 && !result.error,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error ? String(result.error.message || result.error) : '',
    };
  }

  const scriptUrl = githubSkillInstallScriptUrl({
    owner: githubOwner,
    repo: githubRepo,
    version: normalizedVersion || 'main',
  });
  const cmdParts = ['--force'];
  if (normalizedTargetRoot) {
    cmdParts.push('--target', shellEscapeArg(normalizedTargetRoot));
  }
  if (normalizedVersion) {
    cmdParts.push('--ref', shellEscapeArg(`v${normalizedVersion}`));
  }
  const commandText = `curl -fsSL ${scriptUrl} | bash -s -- ${cmdParts.join(' ')}`;
  const result = runCommand('bash', ['-lc', commandText]);
  return {
    method: chosen,
    targetVersion: normalizedVersion || 'current',
    command: commandText,
    ok: result.status === 0 && !result.error,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error ? String(result.error.message || result.error) : '',
  };
}

export function updateWarningMessage(checkResult, skipVersion = '') {
  const result = checkResult && typeof checkResult === 'object' ? checkResult : {};
  if (!result.hasUpdate) {
    return '';
  }
  const latest = normalizeVersion(result.latestVersion);
  const current = normalizeVersion(result.currentVersion);
  if (!latest || latest === normalizeVersion(skipVersion)) {
    return '';
  }
  return `检测到新版本 v${latest}（当前 v${current || 'unknown'}，来源 ${result.sourceUsed || 'unknown'}）。可使用 --upgrade npm --upgrade-yes 升级。`;
}

export function shouldSkipVersion(checkResult, skipVersion = '') {
  const latest = normalizeVersion(checkResult?.latestVersion || '');
  const skip = normalizeVersion(skipVersion || '');
  return Boolean(latest && skip && latest === skip);
}

export function channelLabel(channel) {
  return channel === 'pre' ? '预发布' : '稳定版';
}

export function normalizeUpgradeMethod(raw) {
  const value = String(raw || '')
    .trim()
    .toLowerCase();
  if (value === 'npm' || value === 'github-script') {
    return value;
  }
  return '';
}

export function normalizeUpgradeChannel(raw, fallback = 'stable') {
  const value = String(raw || '')
    .trim()
    .toLowerCase();
  if (value === 'stable' || value === 'pre') {
    return value;
  }
  return fallback === 'pre' ? 'pre' : 'stable';
}

export function filterByChannel(version, channel = 'stable') {
  if (!isValidSemver(version)) {
    return false;
  }
  if (channel === 'pre') {
    return true;
  }
  return !isPrerelease(version);
}
