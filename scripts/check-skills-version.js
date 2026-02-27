#!/usr/bin/env node

import path from 'node:path';
import { promises as fs } from 'node:fs';

const SKILL_NAME = 'wecom-cleaner-agent';
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readJson(filePath) {
  const text = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(text);
}

async function main() {
  const cwd = process.cwd();
  const packagePath = path.join(cwd, 'package.json');
  const skillVersionPath = path.join(cwd, 'skills', SKILL_NAME, 'version.json');

  const pkg = await readJson(packagePath);
  const version = String(pkg.version || '').trim();
  assertCondition(SEMVER_RE.test(version), `package.json version 非法: ${version || '(empty)'}`);

  const meta = await readJson(skillVersionPath);
  const skillName = String(meta.skillName || '').trim();
  const skillVersion = String(meta.skillVersion || '')
    .trim()
    .replace(/^v/, '');
  const requiredAppVersion = String(meta.requiredAppVersion || '')
    .trim()
    .replace(/^v/, '');

  assertCondition(skillName === SKILL_NAME, `skills version.json skillName 不匹配: ${skillName}`);
  assertCondition(SEMVER_RE.test(skillVersion), `skills skillVersion 非法: ${skillVersion || '(empty)'}`);
  assertCondition(
    SEMVER_RE.test(requiredAppVersion),
    `skills requiredAppVersion 非法: ${requiredAppVersion || '(empty)'}`
  );
  assertCondition(
    skillVersion === version,
    `skills skillVersion(${skillVersion}) 与 package version(${version}) 不一致`
  );
  assertCondition(
    requiredAppVersion === version,
    `skills requiredAppVersion(${requiredAppVersion}) 与 package version(${version}) 不一致`
  );

  console.log('skills 版本绑定检查通过');
  console.log(`- app version: ${version}`);
  console.log(`- skill version: ${skillVersion}`);
  console.log(`- required app version: ${requiredAppVersion}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
