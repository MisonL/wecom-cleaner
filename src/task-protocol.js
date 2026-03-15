import { CACHE_CATEGORIES, DELETE_MODES, MODES } from './constants.js';
import {
  SERVICE_LOGIN_TRIGGER,
  SERVICE_LOW_SPACE_TRIGGER,
  SERVICE_MANUAL_TRIGGER,
  SERVICE_SCHEDULE_TRIGGER,
} from './service-manager.js';
import { skillBindingStatusLabel } from './skill-installer.js';
import { trimToWidth } from './utils.js';

export const TASK_PROTOCOL_VERSION = '1';

const ACTION_DISPLAY_NAMES = new Map([
  [MODES.CLEANUP_MONTHLY, '年月清理'],
  [MODES.ANALYSIS_ONLY, '会话分析（只读）'],
  [MODES.SPACE_GOVERNANCE, '全量空间治理'],
  [MODES.RESTORE, '恢复已删除批次'],
  [MODES.RECYCLE_MAINTAIN, '回收区治理'],
  [MODES.DOCTOR, '系统自检'],
  [MODES.CHECK_UPDATE, '检查更新'],
  [MODES.UPGRADE, '程序升级'],
  [MODES.SYNC_SKILLS, '同步 Agent Skills'],
  [MODES.SERVICE, '自动服务'],
  [MODES.SERVICE_INSTALL, '安装自动服务'],
  [MODES.SERVICE_UNINSTALL, '卸载自动服务'],
  [MODES.SERVICE_STATUS, '自动服务状态'],
  [MODES.SERVICE_RUN, '执行自动服务任务'],
]);

function uniqueStrings(values = []) {
  return [...new Set(values.map((item) => String(item || '').trim()).filter(Boolean))];
}

function summarizeDimensionRows(rows, { labelKey = 'label', countKey = 'targetCount' } = {}, limit = 20) {
  return (Array.isArray(rows) ? rows : []).slice(0, limit).map((row) => ({
    label:
      row?.[labelKey] ||
      row?.categoryLabel ||
      row?.targetLabel ||
      row?.monthKey ||
      row?.rootPath ||
      row?.accountShortId ||
      '-',
    count: Number(row?.[countKey] || row?.count || 0),
    sizeBytes: Number(row?.sizeBytes || 0),
  }));
}

function summarizeRootSamplesForNote(roots, limit = 2) {
  const list = uniqueStrings(Array.isArray(roots) ? roots : []);
  if (list.length === 0) {
    return '-';
  }
  const shown = list
    .slice(0, limit)
    .map((item) => trimToWidth(item, 68))
    .join('；');
  return list.length > limit ? `${shown}（其余 ${list.length - limit} 个省略）` : shown;
}

function normalizeDeleteMode(rawValue, fallback = DELETE_MODES.RECYCLE) {
  const value = String(rawValue || '')
    .trim()
    .toLowerCase();
  return Object.values(DELETE_MODES).includes(value) ? value : fallback;
}

function normalizeSkillSyncMethod(rawMethod) {
  return String(rawMethod || '')
    .trim()
    .toLowerCase() === 'github-script'
    ? 'github-script'
    : 'npm';
}

function skillSyncMethodLabel(method) {
  return normalizeSkillSyncMethod(method) === 'github-script' ? 'GitHub 脚本' : 'npm';
}

function summarizeSkillBinding(skillBinding) {
  const binding = skillBinding && typeof skillBinding === 'object' ? skillBinding : {};
  return {
    status: String(binding.status || 'unknown'),
    statusLabel: skillBindingStatusLabel(binding.status),
    matched: Boolean(binding.matched),
    installed: Boolean(binding.installed),
    expectedAppVersion: binding.expectedAppVersion || '',
    installedSkillVersion: binding.installedManifest?.skillVersion || null,
    installedRequiredAppVersion: binding.installedManifest?.requiredAppVersion || null,
    recommendation: binding.recommendation || '',
    targetSkillDir: binding.targetSkillDir || '',
  };
}

function deriveUpdateSourceChain(summary = {}, updateData = {}) {
  const source = String(summary.source || updateData.sourceUsed || 'none');
  const errors = Array.isArray(updateData.errors) ? updateData.errors : [];
  const hasNpmFallback = errors.some((item) => String(item).includes('npm检查失败'));
  const hasGithubFallback = errors.some((item) => String(item).includes('github检查失败'));
  if (source === 'npm') {
    return '已通过 npmjs 获取版本信息。';
  }
  if (source === 'github') {
    return hasNpmFallback ? 'npmjs 请求失败，已自动回退到 GitHub。' : '已通过 GitHub 获取版本信息。';
  }
  if (source === 'none') {
    return hasNpmFallback || hasGithubFallback
      ? 'npmjs 与 GitHub 均未获取成功。'
      : '本次未获取到可用更新来源。';
  }
  return source;
}

function serviceTriggerLabel(triggerSource) {
  const key = String(triggerSource || '').trim();
  if (key === SERVICE_LOGIN_TRIGGER) return '登录后触发';
  if (key === SERVICE_SCHEDULE_TRIGGER) return '定时触发';
  if (key === SERVICE_LOW_SPACE_TRIGGER) return '低空间紧急治理';
  if (key === SERVICE_MANUAL_TRIGGER) return '手动触发';
  return key || '-';
}

function serviceDeleteModeLabel(deleteMode) {
  return normalizeDeleteMode(deleteMode, DELETE_MODES.SERVICE_RECYCLE) === DELETE_MODES.DIRECT
    ? '服务直接删除'
    : '移动到服务回收站';
}

function hasDisplayValue(value) {
  return !(value === undefined || value === null || value === '');
}

function buildActionScopeNotes(action, result) {
  const summary = result?.summary || {};
  const data = result?.data || {};
  const notes = [];
  const selectedExternalRoots = uniqueStrings(data.selectedExternalRoots || []);
  const scanActions = new Set([
    MODES.CLEANUP_MONTHLY,
    MODES.ANALYSIS_ONLY,
    MODES.SPACE_GOVERNANCE,
    MODES.RESTORE,
  ]);

  if (scanActions.has(action)) {
    notes.push(
      selectedExternalRoots.length === 0
        ? '本次未纳入企业微信“文件存储位置”目录，统计结果可能明显小于磁盘实际占用。'
        : `本次已纳入 ${selectedExternalRoots.length} 个文件存储目录（示例：${summarizeRootSamplesForNote(selectedExternalRoots)}）。`
    );
  }
  if (action === MODES.CLEANUP_MONTHLY) {
    if (summary.cutoffMonth) notes.push(`时间筛选使用“截至 ${summary.cutoffMonth}（含）”。`);
    if (summary.deleteMode === DELETE_MODES.DIRECT)
      notes.push('本次为直接删除模式，不会进入回收区，也无法按批次恢复。');
    if (summary.noTarget) notes.push('当前筛选命中为 0，已按安全策略跳过真实删除。');
  }
  if (action === MODES.ANALYSIS_ONLY && Number(summary.targetCount || 0) === 0) {
    notes.push('当前筛选范围未发现缓存目录，可检查账号、类别或文件存储路径设置。');
  }
  if (action === MODES.SPACE_GOVERNANCE && Number(summary.matchedTargets || 0) === 0) {
    notes.push('当前治理筛选命中为 0，本次未执行任何删除。');
  }
  if (action === MODES.SPACE_GOVERNANCE && summary.deleteMode === DELETE_MODES.DIRECT) {
    notes.push('本次治理为直接删除模式，不会进入回收区。');
  }
  if (action === MODES.RESTORE && result?.dryRun) {
    notes.push('本次为恢复预演，不会写回任何原路径。');
  }
  if (action === MODES.SYNC_SKILLS) {
    notes.push('本次仅处理 Agent Skills 目录，不会扫描或清理企业微信缓存。');
    notes.push(`同步方式：${skillSyncMethodLabel(summary.method || 'npm')}。`);
  }
  if (action === MODES.SERVICE_RUN) {
    notes.push(`服务触发源：${serviceTriggerLabel(summary.triggerSource)}。`);
    notes.push(`服务删除方式：${serviceDeleteModeLabel(summary.deleteMode)}。`);
  }
  return uniqueStrings(notes);
}

export function buildUserFacingSummary(action, result) {
  const summary = result?.summary || {};
  const data = result?.data || {};
  const report = data.report || {};
  const matched = report.matched || {};

  if (action === MODES.CLEANUP_MONTHLY) {
    return {
      scopeNotes: buildActionScopeNotes(action, result),
      scope: {
        accountCount: Number(summary.accountCount || 0),
        monthCount: Number(summary.monthCount || 0),
        categoryCount: Number(summary.categoryCount || 0),
        rootPathCount: Number(summary.rootPathCount || 0),
        cutoffMonth: summary.cutoffMonth || null,
        monthRange: {
          from: summary.matchedMonthStart || matched?.monthRange?.from || null,
          to: summary.matchedMonthEnd || matched?.monthRange?.to || null,
        },
      },
      result: {
        noTarget: Boolean(summary.noTarget),
        deleteMode: summary.deleteMode || DELETE_MODES.RECYCLE,
        recoverable: summary.recoverable !== false,
        matchedTargets: Number(summary.matchedTargets || 0),
        matchedBytes: Number(summary.matchedBytes || 0),
        reclaimedBytes: Number(summary.reclaimedBytes || 0),
        successCount: Number(summary.successCount || 0),
        skippedCount: Number(summary.skippedCount || 0),
        failedCount: Number(summary.failedCount || 0),
        batchId: summary.batchId || null,
      },
      byMonth: summarizeDimensionRows(matched.monthStats, { labelKey: 'monthKey' }),
      byCategory: summarizeDimensionRows(matched.categoryStats, { labelKey: 'categoryLabel' }),
      byRoot: summarizeDimensionRows(matched.rootStats, { labelKey: 'rootPath' }),
    };
  }
  if (action === MODES.ANALYSIS_ONLY) {
    return {
      scopeNotes: buildActionScopeNotes(action, result),
      scope: {
        accountCount: Number(summary.accountCount || 0),
        matchedAccountCount: Number(summary.matchedAccountCount || 0),
        categoryCount: Number(summary.categoryCount || 0),
        monthBucketCount: Number(summary.monthBucketCount || 0),
      },
      result: { targetCount: Number(summary.targetCount || 0), totalBytes: Number(summary.totalBytes || 0) },
      byMonth: summarizeDimensionRows(matched.monthStats, { labelKey: 'monthKey' }),
      byCategory: summarizeDimensionRows(matched.categoryStats, { labelKey: 'categoryLabel' }),
      byRoot: summarizeDimensionRows(matched.rootStats, { labelKey: 'rootPath' }),
    };
  }
  if (action === MODES.SPACE_GOVERNANCE) {
    return {
      scopeNotes: buildActionScopeNotes(action, result),
      scope: {
        accountCount: Number(summary.accountCount || 0),
        tierCount: Number(summary.tierCount || 0),
        targetTypeCount: Number(summary.targetTypeCount || 0),
        rootPathCount: Number(summary.rootPathCount || 0),
      },
      result: {
        noTarget: Boolean(summary.noTarget),
        deleteMode: summary.deleteMode || DELETE_MODES.RECYCLE,
        recoverable: summary.recoverable !== false,
        matchedTargets: Number(summary.matchedTargets || 0),
        matchedBytes: Number(summary.matchedBytes || 0),
        reclaimedBytes: Number(summary.reclaimedBytes || 0),
        successCount: Number(summary.successCount || 0),
        skippedCount: Number(summary.skippedCount || 0),
        failedCount: Number(summary.failedCount || 0),
        batchId: summary.batchId || null,
      },
      byTier: summarizeDimensionRows(matched.byTier, { labelKey: 'tierLabel' }),
      byCategory: summarizeDimensionRows(matched.byTargetType, { labelKey: 'targetLabel' }),
      byRoot: summarizeDimensionRows(matched.byRoot, { labelKey: 'rootPath' }),
    };
  }
  if (action === MODES.RESTORE) {
    return {
      scopeNotes: buildActionScopeNotes(action, result),
      scope: {
        entryCount: Number(summary.entryCount || 0),
        conflictStrategy: summary.conflictStrategy || null,
        rootPathCount: Number(summary.rootPathCount || 0),
      },
      result: {
        batchId: summary.batchId || null,
        matchedBytes: Number(summary.matchedBytes || 0),
        restoredBytes: Number(summary.restoredBytes || 0),
        successCount: Number(summary.successCount || 0),
        skippedCount: Number(summary.skippedCount || 0),
        failedCount: Number(summary.failedCount || 0),
      },
      byMonth: summarizeDimensionRows(matched.byMonth, { labelKey: 'monthKey' }),
      byCategory: summarizeDimensionRows(matched.byCategory, { labelKey: 'categoryLabel' }),
      byRoot: summarizeDimensionRows(matched.byRoot, { labelKey: 'rootPath' }),
    };
  }
  if (action === MODES.RECYCLE_MAINTAIN) {
    return {
      scopeNotes: buildActionScopeNotes(action, result),
      scope: {
        candidateCount: Number(summary.candidateCount || 0),
        selectedByAge: Number(summary.selectedByAge || 0),
        selectedBySize: Number(summary.selectedBySize || 0),
      },
      result: {
        status: summary.status || null,
        deletedBatches: Number(summary.deletedBatches || 0),
        deletedBytes: Number(summary.deletedBytes || 0),
        failedBatches: Number(summary.failedBatches || 0),
        remainingBatches: Number(summary.remainingBatches || 0),
        remainingBytes: Number(summary.remainingBytes || 0),
      },
    };
  }
  if (action === MODES.DOCTOR) {
    return {
      scopeNotes: buildActionScopeNotes(action, result),
      scope: { platform: data.runtime?.targetTag || null },
      result: {
        overall: summary.overall || null,
        pass: Number(summary.pass || 0),
        warn: Number(summary.warn || 0),
        fail: Number(summary.fail || 0),
      },
    };
  }
  if (action === MODES.CHECK_UPDATE) {
    const update = data.update || {};
    const skills = summarizeSkillBinding(data.skills || {});
    const scopeNotes = [
      deriveUpdateSourceChain(summary, update),
      summary.hasUpdate
        ? '检测到新版本后，仍需你手动确认才会执行升级。'
        : '本次仅执行检查，不会改动本机安装。',
    ];
    if (!skills.matched)
      scopeNotes.push(`skills 状态：${skills.statusLabel}，建议同步后再让 Agent 执行任务。`);
    return {
      scopeNotes: uniqueStrings(scopeNotes),
      result: {
        checked: Boolean(summary.checked),
        hasUpdate: Boolean(summary.hasUpdate),
        currentVersion: summary.currentVersion || null,
        latestVersion: summary.latestVersion || null,
        source: summary.source || null,
        sourceChain: summary.sourceChain || deriveUpdateSourceChain(summary, update),
        channel: summary.channel || null,
        skillsStatus: skills.status,
        skillsMatched: skills.matched,
        skillsInstalledVersion: skills.installedSkillVersion,
        skillsBoundAppVersion: skills.installedRequiredAppVersion,
      },
    };
  }
  if (action === MODES.UPGRADE) {
    return {
      scopeNotes: buildActionScopeNotes(action, result),
      result: {
        executed: Boolean(summary.executed),
        method: summary.method || null,
        targetVersion: summary.targetVersion || null,
        status: hasDisplayValue(summary.status) ? Number(summary.status) : null,
        skillSyncStatus: summary.skillSyncStatus || null,
        skillSyncMethod: summary.skillSyncMethod || null,
        skillSyncTargetVersion: summary.skillSyncTargetVersion || null,
        skillSyncCommand: data.skillSync?.command || null,
      },
    };
  }
  if (action === MODES.SYNC_SKILLS) {
    return {
      scopeNotes: buildActionScopeNotes(action, result),
      result: {
        method: summary.method || null,
        dryRun: Boolean(summary.dryRun),
        status: summary.status || null,
        skillsStatusBefore: summary.skillsStatusBefore || null,
        skillsStatusAfter: summary.skillsStatusAfter || null,
      },
    };
  }
  if (action === MODES.SERVICE_STATUS) {
    return {
      scopeNotes: ['自动服务状态查询不会执行任何清理动作。'],
      result: {
        installed: Boolean(summary.installed),
        loginLoaded: Boolean(summary.loginLoaded),
        scheduleLoaded: Boolean(summary.scheduleLoaded),
        nextRunAt: summary.nextRunAt || null,
        deleteMode: summary.deleteMode || null,
        retainDays: Number(summary.retainDays || 0),
      },
    };
  }
  if (action === MODES.SERVICE_INSTALL || action === MODES.SERVICE_UNINSTALL) {
    return { scopeNotes: ['自动服务安装状态已更新。'], result: summary };
  }
  if (action === MODES.SERVICE_RUN) {
    return {
      scopeNotes: buildActionScopeNotes(action, result),
      scope: {
        accountCount: Array.isArray(data.selectedAccounts) ? data.selectedAccounts.length : 0,
        categoryCount: Array.isArray(data.selectedCategories) ? data.selectedCategories.length : 0,
        externalRootCount: Array.isArray(data.selectedExternalRoots) ? data.selectedExternalRoots.length : 0,
      },
      result: {
        triggerSource: summary.triggerSource || null,
        deleteMode: summary.deleteMode || null,
        retainDays: Number(summary.retainDays || 0),
        matchedTargets: Number(summary.matchedTargets || 0),
        reclaimedBytes: Number(summary.reclaimedBytes || 0),
        serviceRecycleDeletedBytes: Number(summary.serviceRecycleDeletedBytes || 0),
        lowSpaceTriggered: Boolean(summary.lowSpaceTriggered),
        lowSpaceDeletedBytes: Number(summary.lowSpaceDeletedBytes || 0),
      },
      byMonth: summarizeDimensionRows(matched.monthStats, { labelKey: 'monthKey' }),
      byCategory: summarizeDimensionRows(matched.categoryStats, { labelKey: 'categoryLabel' }),
      byRoot: summarizeDimensionRows(matched.rootStats, { labelKey: 'rootPath' }),
    };
  }
  return { scopeNotes: buildActionScopeNotes(action, result), result: summary };
}

function phaseMatchedTargets(action, result) {
  const summary = result?.summary || {};
  if ([MODES.CLEANUP_MONTHLY, MODES.SPACE_GOVERNANCE].includes(action))
    return Number(summary.matchedTargets || 0);
  if (action === MODES.RESTORE) return Number(summary.entryCount || 0);
  if (action === MODES.RECYCLE_MAINTAIN) return Number(summary.candidateCount || 0);
  if (action === MODES.ANALYSIS_ONLY) return Number(summary.targetCount || 0);
  return 0;
}

function phaseMatchedBytes(action, result) {
  const summary = result?.summary || {};
  if ([MODES.CLEANUP_MONTHLY, MODES.SPACE_GOVERNANCE, MODES.RESTORE].includes(action))
    return Number(summary.matchedBytes || 0);
  if (action === MODES.ANALYSIS_ONLY) return Number(summary.totalBytes || 0);
  if (action === MODES.RECYCLE_MAINTAIN) return Number(summary.deletedBytes || 0);
  return 0;
}

function phaseReclaimedBytes(action, result) {
  const summary = result?.summary || {};
  if (action === MODES.RESTORE) return Number(summary.restoredBytes || 0);
  if (action === MODES.RECYCLE_MAINTAIN) return Number(summary.deletedBytes || 0);
  return Number(summary.reclaimedBytes || 0);
}

export function buildTaskPhaseEntry(action, phaseName, result, durationMs) {
  const summary = result?.summary || {};
  const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  return {
    name: phaseName,
    status: 'completed',
    ok: Boolean(result?.ok),
    dryRun: result?.dryRun ?? null,
    durationMs: Math.max(0, Number(durationMs || 0)),
    summary,
    warningCount: warnings.length,
    errorCount: errors.length,
    warnings,
    errors,
    stats: {
      matchedTargets: phaseMatchedTargets(action, result),
      matchedBytes: phaseMatchedBytes(action, result),
      reclaimedBytes: phaseReclaimedBytes(action, result),
      successCount: Number(summary.successCount || 0),
      skippedCount: Number(summary.skippedCount || 0),
      failedCount: Number(summary.failedCount || summary.failedBatches || 0),
      batchId: summary.batchId || null,
    },
    userFacingSummary: buildUserFacingSummary(action, result),
  };
}

export function buildSkippedTaskPhase(phaseName, reason) {
  return {
    name: phaseName,
    status: 'skipped',
    reason,
    ok: true,
    dryRun: null,
    durationMs: 0,
    summary: {},
    warningCount: 0,
    errorCount: 0,
    warnings: [],
    errors: [],
    stats: {
      matchedTargets: 0,
      matchedBytes: 0,
      reclaimedBytes: 0,
      successCount: 0,
      skippedCount: 0,
      failedCount: 0,
      batchId: null,
    },
    userFacingSummary: {},
  };
}

function buildTaskCardBreakdown(action, report) {
  const matched = report?.matched || {};
  if ([MODES.CLEANUP_MONTHLY, MODES.ANALYSIS_ONLY].includes(action)) {
    return {
      byCategory: summarizeDimensionRows(matched.categoryStats, { labelKey: 'categoryLabel' }, 16),
      byMonth: summarizeDimensionRows(matched.monthStats, { labelKey: 'monthKey' }, 16),
      byRoot: summarizeDimensionRows(matched.rootStats, { labelKey: 'rootPath' }, 12),
      topPaths: (Array.isArray(matched.topPaths) ? matched.topPaths : []).slice(0, 12).map((item) => ({
        path: item.path || '-',
        category: item.categoryLabel || item.categoryKey || '-',
        month: item.monthKey || '非月份目录',
        sizeBytes: Number(item.sizeBytes || 0),
      })),
    };
  }
  if (action === MODES.SPACE_GOVERNANCE) {
    return {
      byCategory: summarizeDimensionRows(matched.byTargetType, { labelKey: 'targetLabel' }, 16),
      byMonth: [],
      byRoot: summarizeDimensionRows(matched.byRoot, { labelKey: 'rootPath' }, 12),
      byTier: summarizeDimensionRows(matched.byTier, { labelKey: 'tierLabel' }, 8),
      topPaths: (Array.isArray(matched.topPaths) ? matched.topPaths : []).slice(0, 12).map((item) => ({
        path: item.path || '-',
        category: item.targetLabel || item.targetKey || '-',
        month: '-',
        sizeBytes: Number(item.sizeBytes || 0),
      })),
    };
  }
  if (action === MODES.RESTORE) {
    return {
      byCategory: summarizeDimensionRows(matched.byCategory, { labelKey: 'categoryLabel' }, 16),
      byMonth: summarizeDimensionRows(matched.byMonth, { labelKey: 'monthKey' }, 16),
      byRoot: summarizeDimensionRows(matched.byRoot, { labelKey: 'rootPath' }, 12),
      topPaths: (Array.isArray(matched.topEntries) ? matched.topEntries : []).slice(0, 12).map((item) => ({
        path: item.originalPath || '-',
        category: item.categoryLabel || item.categoryKey || '-',
        month: item.monthKey || '非月份目录',
        sizeBytes: Number(item.sizeBytes || 0),
      })),
    };
  }
  return { byCategory: [], byMonth: [], byRoot: [], topPaths: [] };
}

export function buildRunTaskCard(action, runTaskMode, taskDecision, phases, finalResult) {
  const previewPhase = phases.find((item) => item.name === 'preview' && item.status === 'completed') || null;
  const executePhase = phases.find((item) => item.name === 'execute' && item.status === 'completed') || null;
  const verifyPhase = phases.find((item) => item.name === 'verify' && item.status === 'completed') || null;
  const report = finalResult?.data?.report || {};
  let conclusion = '任务已完成。';
  if (taskDecision === 'skipped_no_target') conclusion = '预演命中为 0，已按安全策略跳过真实执行。';
  else if (taskDecision === 'preview_only' || taskDecision === 'single_phase_preview')
    conclusion = '已完成预演，本次未执行真实操作。';
  else if (taskDecision === 'single_phase_inspect') conclusion = '已完成检查，本次未执行任何改动。';
  else if (taskDecision === 'execute_only' || taskDecision === 'single_phase_execute')
    conclusion = executePhase?.ok !== false ? '已完成真实执行。' : '已尝试真实执行，但存在失败项。';
  else if (taskDecision === 'executed_and_verified')
    conclusion =
      verifyPhase && Number(verifyPhase.stats.matchedTargets || 0) === 0
        ? '已完成真实执行并通过复核，范围内无剩余目标。'
        : '已完成真实执行与复核。';
  else if (taskDecision === 'preview_failed') conclusion = '预演阶段失败，后续阶段未执行。';

  return {
    action,
    actionLabel: ACTION_DISPLAY_NAMES.get(action) || String(action || '-'),
    mode: runTaskMode,
    decision: taskDecision,
    conclusion,
    phases: phases.map((item) => ({
      name: item.name,
      status: item.status,
      reason: item.reason || null,
      dryRun: item.dryRun,
      ok: item.ok,
      durationMs: item.durationMs,
      matchedTargets: Number(item?.stats?.matchedTargets || 0),
      matchedBytes: Number(item?.stats?.matchedBytes || 0),
      reclaimedBytes: Number(item?.stats?.reclaimedBytes || 0),
      successCount: Number(item?.stats?.successCount || 0),
      skippedCount: Number(item?.stats?.skippedCount || 0),
      failedCount: Number(item?.stats?.failedCount || 0),
      batchId: item?.stats?.batchId || null,
    })),
    scope: {
      accountCount: Number(finalResult?.summary?.accountCount || 0),
      monthCount: Number(finalResult?.summary?.monthCount || 0),
      categoryCount: Number(finalResult?.summary?.categoryCount || 0),
      rootPathCount: Number(finalResult?.summary?.rootPathCount || 0),
      cutoffMonth: finalResult?.summary?.cutoffMonth || null,
      selectedAccounts: uniqueStrings(finalResult?.data?.selectedAccounts || []),
      selectedMonths: uniqueStrings(finalResult?.data?.selectedMonths || []),
      selectedCategories: uniqueStrings(finalResult?.data?.selectedCategories || []),
      selectedExternalRoots: uniqueStrings(finalResult?.data?.selectedExternalRoots || []),
    },
    preview: previewPhase
      ? {
          matchedTargets: Number(previewPhase.stats.matchedTargets || 0),
          matchedBytes: Number(previewPhase.stats.matchedBytes || 0),
          reclaimedBytes: Number(previewPhase.stats.reclaimedBytes || 0),
          failedCount: Number(previewPhase.stats.failedCount || 0),
        }
      : null,
    execute: executePhase
      ? {
          successCount: Number(executePhase.stats.successCount || 0),
          skippedCount: Number(executePhase.stats.skippedCount || 0),
          failedCount: Number(executePhase.stats.failedCount || 0),
          reclaimedBytes: Number(executePhase.stats.reclaimedBytes || 0),
          batchId: executePhase.stats.batchId || null,
        }
      : null,
    verify: verifyPhase
      ? {
          matchedTargets: Number(verifyPhase.stats.matchedTargets || 0),
          matchedBytes: Number(verifyPhase.stats.matchedBytes || 0),
          failedCount: Number(verifyPhase.stats.failedCount || 0),
        }
      : null,
    breakdown: buildTaskCardBreakdown(action, report),
  };
}

export function withRunTaskResult(baseResult, action, runTaskMode, taskDecision, phases) {
  const output = baseResult && typeof baseResult === 'object' ? baseResult : {};
  return {
    ...output,
    summary: {
      ...(output.summary && typeof output.summary === 'object' ? output.summary : {}),
      runTaskMode,
      taskDecision,
      phaseCount: phases.length,
    },
    data: {
      ...(output.data && typeof output.data === 'object' ? output.data : {}),
      protocolVersion: TASK_PROTOCOL_VERSION,
      taskPhases: phases,
      taskCard: buildRunTaskCard(action, runTaskMode, taskDecision, phases, output),
    },
  };
}

function singlePhaseName(action, result) {
  if ([MODES.DOCTOR, MODES.CHECK_UPDATE, MODES.ANALYSIS_ONLY, MODES.SERVICE_STATUS].includes(action))
    return 'inspect';
  if (result?.dryRun) return 'preview';
  return 'execute';
}

function singlePhaseDecision(action, result) {
  if ([MODES.DOCTOR, MODES.CHECK_UPDATE, MODES.ANALYSIS_ONLY, MODES.SERVICE_STATUS].includes(action))
    return 'single_phase_inspect';
  if (result?.dryRun) return 'single_phase_preview';
  return 'single_phase_execute';
}

export function attachTaskProtocolData(action, result, options = {}) {
  const output = result && typeof result === 'object' ? result : {};
  const data = output.data && typeof output.data === 'object' ? output.data : {};
  const userFacingSummary = data.userFacingSummary || buildUserFacingSummary(action, output);
  const taskPhases =
    Array.isArray(data.taskPhases) && data.taskPhases.length > 0
      ? data.taskPhases
      : [buildTaskPhaseEntry(action, singlePhaseName(action, output), output, options.durationMs || 0)];
  const taskCard =
    data.taskCard ||
    buildRunTaskCard(
      action,
      singlePhaseName(action, output),
      singlePhaseDecision(action, output),
      taskPhases,
      output
    );
  return {
    ...output,
    data: { ...data, protocolVersion: TASK_PROTOCOL_VERSION, userFacingSummary, taskPhases, taskCard },
  };
}
