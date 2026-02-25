import { formatBytes, renderTable } from './utils.js';

export function printAnalysisSummary(result) {
  const {
    totalBytes,
    targets,
    accountsSummary,
    categoriesSummary,
    monthsSummary,
    engineUsed,
    nativeFallbackReason,
  } = result;

  console.log('能力说明：');
  console.log('1. 企业微信会话数据库是私有/加密格式，无法稳定解析“会话名->本地文件夹”映射。');
  console.log('2. 当前模式仅分析可见缓存目录的数据分布，不执行删除。');
  console.log('3. 目录分析可作为手工清理决策依据。\n');

  console.log(`扫描目录: ${targets.length} 项`);
  console.log(`总大小  : ${formatBytes(totalBytes)}`);
  if (engineUsed) {
    console.log(`扫描引擎: ${engineUsed === 'zig' ? 'Zig核心' : 'Node引擎'}`);
  }
  if (nativeFallbackReason) {
    console.log(`引擎提示: ${nativeFallbackReason}`);
  }

  if (accountsSummary.length > 0) {
    const rows = accountsSummary.map((row) => [
      row.userName,
      row.corpName,
      row.shortId,
      String(row.count),
      formatBytes(row.sizeBytes),
    ]);
    console.log('\n账号维度：');
    console.log(renderTable(['用户名', '企业名', '短ID', '目录数', '大小'], rows));
  }

  if (categoriesSummary.length > 0) {
    const rows = categoriesSummary.map((row) => [
      row.categoryLabel,
      row.categoryKey,
      String(row.count),
      formatBytes(row.sizeBytes),
    ]);
    console.log('\n类型维度：');
    console.log(renderTable(['类型', 'Key', '目录数', '大小'], rows));
  }

  if (monthsSummary.length > 0) {
    const rows = monthsSummary
      .slice(0, 20)
      .map((row) => [row.monthKey, String(row.count), formatBytes(row.sizeBytes)]);
    console.log('\n月份维度（Top 20）：');
    console.log(renderTable(['月份/目录', '目录数', '大小'], rows));
  }
}
