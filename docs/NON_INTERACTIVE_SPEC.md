# 无交互参数规范（AI Agent）

本文档定义 `wecom-cleaner` 的无交互 CLI 契约，供 AI Agent/脚本稳定调用。

## 1. 运行入口

- `wecom-cleaner`（不带参数）：进入交互模式（TUI）。
- `wecom-cleaner ...args`（带参数）：进入无交互模式。
- `wecom-cleaner ...args --interactive`：即使带参数也强制进入交互模式（常用于本地调试/脚本回放）。
- `wecom-cleaner --help` / `wecom-cleaner -h`：输出命令帮助并退出（`0`）。
- `wecom-cleaner --version` / `wecom-cleaner -v`：输出版本号并退出（`0`）。

## 2. 动作选择（必填且互斥）

无交互模式必须且只能提供一个动作参数：

- `--cleanup-monthly`
- `--analysis-only`
- `--space-governance`
- `--restore-batch <batchId>`
- `--recycle-maintain`
- `--doctor`
- `--check-update`
- `--upgrade <npm|github-script>`

若缺少动作或动作冲突，退出码为 `2`。

## 3. 安全确认与 dry-run

破坏性动作：`cleanup-monthly`、`space-governance`、`restore-batch`、`recycle-maintain`。

规则：

- 默认 `dry-run`（不执行真实删除/恢复）。
- 真实执行需显式传 `--yes`。
- 若传 `--dry-run false` 且未传 `--yes`，退出码为 `3`。
- 可通过 `--run-task` 启用阶段协议：
  - `preview`：仅预演阶段。
  - `execute`：仅真实执行阶段（破坏性动作需 `--yes`）。
  - `preview-execute-verify`：预演 -> 真实执行 -> 同条件复核（预演命中 `0` 时自动跳过执行与复核）。

## 4. 输出协议

无交互默认输出 JSON，可通过 `--output text` 切换文本任务卡片（中文结论 + 范围 + 统计 + 风险提示）。

- `--output json|text`（默认 `json`）
- `--json` 为兼容别名（等价 `--output json`）
- `--run-task preview|execute|preview-execute-verify`（推荐破坏性动作使用）
- `--scan-debug off|summary|full`（默认 `off`）

JSON 顶层字段：

- `ok`：布尔
- `action`：动作名
- `dryRun`：布尔或 `null`
- `summary`：动作摘要
- `warnings`：字符串数组
- `errors`：错误数组（`code`、`message`、可选路径字段）
- `data`：动作明细数据
- `meta`：元信息（版本、耗时、引擎、时间戳等）
- `data.userFacingSummary`：统一的用户侧结果摘要（范围 + 结果 + 关键分布）
- `data.taskPhases`：阶段协议明细（仅在 `--run-task` 时返回）
- `data.taskCard`：阶段任务卡片（仅在 `--run-task` 时返回）
- `data.scanDebug`：扫描诊断信息（仅在 `--scan-debug summary|full` 时返回）

`cleanup_monthly` 常见 `summary` 字段：

- `batchId`
- `hasWork`
- `noTarget`
- `matchedTargets`
- `matchedBytes`
- `successCount`
- `skippedCount`
- `failedCount`
- `reclaimedBytes`
- `accountCount`
- `monthCount`
- `categoryCount`
- `externalRootCount`
- `cutoffMonth`
- `matchedMonthStart`
- `matchedMonthEnd`
- `rootPathCount`

`cleanup_monthly` 的 `data.report`：

- `matched`：
  - `totalTargets` / `totalBytes`
  - `monthRange` / `matchedMonths`
  - `categoryStats` / `monthStats` / `accountStats` / `rootStats`
  - `topPaths`（按体积排序）
- `executed`：
  - `byStatus`
  - `byCategory` / `byMonth` / `byRoot`
  - `topPaths`（按体积排序）

`analysis_only` 常见 `summary` 字段：

- `targetCount`
- `totalBytes`
- `accountCount`
- `matchedAccountCount`
- `categoryCount`
- `monthBucketCount`

`analysis_only` 的 `data.report`：

- `matched`：
  - `totalTargets` / `totalBytes`
  - `monthRange` / `matchedMonths`
  - `categoryStats` / `monthStats` / `accountStats` / `rootStats`
  - `topPaths`

`space_governance` 常见 `summary` 字段：

- `matchedTargets` / `matchedBytes`
- `successCount` / `skippedCount` / `failedCount` / `reclaimedBytes`
- `tierCount` / `targetTypeCount` / `rootPathCount`
- `allowRecentActive`

`space_governance` 的 `data.report`：

- `matched`：
  - `totalTargets` / `totalBytes`
  - `byTier` / `byTargetType` / `byAccount` / `byRoot`
  - `topPaths`
- `executed`：
  - `byStatus`
  - `byCategory` / `byMonth` / `byRoot`
  - `topPaths`

`restore` 常见 `summary` 字段：

- `batchId`
- `successCount` / `skippedCount` / `failedCount`
- `restoredBytes`
- `conflictStrategy`
- `entryCount` / `matchedBytes`
- `scopeCount` / `categoryCount` / `rootPathCount`

`restore` 的 `data.report`：

- `matched`：
  - `totalEntries` / `totalBytes`
  - `byScope` / `byCategory` / `byMonth` / `byRoot`
  - `topEntries`
- `executed`：
  - `byStatus`
  - `byScope` / `byCategory` / `byMonth` / `byRoot`
  - `topEntries`

`recycle_maintain` 常见 `summary` 字段：

- `status`
- `candidateCount`
- `selectedByAge` / `selectedBySize`
- `deletedBatches` / `deletedBytes` / `failedBatches`
- `remainingBatches` / `remainingBytes`

`recycle_maintain` 的 `data.report`：

- `before` / `after`
- `thresholdBytes` / `overThreshold`
- `selectedCandidates`
- `operations`

`doctor` 常见 `summary` 字段：

- `overall`
- `pass` / `warn` / `fail`

`doctor` 的 `data`：

- `checks`：体检项列表（pass/warn/fail）
- `metrics`：关键计数与容量
- `runtime`：平台与运行时信息

`check_update` 常见 `summary` 字段：

- `checked`
- `hasUpdate`
- `currentVersion` / `latestVersion`
- `source`
- `channel`
- `skippedByUser`

`check_update` 的 `data`：

- `update`：更新检查详情（`checkedAt`、`checkReason`、`errors`、`upgradeMethods`）

`upgrade` 常见 `summary` 字段：

- `executed`
- `method`
- `targetVersion`
- `status`
- `command`

`upgrade` 的 `data`：

- `upgrade`：升级执行结果（stdout/stderr/exit status）
- `update`：升级前检查结果（若有）

## 5. 退出码

- `0`：执行成功（含 dry-run 成功）
- `1`：执行失败（业务失败/运行失败）
- `2`：参数错误或动作契约错误
- `3`：缺少真实执行确认（`--yes`）

## 6. 全局参数

- `--root <path>`：Profile 根目录
- `--state-root <path>`：状态目录
- `--external-storage-root <path[,path...]>`：配置层手动文件存储目录
- `--external-storage-auto-detect <true|false>`：自动探测开关
- `--external-roots <path[,path...]>`：动作层临时覆盖文件存储目录
- `--external-roots-source <preset|configured|auto|all>`：按来源筛选探测目录（默认 `all`）
- `--theme <auto|light|dark>`
- `--interactive`：强制交互模式（与无交互动作参数互斥使用时，优先按交互模式执行）
- `--force`：锁异常场景下强制清理并继续（兜底参数）
- `--save-config`：把本次全局参数落盘到 `config.json`
- `--upgrade-channel <stable|pre>`：更新通道（稳定版/预发布）
- `--upgrade-version <x.y.z>`：升级到指定版本
- `--upgrade-yes`：确认执行升级（无此参数将拒绝执行升级）
- `--run-task preview|execute|preview-execute-verify`：无交互阶段协议
- `--scan-debug off|summary|full`：扫描诊断输出等级

## 7. 动作参数

### 7.1 `--cleanup-monthly`

- `--accounts <all|current|id1,id2...>`
- `--months <YYYY-MM,...>` 或 `--cutoff-month <YYYY-MM>`（二选一）
- `--categories <all|key1,key2...>`
- `--include-non-month-dirs <true|false>`
- `--dry-run <true|false>`

### 7.2 `--analysis-only`

- `--accounts <all|current|id1,id2...>`
- `--categories <all|key1,key2...>`

说明：

- `analysis-only` 默认按 `external-roots-source=all` 读取外部目录来源（只读动作，避免漏扫）。

### 7.3 `--space-governance`

- `--accounts <all|current|id1,id2...>`
- `--targets <targetId1,targetId2...>`
- `--tiers <safe|caution|protected>`
- `--suggested-only <true|false>`
- `--allow-recent-active <true|false>`
- `--dry-run <true|false>`

说明：

- `cleanup-monthly` / `space-governance` 默认 `external-roots-source=all`，优先减少漏扫。
- 若需更保守范围，可显式设置 `--external-roots-source preset`（仅默认+手动配置来源）。

### 7.4 `--restore-batch <batchId>`

- `--conflict <skip|overwrite|rename>`（默认 `skip`）
- `--dry-run <true|false>`

### 7.5 `--recycle-maintain`

- `--retention-enabled <true|false>`
- `--retention-max-age-days <int>`
- `--retention-min-keep-batches <int>`
- `--retention-size-threshold-gb <int>`
- `--dry-run <true|false>`

### 7.6 `--doctor`

- 无动作专属参数；只读执行，返回健康报告。

### 7.7 `--check-update`

- `--upgrade-channel <stable|pre>`（可选，默认读取配置）

说明：

- 手动触发版本检查，不执行升级动作。
- 检测优先 npm，失败自动回退 GitHub。

### 7.8 `--upgrade <npm|github-script>`

- `--upgrade-version <x.y.z>`（可选；缺省时先检查更新并升级到最新）
- `--upgrade-channel <stable|pre>`（可选）
- `--upgrade-yes`（必填确认）

说明：

- `npm`：执行 `npm i -g @mison/wecom-cleaner@<version>`
- `github-script`：执行 GitHub 托管脚本 `scripts/upgrade.sh`

## 8. 兼容参数

- `--mode`：兼容旧调用，会映射到动作参数并附带 warning，建议迁移。
