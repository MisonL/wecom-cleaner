import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { DELETE_MODES } from './constants.js';
import { ensureDir, expandHome, pathExists, readJson, writeJson } from './utils.js';

export const SERVICE_LOGIN_LABEL = 'com.mison.wecom-cleaner.service.login';
export const SERVICE_SCHEDULE_LABEL = 'com.mison.wecom-cleaner.service.schedule';
export const SERVICE_LOGIN_TRIGGER = 'service_login';
export const SERVICE_SCHEDULE_TRIGGER = 'service_schedule';
export const SERVICE_LOW_SPACE_TRIGGER = 'service_low_space';
export const SERVICE_MANUAL_TRIGGER = 'service_manual';
export const SERVICE_DIRECT_DELETE_ACK = 'SERVICE_DIRECT_DELETE';
const DEFAULT_TRIGGER_TIMES = ['09:30', '13:30', '18:30'];

function normalizePositiveInt(rawValue, fallbackValue, minValue = 1) {
  const num = Number.parseInt(String(rawValue ?? ''), 10);
  if (!Number.isFinite(num) || num < minValue) {
    return fallbackValue;
  }
  return num;
}

function normalizeTimeToken(rawValue) {
  const text = String(rawValue || '').trim();
  const matched = text.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!matched) {
    return '';
  }
  const hour = Number.parseInt(matched[1], 10);
  const minute = Number.parseInt(matched[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return '';
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function normalizeTriggerTimes(values, fallback = DEFAULT_TRIGGER_TIMES) {
  const source = Array.isArray(values) ? values : [];
  const normalized = [
    ...new Set(
      source
        .map((item) => normalizeTimeToken(item))
        .filter(Boolean)
        .sort()
    ),
  ];
  if (normalized.length > 0) {
    return normalized;
  }
  return [...fallback];
}

export function defaultServiceConfig() {
  return {
    enabled: false,
    accounts: ['all'],
    categories: [],
    includeNonMonthDirs: false,
    externalRootsSource: ['all'],
    retainDays: 30,
    deleteMode: DELETE_MODES.SERVICE_RECYCLE,
    directDeleteApproved: false,
    recycleRetentionDays: 30,
    recycleMinKeepBatches: 3,
    recycleThresholdGB: 20,
    lowSpaceThresholdGB: 20,
    lowSpaceThresholdPercent: 10,
    triggerTimes: [...DEFAULT_TRIGGER_TIMES],
    cooldownMinutes: 15,
    installedAt: 0,
    updatedAt: 0,
  };
}

export function normalizeServiceConfig(input = {}, fallback = defaultServiceConfig()) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : Boolean(fallback.enabled),
    accounts:
      Array.isArray(source.accounts) && source.accounts.length > 0
        ? [...new Set(source.accounts.map((item) => String(item || '').trim()).filter(Boolean))]
        : [...fallback.accounts],
    categories:
      Array.isArray(source.categories) && source.categories.length > 0
        ? [...new Set(source.categories.map((item) => String(item || '').trim()).filter(Boolean))]
        : [...fallback.categories],
    includeNonMonthDirs:
      typeof source.includeNonMonthDirs === 'boolean'
        ? source.includeNonMonthDirs
        : Boolean(fallback.includeNonMonthDirs),
    externalRootsSource:
      Array.isArray(source.externalRootsSource) && source.externalRootsSource.length > 0
        ? [...new Set(source.externalRootsSource.map((item) => String(item || '').trim()).filter(Boolean))]
        : [...fallback.externalRootsSource],
    retainDays: normalizePositiveInt(source.retainDays, fallback.retainDays),
    deleteMode:
      source.deleteMode === DELETE_MODES.DIRECT ? DELETE_MODES.DIRECT : DELETE_MODES.SERVICE_RECYCLE,
    directDeleteApproved:
      typeof source.directDeleteApproved === 'boolean'
        ? source.directDeleteApproved
        : Boolean(fallback.directDeleteApproved),
    recycleRetentionDays: normalizePositiveInt(source.recycleRetentionDays, fallback.recycleRetentionDays),
    recycleMinKeepBatches: normalizePositiveInt(source.recycleMinKeepBatches, fallback.recycleMinKeepBatches),
    recycleThresholdGB: normalizePositiveInt(source.recycleThresholdGB, fallback.recycleThresholdGB),
    lowSpaceThresholdGB: normalizePositiveInt(source.lowSpaceThresholdGB, fallback.lowSpaceThresholdGB),
    lowSpaceThresholdPercent: normalizePositiveInt(
      source.lowSpaceThresholdPercent,
      fallback.lowSpaceThresholdPercent
    ),
    triggerTimes: normalizeTriggerTimes(source.triggerTimes, fallback.triggerTimes),
    cooldownMinutes: normalizePositiveInt(source.cooldownMinutes, fallback.cooldownMinutes),
    installedAt: Number.isFinite(Number(source.installedAt))
      ? Number(source.installedAt)
      : Number(fallback.installedAt || 0),
    updatedAt: Number.isFinite(Number(source.updatedAt))
      ? Number(source.updatedAt)
      : Number(fallback.updatedAt || 0),
  };
}

export function defaultServiceState() {
  return {
    lastRunAt: 0,
    lastCompletedAt: 0,
    lastStatus: 'never',
    lastTriggerSource: '',
    lastMessage: '',
    lastDeletedMode: '',
    lastDeletedTargets: 0,
    lastDeletedBytes: 0,
    lastServiceRecycleDeletedBytes: 0,
    lastLowSpaceTriggered: false,
    lastLowSpaceDeletedBytes: 0,
    lastWarnings: [],
  };
}

export function normalizeServiceState(input = {}, fallback = defaultServiceState()) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    lastRunAt: Number.isFinite(Number(source.lastRunAt))
      ? Number(source.lastRunAt)
      : Number(fallback.lastRunAt || 0),
    lastCompletedAt: Number.isFinite(Number(source.lastCompletedAt))
      ? Number(source.lastCompletedAt)
      : Number(fallback.lastCompletedAt || 0),
    lastStatus:
      typeof source.lastStatus === 'string' && source.lastStatus.trim()
        ? source.lastStatus.trim()
        : String(fallback.lastStatus || 'never'),
    lastTriggerSource: typeof source.lastTriggerSource === 'string' ? source.lastTriggerSource.trim() : '',
    lastMessage: typeof source.lastMessage === 'string' ? source.lastMessage.trim() : '',
    lastDeletedMode: typeof source.lastDeletedMode === 'string' ? source.lastDeletedMode.trim() : '',
    lastDeletedTargets: normalizePositiveInt(source.lastDeletedTargets, fallback.lastDeletedTargets, 0),
    lastDeletedBytes: normalizePositiveInt(source.lastDeletedBytes, fallback.lastDeletedBytes, 0),
    lastServiceRecycleDeletedBytes: normalizePositiveInt(
      source.lastServiceRecycleDeletedBytes,
      fallback.lastServiceRecycleDeletedBytes,
      0
    ),
    lastLowSpaceTriggered:
      typeof source.lastLowSpaceTriggered === 'boolean'
        ? source.lastLowSpaceTriggered
        : Boolean(fallback.lastLowSpaceTriggered),
    lastLowSpaceDeletedBytes: normalizePositiveInt(
      source.lastLowSpaceDeletedBytes,
      fallback.lastLowSpaceDeletedBytes,
      0
    ),
    lastWarnings:
      Array.isArray(source.lastWarnings) && source.lastWarnings.length > 0
        ? source.lastWarnings.map((item) => String(item || '').trim()).filter(Boolean)
        : Array.isArray(fallback.lastWarnings)
          ? [...fallback.lastWarnings]
          : [],
  };
}

export async function loadServiceConfig(configPath) {
  return normalizeServiceConfig(await readJson(configPath, {}));
}

export async function saveServiceConfig(configPath, serviceConfig) {
  await writeJson(configPath, normalizeServiceConfig(serviceConfig));
}

export async function loadServiceState(statePath) {
  return normalizeServiceState(await readJson(statePath, {}));
}

export async function saveServiceState(statePath, serviceState) {
  await writeJson(statePath, normalizeServiceState(serviceState));
}

export function resolveLaunchAgentsDir(homeDir = os.homedir()) {
  return path.join(expandHome(homeDir), 'Library', 'LaunchAgents');
}

export function resolveServicePlistPaths(homeDir = os.homedir()) {
  const dir = resolveLaunchAgentsDir(homeDir);
  return {
    login: path.join(dir, `${SERVICE_LOGIN_LABEL}.plist`),
    schedule: path.join(dir, `${SERVICE_SCHEDULE_LABEL}.plist`),
  };
}

function xmlEscape(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildProgramArgumentsXml(programArguments) {
  return (programArguments || []).map((item) => `    <string>${xmlEscape(item)}</string>`).join('\n');
}

function buildScheduleXml(triggerTimes) {
  return (triggerTimes || [])
    .map((timeText) => {
      const [hour, minute] = String(timeText)
        .split(':')
        .map((value) => Number.parseInt(value, 10));
      return [
        '    <dict>',
        '      <key>Hour</key>',
        `      <integer>${hour}</integer>`,
        '      <key>Minute</key>',
        `      <integer>${minute}</integer>`,
        '    </dict>',
      ].join('\n');
    })
    .join('\n');
}

export function buildLaunchAgentPlist({
  label,
  programArguments,
  stdoutPath,
  stderrPath,
  runAtLoad = false,
  triggerTimes = [],
}) {
  const scheduleXml =
    Array.isArray(triggerTimes) && triggerTimes.length > 0
      ? [
          '  <key>StartCalendarInterval</key>',
          '  <array>',
          buildScheduleXml(triggerTimes),
          '  </array>',
        ].join('\n')
      : '';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xmlEscape(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    buildProgramArgumentsXml(programArguments),
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${xmlEscape(process.cwd())}</string>`,
    '  <key>RunAtLoad</key>',
    runAtLoad ? '  <true/>' : '  <false/>',
    scheduleXml,
    '  <key>StandardOutPath</key>',
    `  <string>${xmlEscape(stdoutPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xmlEscape(stderrPath)}</string>`,
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '  <key>AbandonProcessGroup</key>',
    '  <true/>',
    '</dict>',
    '</plist>',
    '',
  ]
    .filter(Boolean)
    .join('\n');
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

function launchctlDomain(uid = process.getuid()) {
  return `gui/${uid}`;
}

function runLaunchctl(args, runCommand = defaultRunCommand) {
  return runCommand('launchctl', args);
}

function isLaunchctlSuccess(result) {
  return result.status === 0 && !result.error;
}

async function writeLaunchAgentFile(plistPath, content) {
  await ensureDir(path.dirname(plistPath));
  await fs.writeFile(plistPath, content, 'utf-8');
}

function stopLaunchAgent(label, plistPath, domain, runCommand) {
  const attempts = [
    ['bootout', domain, `${domain}/${label}`],
    ['bootout', domain, plistPath],
    ['remove', label],
  ];
  const results = attempts.map((args) => runLaunchctl(args, runCommand));
  return {
    ok: results.some((item) => item.status === 0),
    results,
  };
}

export async function installServiceLaunchAgents({
  nodePath,
  cliPath,
  stateRoot,
  triggerTimes = DEFAULT_TRIGGER_TIMES,
  homeDir = os.homedir(),
  uid = process.getuid(),
  runCommand = defaultRunCommand,
}) {
  const plistPaths = resolveServicePlistPaths(homeDir);
  const domain = launchctlDomain(uid);
  const stdoutPath = path.join(stateRoot, 'service.log');
  const stderrPath = path.join(stateRoot, 'service-error.log');

  const loginPlist = buildLaunchAgentPlist({
    label: SERVICE_LOGIN_LABEL,
    programArguments: [
      nodePath,
      cliPath,
      '--service-run',
      '--state-root',
      stateRoot,
      '--dry-run',
      'false',
      '--yes',
      '--service-trigger-source',
      SERVICE_LOGIN_TRIGGER,
      '--output',
      'json',
    ],
    stdoutPath,
    stderrPath,
    runAtLoad: true,
    triggerTimes: [],
  });
  const schedulePlist = buildLaunchAgentPlist({
    label: SERVICE_SCHEDULE_LABEL,
    programArguments: [
      nodePath,
      cliPath,
      '--service-run',
      '--state-root',
      stateRoot,
      '--dry-run',
      'false',
      '--yes',
      '--service-trigger-source',
      SERVICE_SCHEDULE_TRIGGER,
      '--output',
      'json',
    ],
    stdoutPath,
    stderrPath,
    runAtLoad: false,
    triggerTimes: normalizeTriggerTimes(triggerTimes),
  });

  await writeLaunchAgentFile(plistPaths.login, loginPlist);
  await writeLaunchAgentFile(plistPaths.schedule, schedulePlist);

  stopLaunchAgent(SERVICE_LOGIN_LABEL, plistPaths.login, domain, runCommand);
  stopLaunchAgent(SERVICE_SCHEDULE_LABEL, plistPaths.schedule, domain, runCommand);
  const loginLoad = runLaunchctl(['bootstrap', domain, plistPaths.login], runCommand);
  const scheduleLoad = runLaunchctl(['bootstrap', domain, plistPaths.schedule], runCommand);

  return {
    plistPaths,
    loginLoad,
    scheduleLoad,
    ok: isLaunchctlSuccess(loginLoad) && isLaunchctlSuccess(scheduleLoad),
  };
}

export async function uninstallServiceLaunchAgents({
  homeDir = os.homedir(),
  uid = process.getuid(),
  runCommand = defaultRunCommand,
}) {
  const plistPaths = resolveServicePlistPaths(homeDir);
  const domain = launchctlDomain(uid);
  const loginUnload = stopLaunchAgent(SERVICE_LOGIN_LABEL, plistPaths.login, domain, runCommand);
  const scheduleUnload = stopLaunchAgent(SERVICE_SCHEDULE_LABEL, plistPaths.schedule, domain, runCommand);
  await fs.rm(plistPaths.login, { force: true });
  await fs.rm(plistPaths.schedule, { force: true });
  return {
    plistPaths,
    loginUnload,
    scheduleUnload,
    ok: true,
  };
}

function queryLaunchLabel(label, uid, runCommand) {
  const domain = launchctlDomain(uid);
  return runLaunchctl(['print', `${domain}/${label}`], runCommand);
}

function summarizeLaunchResult(result) {
  return {
    loaded: isLaunchctlSuccess(result),
    status: Number(result.status || 0),
    stderr: String(result.stderr || ''),
  };
}

export function computeNextTriggerAt(triggerTimes, now = Date.now()) {
  const normalized = normalizeTriggerTimes(triggerTimes);
  const current = new Date(now);
  const candidates = normalized.map((timeText) => {
    const [hour, minute] = timeText.split(':').map((value) => Number.parseInt(value, 10));
    const candidate = new Date(current);
    candidate.setHours(hour, minute, 0, 0);
    if (candidate.getTime() <= now) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate.getTime();
  });
  return Math.min(...candidates);
}

export async function queryServiceStatus({
  stateRoot,
  serviceConfigPath,
  serviceStatePath,
  homeDir = os.homedir(),
  uid = process.getuid(),
  runCommand = defaultRunCommand,
}) {
  const plistPaths = resolveServicePlistPaths(homeDir);
  const [config, state] = await Promise.all([
    loadServiceConfig(serviceConfigPath),
    loadServiceState(serviceStatePath),
  ]);
  const [loginExists, scheduleExists] = await Promise.all([
    pathExists(plistPaths.login),
    pathExists(plistPaths.schedule),
  ]);
  const loginPrint = loginExists
    ? queryLaunchLabel(SERVICE_LOGIN_LABEL, uid, runCommand)
    : { status: 1, stdout: '', stderr: 'missing_plist', error: null };
  const schedulePrint = scheduleExists
    ? queryLaunchLabel(SERVICE_SCHEDULE_LABEL, uid, runCommand)
    : { status: 1, stdout: '', stderr: 'missing_plist', error: null };

  return {
    installed: loginExists || scheduleExists,
    login: summarizeLaunchResult(loginPrint),
    schedule: summarizeLaunchResult(schedulePrint),
    plistPaths,
    stateRoot,
    config,
    state,
    nextTriggerAt: computeNextTriggerAt(config.triggerTimes),
  };
}

export function parseFilesystemUsage(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    return null;
  }
  const row = lines[lines.length - 1].split(/\s+/);
  if (row.length < 6) {
    return null;
  }
  const totalKb = Number.parseInt(row[1], 10);
  const availableKb = Number.parseInt(row[3], 10);
  const usedPercent = Number.parseInt(String(row[4] || '').replace('%', ''), 10);
  if (!Number.isFinite(totalKb) || !Number.isFinite(availableKb)) {
    return null;
  }
  return {
    totalBytes: totalKb * 1024,
    availableBytes: availableKb * 1024,
    usedPercent: Number.isFinite(usedPercent) ? usedPercent : null,
    mountPoint: row[5] || '',
  };
}

export function readFilesystemUsage(targetPath, runCommand = defaultRunCommand) {
  const result = runCommand('df', ['-kP', targetPath]);
  if (!isLaunchctlSuccess(result)) {
    return null;
  }
  return parseFilesystemUsage(result.stdout);
}
