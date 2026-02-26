#!/usr/bin/env node
import { installSkill, resolveDefaultSkillsRoot } from './skill-installer.js';

function printHelp() {
  console.log(`wecom-cleaner-skill

用法：
  wecom-cleaner-skill install [--target <目录>] [--force] [--dry-run]
  wecom-cleaner-skill path

说明：
  - install: 安装 wecom-cleaner-agent 到 Codex 技能目录
  - path: 输出默认技能目录（由 CODEX_HOME 或 ~/.codex 推导）
`);
}

function parseArgs(argv) {
  const parsed = {
    command: 'install',
    target: '',
    force: false,
    dryRun: false,
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
    if (token === '--target') {
      const next = tokens[i + 1];
      if (!next || next.startsWith('-')) {
        throw new Error('参数 --target 缺少目录值');
      }
      parsed.target = next;
      i += 1;
      continue;
    }
    throw new Error(`未知参数: ${token}`);
  }

  return parsed;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));

    if (args.help) {
      printHelp();
      return;
    }

    if (args.command === 'path') {
      console.log(resolveDefaultSkillsRoot());
      return;
    }

    if (args.command !== 'install') {
      throw new Error(`不支持的命令: ${args.command}`);
    }

    const result = await installSkill({
      targetRoot: args.target,
      force: args.force,
      dryRun: args.dryRun,
    });

    const mode = result.dryRun ? '预演' : '安装';
    const replaceText = result.replaced ? '（覆盖已存在版本）' : '';
    console.log(`${mode}成功${replaceText}`);
    console.log(`技能: ${result.skillName}`);
    console.log(`目标: ${result.targetSkillDir}`);
  } catch (error) {
    console.error(`执行失败: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
