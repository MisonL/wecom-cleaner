import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SERVICE_DIRECT_DELETE_ACK,
  SERVICE_LOGIN_LABEL,
  SERVICE_SCHEDULE_LABEL,
  buildLaunchAgentPlist,
  computeNextTriggerAt,
  defaultServiceConfig,
  normalizeServiceConfig,
  normalizeTriggerTimes,
  parseFilesystemUsage,
  resolveServicePlistPaths,
} from '../src/service-manager.js';

test('normalizeServiceConfig 使用默认值并规范触发时间', () => {
  const config = normalizeServiceConfig({
    enabled: true,
    retainDays: 180,
    triggerTimes: ['9:30', '13:30', '18:30', '13:30'],
    deleteMode: 'direct',
    directDeleteApproved: true,
  });

  assert.equal(config.enabled, true);
  assert.equal(config.retainDays, 180);
  assert.deepEqual(config.triggerTimes, ['09:30', '13:30', '18:30']);
  assert.equal(config.deleteMode, 'direct');
  assert.equal(config.directDeleteApproved, true);
});

test('normalizeTriggerTimes 会回退到默认时间', () => {
  assert.deepEqual(normalizeTriggerTimes(['xx', '']), defaultServiceConfig().triggerTimes);
});

test('buildLaunchAgentPlist 可生成登录与定时任务配置', () => {
  const loginPlist = buildLaunchAgentPlist({
    label: SERVICE_LOGIN_LABEL,
    programArguments: ['/usr/local/bin/node', '/tmp/cli.js', '--service-run'],
    stdoutPath: '/tmp/service.log',
    stderrPath: '/tmp/service.err',
    runAtLoad: true,
  });
  const schedulePlist = buildLaunchAgentPlist({
    label: SERVICE_SCHEDULE_LABEL,
    programArguments: ['/usr/local/bin/node', '/tmp/cli.js', '--service-run'],
    stdoutPath: '/tmp/service.log',
    stderrPath: '/tmp/service.err',
    triggerTimes: ['09:30', '13:30', '18:30'],
  });

  assert.match(loginPlist, /RunAtLoad/);
  assert.match(loginPlist, /<true\/>/);
  assert.match(schedulePlist, /StartCalendarInterval/);
  assert.match(schedulePlist, /<integer>9<\/integer>|<integer>09<\/integer>/);
});

test('resolveServicePlistPaths 生成双 plist 路径', () => {
  const paths = resolveServicePlistPaths('/Users/demo');
  assert.match(paths.login, /com\.mison\.wecom-cleaner\.service\.login\.plist$/);
  assert.match(paths.schedule, /com\.mison\.wecom-cleaner\.service\.schedule\.plist$/);
});

test('computeNextTriggerAt 返回下一个定时触发点', () => {
  const now = new Date('2026-03-15T10:00:00+08:00').getTime();
  const next = computeNextTriggerAt(['09:30', '13:30', '18:30'], now);
  const expected = new Date('2026-03-15T13:30:00+08:00').getTime();
  assert.equal(next, expected);
});

test('parseFilesystemUsage 可解析 df -kP 输出', () => {
  const usage = parseFilesystemUsage(`Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/disk3s1 1000000 250000 750000 25% /System/Volumes/Data`);
  assert.equal(usage.totalBytes, 1000000 * 1024);
  assert.equal(usage.availableBytes, 750000 * 1024);
  assert.equal(usage.usedPercent, 25);
  assert.equal(usage.mountPoint, '/System/Volumes/Data');
});

test('服务直接删除确认常量稳定', () => {
  assert.equal(SERVICE_DIRECT_DELETE_ACK, 'SERVICE_DIRECT_DELETE');
});
