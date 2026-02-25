#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

function normalizePackedFileName(packageName, version) {
  const normalized = String(packageName || '')
    .replace(/^@/, '')
    .replace(/\//g, '-');
  return `${normalized}-${version}.tgz`;
}

function targetTgzName(packageName, version) {
  const unscoped =
    String(packageName || '')
      .split('/')
      .pop() || 'package';
  return `${unscoped}-${version}.tgz`;
}

async function main() {
  const cwd = process.cwd();
  const pkgPath = path.join(cwd, 'package.json');
  const pkgText = await fs.readFile(pkgPath, 'utf-8');
  const pkg = JSON.parse(pkgText);

  const packageName = String(pkg.name || '');
  const version = String(pkg.version || '0.0.0');
  const isDryRun = process.argv.includes('--dry-run');

  const args = ['pack'];
  if (isDryRun) {
    args.push('--dry-run');
  } else {
    // 固定输出到当前目录，避免受全局 npm pack-destination 配置影响
    args.push('--pack-destination', '.');
  }

  const result = spawnSync('npm', args, {
    stdio: 'inherit',
    cwd,
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }

  if (isDryRun) {
    return;
  }

  const srcName = normalizePackedFileName(packageName, version);
  const dstName = targetTgzName(packageName, version);
  if (srcName === dstName) {
    return;
  }

  const srcPath = path.join(cwd, srcName);
  const dstPath = path.join(cwd, dstName);
  const srcStat = await fs.stat(srcPath).catch(() => null);
  if (!srcStat?.isFile()) {
    throw new Error(`未找到打包产物: ${srcName}`);
  }

  await fs.rm(dstPath, { force: true }).catch(() => {});
  await fs.rename(srcPath, dstPath);
  console.log(`已重命名打包产物: ${srcName} -> ${dstName}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
