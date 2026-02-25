import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  CliArgError,
  defaultConfig,
  loadAliases,
  loadConfig,
  parseCliArgs,
  saveAliases,
  saveConfig,
} from '../src/config.js';
import { makeTempDir, removeDir } from './helpers/temp.js';

test('parseCliArgs 可正确解析常用参数', () => {
  const parsed = parseCliArgs([
    '--root',
    '/tmp/profiles',
    '--state-root',
    '/tmp/state',
    '--external-storage-root',
    '/tmp/extA,/tmp/extB',
    '--external-storage-auto-detect',
    'false',
    '--dry-run-default',
    'true',
    '--mode',
    'analysis_only',
    '--theme',
    'dark',
  ]);

  assert.equal(parsed.rootDir, '/tmp/profiles');
  assert.equal(parsed.stateRoot, '/tmp/state');
  assert.equal(parsed.externalStorageRoots, '/tmp/extA,/tmp/extB');
  assert.equal(parsed.externalStorageAutoDetect, false);
  assert.equal(parsed.dryRunDefault, true);
  assert.equal(parsed.mode, 'analysis_only');
  assert.equal(parsed.theme, 'dark');
});

test('parseCliArgs 对非法参数会抛出 CliArgError', () => {
  assert.throws(() => parseCliArgs(['--theme', 'blue']), CliArgError);
  assert.throws(() => parseCliArgs(['--root']), CliArgError);
  assert.throws(() => parseCliArgs(['--unknown']), CliArgError);
});

test('loadConfig/saveConfig/aliases 读写链路正常', async (t) => {
  const root = await makeTempDir('wecom-config-');
  t.after(async () => removeDir(root));

  const profilesRoot = path.join(root, 'Profiles');
  const stateRoot = path.join(root, 'state');

  const loaded = await loadConfig({
    rootDir: profilesRoot,
    stateRoot,
    dryRunDefault: false,
    externalStorageRoots: `${path.join(root, 'extA')},${path.join(root, 'extB')}`,
    externalStorageAutoDetect: false,
    theme: 'light',
  });

  assert.equal(loaded.rootDir, profilesRoot);
  assert.equal(loaded.stateRoot, stateRoot);
  assert.equal(loaded.dryRunDefault, false);
  assert.equal(loaded.externalStorageAutoDetect, false);
  assert.equal(loaded.theme, 'light');
  assert.equal(loaded.externalStorageRoots.length, 2);

  loaded.theme = 'dark';
  loaded.spaceGovernance.autoSuggest.sizeThresholdMB = 1024;
  await saveConfig(loaded);

  const reloaded = await loadConfig({ stateRoot });
  assert.equal(reloaded.theme, 'dark');
  assert.equal(reloaded.spaceGovernance.autoSuggest.sizeThresholdMB, 1024);

  const aliasPath = path.join(stateRoot, 'account-aliases.json');
  await saveAliases(aliasPath, {
    acc001: { userName: '张三', corpName: '测试企业' },
  });

  const aliases = await loadAliases(aliasPath);
  assert.deepEqual(aliases.acc001, { userName: '张三', corpName: '测试企业' });
});

test('defaultConfig 输出基础字段完整', () => {
  const cfg = defaultConfig();
  assert.equal(typeof cfg.rootDir, 'string');
  assert.equal(typeof cfg.stateRoot, 'string');
  assert.equal(typeof cfg.recycleRoot, 'string');
  assert.equal(cfg.theme, 'auto');
});
