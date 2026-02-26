#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

function runCommand(cmd, args, cwd) {
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function toSha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function main() {
  const cwd = process.cwd();
  const isDryRun = process.argv.includes('--dry-run');
  const skipBuild = process.argv.includes('--skip-build');

  const pkgPath = path.join(cwd, 'package.json');
  const pkgText = await fs.readFile(pkgPath, 'utf-8');
  const pkg = JSON.parse(pkgText);
  const version = String(pkg.version || '0.0.0');
  const versionTag = version.startsWith('v') ? version : `v${version}`;

  if (!skipBuild) {
    runCommand('npm', ['run', 'build:native:release'], cwd);
  }

  const targets = [
    { targetTag: 'darwin-x64', binaryName: 'wecom-cleaner-core' },
    { targetTag: 'darwin-arm64', binaryName: 'wecom-cleaner-core' },
  ];

  const releaseDir = path.join(cwd, 'dist', 'release');
  const checksumRows = [];
  const copiedAssets = [];

  if (!isDryRun) {
    await fs.mkdir(releaseDir, { recursive: true });
  }

  for (const target of targets) {
    const sourcePath = path.join(cwd, 'native', 'bin', target.targetTag, target.binaryName);
    const sourceStat = await fs.stat(sourcePath).catch(() => null);
    if (!sourceStat?.isFile()) {
      throw new Error(`缺少构建产物: ${path.relative(cwd, sourcePath)}`);
    }

    const buffer = await fs.readFile(sourcePath);
    const sha256 = toSha256(buffer);
    const assetName = `wecom-cleaner-core-${versionTag}-${target.targetTag}`;
    const targetPath = path.join(releaseDir, assetName);
    checksumRows.push(`${sha256}  ${assetName}`);
    copiedAssets.push(assetName);

    if (!isDryRun) {
      await fs.copyFile(sourcePath, targetPath);
      await fs.chmod(targetPath, 0o755).catch(() => {});
    }
  }

  const checksumName = `wecom-cleaner-core-${versionTag}-SHA256SUMS.txt`;
  if (!isDryRun) {
    await fs.writeFile(path.join(releaseDir, checksumName), `${checksumRows.join('\n')}\n`, 'utf-8');
  }

  console.log(`版本: ${versionTag}`);
  console.log(`模式: ${isDryRun ? 'dry-run' : 'write'}`);
  console.log(`目录: ${path.relative(cwd, releaseDir)}`);
  copiedAssets.forEach((name) => console.log(`- ${name}`));
  console.log(`- ${checksumName}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
