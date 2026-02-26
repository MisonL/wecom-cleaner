import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempDir, removeDir } from './helpers/temp.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..');
const SCRIPTS_ROOT = path.join(REPO_ROOT, 'skills', 'wecom-cleaner-agent', 'scripts');

function hasCommand(commandName) {
  const result = spawnSync('bash', ['-lc', `command -v ${commandName}`], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  return result.status === 0;
}

const HAS_JQ = hasCommand('jq');

async function createMockWecomCleaner(binDir, exitCode = 9, stderrText = 'mock fail') {
  const mockPath = path.join(binDir, 'wecom-cleaner');
  const script = [
    '#!/usr/bin/env bash',
    `echo "${String(stderrText).replace(/"/g, '\\"')}" >&2`,
    `exit ${Number(exitCode)}`,
    '',
  ].join('\n');
  await fs.writeFile(mockPath, script, 'utf-8');
  await fs.chmod(mockPath, 0o755);
}

const SCRIPT_CASES = [
  {
    script: 'cleanup_monthly_report.sh',
    args: ['--cutoff-month', '2024-07'],
    stderrPattern: /执行失败（dry-run=true）|执行失败/,
  },
  {
    script: 'analysis_report.sh',
    args: [],
    stderrPattern: /执行失败/,
  },
  {
    script: 'space_governance_report.sh',
    args: [],
    stderrPattern: /执行失败（dry-run=true）|执行失败/,
  },
  {
    script: 'restore_batch_report.sh',
    args: ['--batch-id', 'batch-mock'],
    stderrPattern: /执行失败（dry-run=true）|执行失败/,
  },
  {
    script: 'recycle_maintain_report.sh',
    args: [],
    stderrPattern: /执行失败（dry-run=true）|执行失败/,
  },
  {
    script: 'doctor_report.sh',
    args: [],
    stderrPattern: /执行失败/,
  },
  {
    script: 'check_update_report.sh',
    args: [],
    stderrPattern: /执行失败/,
  },
  {
    script: 'upgrade_report.sh',
    args: [],
    stderrPattern: /执行失败/,
  },
];

for (const item of SCRIPT_CASES) {
  test(`报告脚本失败分支返回非0且无变量解析异常: ${item.script}`, async (t) => {
    if (!HAS_JQ) {
      t.skip('系统未安装 jq，跳过脚本回归。');
      return;
    }

    const root = await makeTempDir('wecom-agent-script-fail-');
    t.after(async () => removeDir(root));

    const binDir = path.join(root, 'bin');
    await fs.mkdir(binDir, { recursive: true });
    await createMockWecomCleaner(binDir);

    const scriptPath = path.join(SCRIPTS_ROOT, item.script);
    const result = spawnSync('bash', [scriptPath, ...item.args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ''}`,
      },
      encoding: 'utf-8',
    });

    assert.notEqual(result.status, 0);
    assert.match(String(result.stderr || ''), item.stderrPattern);
    assert.equal(/unbound variable/i.test(String(result.stderr || '')), false);
  });
}
