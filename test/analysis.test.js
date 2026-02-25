import test from 'node:test';
import assert from 'node:assert/strict';
import { printAnalysisSummary } from '../src/analysis.js';

test('printAnalysisSummary 输出关键字段', () => {
  const lines = [];
  const oldLog = console.log;
  console.log = (...args) => {
    lines.push(args.join(' '));
  };

  try {
    printAnalysisSummary({
      totalBytes: 2048,
      targets: [{}, {}],
      engineUsed: 'node',
      nativeFallbackReason: 'zig核心扫描失败: 模拟错误',
      accountsSummary: [
        {
          userName: '用户A',
          corpName: '企业A',
          shortId: 'acc001',
          count: 2,
          sizeBytes: 2048,
        },
      ],
      categoriesSummary: [
        {
          categoryLabel: '聊天文件',
          categoryKey: 'files',
          count: 2,
          sizeBytes: 2048,
        },
      ],
      monthsSummary: [
        {
          monthKey: '2024-01',
          count: 2,
          sizeBytes: 2048,
        },
      ],
    });
  } finally {
    console.log = oldLog;
  }

  const text = lines.join('\n');
  assert.match(text, /能力说明/);
  assert.match(text, /扫描目录: 2 项/);
  assert.match(text, /引擎提示: zig核心扫描失败/);
  assert.match(text, /账号维度/);
  assert.match(text, /类型维度/);
  assert.match(text, /月份维度/);
});
