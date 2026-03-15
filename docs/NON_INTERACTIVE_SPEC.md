# 无交互参数规范（AI Agent）

本文档定义 `wecom-cleaner` 的无交互 CLI 契约，供 AI Agent/脚本稳定调用。

> v2 cutover:
>
> - 公共入口以子命令为准：`inspect / plan / apply / verify / recover / service / update / skills`
> - 旧顶层动作旗标仅保留内部测试/兼容壳层，不再属于公共 CLI 契约
> - 自动化调用默认应使用 `--output agent-json`

## 1. 运行入口

- `wecom-cleaner`（不带参数）：进入交互模式（TUI）。
- `wecom-cleaner ...args`（带参数）：进入无交互模式。
- `wecom-cleaner ...args --interactive`：即使带参数也强制进入交互模式（常用于本地调试/脚本回放）。
- `wecom-cleaner --help` / `wecom-cleaner -h`：输出命令帮助并退出（`0`）。
- `wecom-cleaner --version` / `wecom-cleaner -v`：输出版本号并退出（`0`）。

## 2. 公共 v2 子命令

公共 CLI 入口以 v2 子命令为准：

- `inspect footprint`
- `inspect doctor`
- `plan monthly-cleanup`
- `plan space-governance`
- `apply <planId>`
- `verify <runId>`
- `recover restore <batchId>`
- `recover recycle`
- `service install|status|run|uninstall`
- `update check`
- `update apply <npm|github-script>`
- `skills status|sync`

若缺少动作或动作冲突，退出码为 `2`。

## 3. 安全确认与 dry-run

破坏性动作：`apply`、`recover restore`、`recover recycle`、`service run`、`update apply`、`skills sync`。

规则：

- `plan monthly-cleanup` / `plan space-governance` 默认仅预演，不执行真实删除。
- 真实执行通过显式确认子命令触发：
  - `apply <planId> --ack APPLY`
  - `recover restore <batchId> --ack RESTORE`
  - `recover recycle --ack RECYCLE`
  - `service run --ack SERVICE_RUN`
  - `update apply <method> --ack UPGRADE`
  - `skills sync --ack SKILLS_SYNC`
- 若缺少确认参数，退出码为 `3`。
- 非交互直删仍需额外显式传：`--delete-mode direct --direct-delete-ack DIRECT_DELETE`。
- 旧兼容壳层仍可通过 `--run-task` 触发阶段协议，但不再属于公共 CLI 契约。

## 4. 输出协议

公共 v2 子命令默认输出 `agent-json`，可通过 `--output text` 切换文本任务卡片（中文结论 + 范围 + 统计 + 风险提示）。

- `--output text|agent-json`（公共 v2 默认 `agent-json`）
- `--json` 为兼容别名（等价 `--output json`，不属于公共 v2 契约）
- `--run-task preview|execute|preview-execute-verify`（兼容壳层阶段协议）
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
  - `scopeNotes`：扫描边界说明（例如是否纳入“文件存储位置”目录、是否因命中为 0 跳过执行）
- `data.protocolVersion`：任务协议版本，当前为 `1`
- `data.taskPhases`：阶段协议明细；`--run-task` 返回预演/执行/复核三阶段，其他动作至少返回单阶段摘要
- `data.taskCard`：阶段任务卡片；无交互统一返回，供 Agent 直接消费
- `data.scanDebug`：扫描诊断信息（仅在 `--scan-debug summary|full` 时返回）
- 破坏性清理类动作新增：
  - `summary.deleteMode`
  - `summary.recoverable`
  - `data.deleteMode`

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
- `recycleScope`
- `candidateCount`
- `selectedByAge` / `selectedBySize`
- `deletedBatches` / `deletedBytes` / `failedBatches`
- `remainingBatches` / `remainingBytes`

`recycle_maintain` 的 `data.report`：

- `before` / `after`
- `thresholdBytes` / `overThreshold`
- `selectedCandidates`
- `operations`
- `scopeResults`（当 `--recycle-scope all` 时返回）

`service_status` 常见 `summary` 字段：

- `installed`
- `loginLoaded`
- `scheduleLoaded`
- `nextRunAt`
- `deleteMode`
- `retainDays`
- `triggerTimes`

`service_run` 常见 `summary` 字段：

- `status`
- `triggerSource`
- `deleteMode`
- `retainDays`
- `matchedTargets` / `matchedBytes`
- `reclaimedBytes`
- `serviceRecycleDeletedBatches` / `serviceRecycleDeletedBytes`
- `lowSpaceTriggered` / `lowSpaceDeletedBatches` / `lowSpaceDeletedBytes`

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
- `sourceChain`（来源链路说明：先 npm，必要时自动回退 GitHub）
- `channel`
- `skippedByUser`
- `skillsStatus` / `skillsMatched`
- `skillsInstalledVersion` / `skillsBoundAppVersion`

`check_update` 的 `data`：

- `update`：更新检查详情（`checkedAt`、`checkReason`、`errors`、`upgradeMethods`）
- `skills`：skills 版本绑定详情（状态、目录、建议）

说明：

- 当 npm 失败但 GitHub 回退成功时，动作整体仍为成功：
  - `summary.source=github`
  - `summary.sourceChain` 会说明“npm 失败后回退”
  - 失败细节进入 `warnings`，不计入 `errors`

`upgrade` 常见 `summary` 字段：

- `executed`
- `method`
- `targetVersion`
- `status`
- `command`
- `skillSyncEnabled`
- `skillSyncMethod`
- `skillSyncStatus`
- `skillSyncTargetVersion`
- `skillsStatusBefore` / `skillsStatusAfter`

`upgrade` 的 `data`：

- `upgrade`：升级执行结果（stdout/stderr/exit status）
- `update`：升级前检查结果（若有）
- `skills`：升级前后 skills 绑定状态
- `skillSync`：skills 同步执行结果

`sync_skills` 常见 `summary` 字段：

- `method`：同步方式（`npm` / `github-script`）
- `dryRun`：是否预演
- `status`：`dry_run` / `synced` / `failed` / `mismatch_after_sync`
- `skillsStatusBefore` / `skillsStatusAfter`
- `skillsMatchedAfter`

`sync_skills` 的 `data`：

- `before` / `after`：同步前后 skills 绑定详情
- `skillSync`：执行命令与退出码

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
- `--skill-sync-method <npm|github-script>`：skills 同步方式
- `--skill-sync-ref <x.y.z>`：skills 同步版本标签
- `--run-task preview|execute|preview-execute-verify`：无交互阶段协议
- `--scan-debug off|summary|full`：扫描诊断输出等级

## 7. v2 子命令参数

### 7.1 `plan monthly-cleanup`

- `--accounts <all|current|id1,id2...>`
- `--months <YYYY-MM,...>` 或 `--cutoff-month <YYYY-MM>`（二选一）
- `--categories <all|key1,key2...>`
- `--include-non-month-dirs <true|false>`
- `--dry-run <true|false>`

### 7.2 `inspect footprint`

- `--accounts <all|current|id1,id2...>`
- `--categories <all|key1,key2...>`

说明：

- `inspect footprint` 默认按 `external-roots-source=all` 读取外部目录来源（只读动作，避免漏扫）。
- `inspect footprint` 为严格只读：不会创建状态目录、索引文件或锁文件，也不会触发 Zig 自动修复下载。

### 7.3 `plan space-governance`

- `--accounts <all|current|id1,id2...>`
- `--targets <targetId1,targetId2...>`
- `--tiers <safe|caution|protected>`
- `--suggested-only <true|false>`
- `--allow-recent-active <true|false>`
- `--dry-run <true|false>`

说明：

- `plan monthly-cleanup` / `plan space-governance` 默认 `external-roots-source=all`，优先减少漏扫。
- 若需更保守范围，可显式设置 `--external-roots-source preset`（仅默认+手动配置来源）。

### 7.4 `apply <planId>` / `verify <runId>`

- `apply <planId> --ack APPLY`
- `verify <runId>`
- 通常与 `plan monthly-cleanup` / `plan space-governance` 配套使用

说明：

- `apply` 只会执行 `plan` 阶段冻结下来的目标范围；若当前扫描结果与计划签名不一致，会拒绝执行，避免计划漂移。
- `verify` 复用同一份冻结范围做复核，不会因为重新扫描或自动探测变化把计划外内容混入结果。
- 对 `plan space-governance --targets ...` 这类显式目标计划，若目标已在执行阶段被清理，`verify` 会按“已清理完成”处理，不会误报参数错误。

### 7.5 `recover restore <batchId>`

- `--conflict <skip|overwrite|rename>`（默认 `skip`）
- `--dry-run <true|false>`

### 7.6 `recover recycle`

- `--retention-enabled <true|false>`
- `--retention-max-age-days <int>`
- `--retention-min-keep-batches <int>`
- `--retention-size-threshold-gb <int>`
- `--dry-run <true|false>`

### 7.7 `inspect doctor`

- 无动作专属参数；只读执行，返回健康报告。

### 7.8 `update check`

- `--upgrade-channel <stable|pre>`（可选，默认读取配置）

说明：

- 手动触发版本检查，不执行升级动作。
- 检测优先 npm，失败自动回退 GitHub。

### 7.9 `update apply <npm|github-script>`

- `--upgrade-version <x.y.z>`（可选；缺省时先检查更新并升级到最新）
- `--upgrade-channel <stable|pre>`（可选）
- `--ack UPGRADE`（必填确认）

说明：

- `npm`：执行 `npm i -g @mison/wecom-cleaner@<version>`
- `github-script`：执行 GitHub 托管脚本 `scripts/upgrade.sh`
- 默认会联动同步 skills，可通过 `--upgrade-sync-skills false` 关闭。

### 7.10 `skills status|sync`

- `skills status`
- `skills sync --skill-sync-method <npm|github-script>`（可选，默认 `npm`）
- `skills sync --skill-sync-ref <x.y.z>`（可选）
- `skills sync --ack SKILLS_SYNC`（真实同步确认）

说明：

- 用于单独修复/升级 Agent skills 版本绑定。
- `npm` 方式优先使用本地随包 skills；`github-script` 方式按指定版本标签下载。

## 8. 兼容参数

- `--json`：兼容旧 JSON 输出别名，不属于公共 v2 契约。
- `--mode`：兼容旧调用，会映射到 v2 子命令并附带 warning，建议迁移。
- `--run-task`：兼容壳层使用的阶段协议参数；公共 v2 CLI 优先直接使用 `plan / apply / verify` 或对应确认子命令。
- `--upgrade-yes` / `--upgrade-sync-skills`：兼容旧升级调用；公共 v2 升级入口使用 `update apply <method> --ack UPGRADE`。
