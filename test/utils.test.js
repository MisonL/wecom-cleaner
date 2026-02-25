import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import {
  appendJsonLine,
  calculateDirectorySize,
  compareMonthKey,
  decodeBase64Utf8,
  expandHome,
  formatBytes,
  inferDataRootFromProfilesRoot,
  mapLimit,
  normalizeMonthKey,
  padToWidth,
  readJsonLines,
  renderTable,
  shortId,
  sortMonthKeys,
  stringWidth,
  trimToWidth,
} from '../src/utils.js';
import { ensureFile, makeTempDir, removeDir } from './helpers/temp.js';

test('expandHome 与 inferDataRootFromProfilesRoot 解析正确', () => {
  const home = os.homedir();
  assert.equal(expandHome('~'), home);
  assert.equal(expandHome('~/abc'), path.join(home, 'abc'));

  const root = path.join('/tmp', 'a', 'Data', 'Documents', 'Profiles');
  assert.equal(inferDataRootFromProfilesRoot(root), path.join('/tmp', 'a', 'Data'));
  assert.equal(inferDataRootFromProfilesRoot('/tmp/other/path'), null);
});

test('月份与字节格式工具可用', () => {
  assert.equal(normalizeMonthKey('2024-1'), '2024-01');
  assert.equal(normalizeMonthKey('2024-13'), null);

  assert.deepEqual(sortMonthKeys(['2024-02', '2024-01', '2024-02']), ['2024-01', '2024-02']);
  assert.equal(compareMonthKey('2024-01', '2024-02') < 0, true);

  assert.equal(formatBytes(1023), '1023B');
  assert.equal(formatBytes(1024), '1.0KB');
  assert.equal(shortId('1234567890'), '12345678');
});

test('文本宽度与表格渲染稳定', () => {
  assert.equal(stringWidth('abc'), 3);
  assert.equal(stringWidth('中文'), 4);
  assert.equal(trimToWidth('abcdef', 4), 'a...');
  assert.equal(padToWidth('中', 4), '中  ');

  const table = renderTable(
    ['列1', '列2'],
    [
      ['一', '第一行'],
      ['二', '第二行'],
    ],
    { terminalWidth: 40 }
  );

  assert.match(table, /列1/);
  assert.match(table, /第二行/);
});

test('mapLimit 可以并发执行并保持结果顺序', async () => {
  const out = await mapLimit([1, 2, 3, 4], 2, async (item) => item * item);
  assert.deepEqual(out, [1, 4, 9, 16]);
});

test('calculateDirectorySize 统计目录并忽略软链接', async (t) => {
  const root = await makeTempDir('wecom-utils-size-');
  t.after(async () => removeDir(root));

  await ensureFile(path.join(root, 'a.txt'), 'abcd');
  await ensureFile(path.join(root, 'nested', 'b.txt'), 'ef');

  const linkPath = path.join(root, 'broken-link');
  await fs.symlink('/path/not/exist', linkPath).catch(() => {});

  const size = await calculateDirectorySize(root);
  assert.equal(size, 6);
});

test('JSONL 读写可跳过坏行', async (t) => {
  const root = await makeTempDir('wecom-utils-jsonl-');
  t.after(async () => removeDir(root));

  const file = path.join(root, 'index.jsonl');
  await appendJsonLine(file, { a: 1 });
  await fs.appendFile(file, '{bad-json}\n', 'utf-8');
  await appendJsonLine(file, { b: 2 });

  const rows = await readJsonLines(file);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { a: 1 });
  assert.deepEqual(rows[1], { b: 2 });
});

test('decodeBase64Utf8 在异常输入时返回空字符串', () => {
  assert.equal(decodeBase64Utf8('5L2g5aW9'), '你好');
  assert.equal(decodeBase64Utf8('@@@'), '');
});
