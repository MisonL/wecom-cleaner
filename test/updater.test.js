import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyUpdateCheckResult,
  checkLatestVersion,
  compareVersion,
  defaultSelfUpdateConfig,
  githubSkillInstallScriptUrl,
  normalizeSelfUpdateConfig,
  runSkillsUpgrade,
  resolveCheckSlot,
  runUpgrade,
  shouldCheckForUpdate,
  shouldSkipVersion,
  updateWarningMessage,
} from '../src/updater.js';

function createMockFetch(routes) {
  return async (url) => {
    const key = String(url);
    const route = routes[key];
    if (!route) {
      return {
        ok: false,
        status: 404,
        async json() {
          return {};
        },
      };
    }
    if (route.throwError) {
      throw route.throwError;
    }
    return {
      ok: route.ok !== false,
      status: route.status || 200,
      async json() {
        return route.body;
      },
    };
  };
}

test('compareVersion 支持稳定版与预发布比较', () => {
  assert.equal(compareVersion('1.2.0', '1.2.0'), 0);
  assert.equal(compareVersion('1.3.0', '1.2.9'), 1);
  assert.equal(compareVersion('1.2.0-beta.1', '1.2.0'), -1);
  assert.equal(compareVersion('1.2.0-beta.2', '1.2.0-beta.1'), 1);
});

test('resolveCheckSlot 与 shouldCheckForUpdate 按三时段工作', () => {
  const base = normalizeSelfUpdateConfig(defaultSelfUpdateConfig());
  const morning = new Date('2026-02-27T06:00:00+08:00').getTime();
  const noon = new Date('2026-02-27T12:00:00+08:00').getTime();
  const night = new Date('2026-02-27T01:00:00+08:00').getTime();

  assert.equal(resolveCheckSlot(new Date(morning)), 'morning');
  assert.equal(resolveCheckSlot(new Date(noon)), 'noon');
  assert.equal(resolveCheckSlot(new Date(night)), '');

  const due = shouldCheckForUpdate(base, morning);
  assert.equal(due.shouldCheck, true);
  assert.equal(due.slot, 'morning');

  const checked = shouldCheckForUpdate(
    {
      ...base,
      lastCheckAt: morning,
      lastCheckSlot: 'morning',
    },
    morning + 60_000
  );
  assert.equal(checked.shouldCheck, false);
  assert.equal(checked.reason, 'already_checked_in_slot');
});

test('checkLatestVersion 默认优先 npm 源', async () => {
  const fetchImpl = createMockFetch({
    'https://registry.npmjs.org/%40mison%2Fwecom-cleaner': {
      body: {
        'dist-tags': {
          latest: '1.3.0',
          next: '1.4.0-beta.1',
        },
      },
    },
  });
  const result = await checkLatestVersion({
    currentVersion: '1.2.1',
    packageName: '@mison/wecom-cleaner',
    githubOwner: 'MisonL',
    githubRepo: 'wecom-cleaner',
    channel: 'stable',
    fetchImpl,
  });
  assert.equal(result.checked, true);
  assert.equal(result.sourceUsed, 'npm');
  assert.equal(result.latestVersion, '1.3.0');
  assert.equal(result.hasUpdate, true);
});

test('checkLatestVersion 在 npm 失败时回退 GitHub', async () => {
  const fetchImpl = createMockFetch({
    'https://registry.npmjs.org/%40mison%2Fwecom-cleaner': {
      ok: false,
      status: 500,
      body: {},
    },
    'https://api.github.com/repos/MisonL/wecom-cleaner/releases/latest': {
      body: {
        tag_name: 'v1.3.1',
      },
    },
  });
  const result = await checkLatestVersion({
    currentVersion: '1.2.1',
    packageName: '@mison/wecom-cleaner',
    githubOwner: 'MisonL',
    githubRepo: 'wecom-cleaner',
    channel: 'stable',
    fetchImpl,
  });
  assert.equal(result.checked, true);
  assert.equal(result.sourceUsed, 'github');
  assert.equal(result.latestVersion, '1.3.1');
  assert.equal(Array.isArray(result.errors), true);
  assert.equal(result.errors.length >= 1, true);
});

test('applyUpdateCheckResult 与跳过版本提示', () => {
  const cfg = normalizeSelfUpdateConfig(defaultSelfUpdateConfig());
  const state = applyUpdateCheckResult(
    cfg,
    {
      latestVersion: '1.3.0',
      sourceUsed: 'npm',
      checkedAt: 12345,
    },
    'noon'
  );
  assert.equal(state.lastCheckSlot, 'noon');
  assert.equal(state.lastKnownLatest, '1.3.0');
  assert.equal(state.lastKnownSource, 'npm');

  const check = {
    hasUpdate: true,
    currentVersion: '1.2.1',
    latestVersion: '1.3.0',
    sourceUsed: 'npm',
  };
  assert.equal(shouldSkipVersion(check, '1.3.0'), true);
  assert.equal(updateWarningMessage(check, '1.3.0'), '');
  assert.match(updateWarningMessage(check, ''), /检测到新版本/);
});

test('runUpgrade 可构造 npm 与 github-script 命令，并透传 skills 同步开关', () => {
  const calls = [];
  const runCommand = (cmd, args) => {
    calls.push([cmd, args]);
    return { status: 0, stdout: 'ok', stderr: '', error: null };
  };

  const npmResult = runUpgrade({
    method: 'npm',
    packageName: '@mison/wecom-cleaner',
    targetVersion: '1.3.0',
    githubOwner: 'MisonL',
    githubRepo: 'wecom-cleaner',
    runCommand,
  });
  assert.equal(npmResult.ok, true);
  assert.match(npmResult.command, /npm i -g/);

  const githubResult = runUpgrade({
    method: 'github-script',
    packageName: '@mison/wecom-cleaner',
    targetVersion: '1.3.0',
    syncSkills: false,
    githubOwner: 'MisonL',
    githubRepo: 'wecom-cleaner',
    runCommand,
  });
  assert.equal(githubResult.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], 'bash');
  assert.match(githubResult.command, /raw\.githubusercontent\.com/);
  assert.match(githubResult.command, /--sync-skills false/);
});

test('runSkillsUpgrade 可构造 npm 与 github-script 命令', () => {
  const calls = [];
  const runCommand = (cmd, args) => {
    calls.push([cmd, args]);
    return { status: 0, stdout: 'ok', stderr: '', error: null };
  };

  const npmResult = runSkillsUpgrade({
    method: 'npm',
    targetVersion: '1.3.2',
    targetRoot: '/tmp/skills',
    githubOwner: 'MisonL',
    githubRepo: 'wecom-cleaner',
    runCommand,
  });
  assert.equal(npmResult.ok, true);
  assert.match(npmResult.command, /wecom-cleaner-skill install --force/);

  const githubResult = runSkillsUpgrade({
    method: 'github-script',
    targetVersion: '1.3.2',
    githubOwner: 'MisonL',
    githubRepo: 'wecom-cleaner',
    runCommand,
  });
  assert.equal(githubResult.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], 'bash');
  assert.match(githubResult.command, /install-skill\.sh/);
  assert.equal(
    githubSkillInstallScriptUrl({
      owner: 'MisonL',
      repo: 'wecom-cleaner',
      version: '1.3.2',
    }),
    'https://raw.githubusercontent.com/MisonL/wecom-cleaner/v1.3.2/scripts/install-skill.sh'
  );
});
