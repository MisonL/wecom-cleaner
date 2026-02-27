#!/usr/bin/env node
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  installSkill,
  inspectSkillBinding,
  resolveDefaultSkillsRoot,
  skillBindingStatusLabel,
} from './skill-installer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

async function loadAppVersion() {
  try {
    const packagePath = path.join(PROJECT_ROOT, 'package.json');
    const text = await readFile(packagePath, 'utf-8');
    const pkg = JSON.parse(text);
    return String(pkg.version || '').trim();
  } catch {
    return '';
  }
}

function printHelp() {
  console.log(`wecom-cleaner-skill

用法：
  wecom-cleaner-skill install [--target <目录>] [--force] [--dry-run] [--json]
  wecom-cleaner-skill sync [--target <目录>] [--dry-run] [--json]
  wecom-cleaner-skill status [--target <目录>] [--app-version <x.y.z>] [--json]
  wecom-cleaner-skill path

说明：
  - install: 安装 wecom-cleaner-agent 到 Codex 技能目录
  - sync: 同步/升级技能版本（等价 install --force）
  - status: 检查技能是否与主程序版本匹配
  - path: 输出默认技能目录（由 CODEX_HOME 或 ~/.codex 推导）
`);
}

function parseArgs(argv) {
  const parsed = {
    command: 'install',
    target: '',
    force: false,
    dryRun: false,
    json: false,
    appVersion: '',
    help: false,
  };

  const tokens = [...argv];
  const first = tokens[0] || '';
  if (first && !first.startsWith('-')) {
    parsed.command = first;
    tokens.shift();
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '-h' || token === '--help') {
      parsed.help = true;
      continue;
    }
    if (token === '--force') {
      parsed.force = true;
      continue;
    }
    if (token === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (token === '--json') {
      parsed.json = true;
      continue;
    }
    if (token === '--target') {
      const next = tokens[i + 1];
      if (!next || next.startsWith('-')) {
        throw new Error('参数 --target 缺少目录值');
      }
      parsed.target = next;
      i += 1;
      continue;
    }
    if (token === '--app-version') {
      const next = tokens[i + 1];
      if (!next || next.startsWith('-')) {
        throw new Error('参数 --app-version 缺少版本值');
      }
      parsed.appVersion = next;
      i += 1;
      continue;
    }
    throw new Error(`未知参数: ${token}`);
  }

  return parsed;
}

function printStatusText(result) {
  console.log(`技能: ${result.skillName}`);
  console.log(`状态: ${skillBindingStatusLabel(result.status)}`);
  console.log(`匹配: ${result.matched ? '是' : '否'}`);
  console.log(`主程序版本: ${result.expectedAppVersion || '-'}`);
  console.log(`已安装: ${result.installed ? '是' : '否'}`);
  if (result.installedManifest?.skillVersion) {
    console.log(`技能版本: ${result.installedManifest.skillVersion}`);
  } else {
    console.log('技能版本: -');
  }
  if (result.installedManifest?.requiredAppVersion) {
    console.log(`技能绑定版本: ${result.installedManifest.requiredAppVersion}`);
  } else {
    console.log('技能绑定版本: -');
  }
  console.log(`目标目录: ${result.targetSkillDir}`);
  if (result.recommendation) {
    console.log(`建议: ${result.recommendation}`);
  }
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const appVersion = args.appVersion || (await loadAppVersion());

    if (args.help) {
      printHelp();
      return;
    }

    if (args.command === 'path') {
      console.log(resolveDefaultSkillsRoot());
      return;
    }

    if (args.command === 'status') {
      const status = await inspectSkillBinding({
        targetRoot: args.target,
        appVersion,
      });
      if (args.json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }
      printStatusText(status);
      process.exitCode = status.matched ? 0 : 1;
      return;
    }

    if (args.command !== 'install' && args.command !== 'sync') {
      throw new Error(`不支持的命令: ${args.command}`);
    }

    const force = args.command === 'sync' ? true : args.force;
    const result = await installSkill({
      targetRoot: args.target,
      force,
      dryRun: args.dryRun,
      appVersion,
    });
    const status = await inspectSkillBinding({
      targetRoot: args.target,
      appVersion,
    });

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            action: args.command,
            result,
            status,
          },
          null,
          2
        )
      );
      return;
    }

    const mode = result.dryRun ? '预演' : '安装';
    const replaceText = result.replaced ? '（覆盖已存在版本）' : '';
    console.log(`${mode}成功${replaceText}`);
    console.log(`技能: ${result.skillName}`);
    console.log(`技能版本: ${result.targetManifest.skillVersion}`);
    console.log(`绑定程序版本: ${result.targetManifest.requiredAppVersion}`);
    console.log(`目标: ${result.targetSkillDir}`);
    console.log(`匹配状态: ${skillBindingStatusLabel(status.status)}`);
    if (!status.matched && status.recommendation) {
      console.log(`建议: ${status.recommendation}`);
    }
  } catch (error) {
    console.error(`执行失败: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
