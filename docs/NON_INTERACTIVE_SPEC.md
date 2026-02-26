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

若缺少动作或动作冲突，退出码为 `2`。

## 3. 安全确认与 dry-run

破坏性动作：`cleanup-monthly`、`space-governance`、`restore-batch`、`recycle-maintain`。

规则：

- 默认 `dry-run`（不执行真实删除/恢复）。
- 真实执行需显式传 `--yes`。
- 若传 `--dry-run false` 且未传 `--yes`，退出码为 `3`。

## 4. 输出协议

无交互默认输出 JSON，可通过 `--output text` 切换文本。

- `--output json|text`（默认 `json`）
- `--json` 为兼容别名（等价 `--output json`）

JSON 顶层字段：

- `ok`：布尔
- `action`：动作名
- `dryRun`：布尔或 `null`
- `summary`：动作摘要
- `warnings`：字符串数组
- `errors`：错误数组（`code`、`message`、可选路径字段）
- `data`：动作明细数据
- `meta`：元信息（版本、耗时、引擎、时间戳等）

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
- `--external-roots-source <preset|configured|auto|all>`：按来源筛选探测目录（默认 `preset`）
- `--theme <auto|light|dark>`
- `--interactive`：强制交互模式（与无交互动作参数互斥使用时，优先按交互模式执行）
- `--force`：锁异常场景下强制清理并继续（兜底参数）
- `--save-config`：把本次全局参数落盘到 `config.json`

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

### 7.3 `--space-governance`

- `--accounts <all|current|id1,id2...>`
- `--targets <targetId1,targetId2...>`
- `--tiers <safe|caution|protected>`
- `--suggested-only <true|false>`
- `--allow-recent-active <true|false>`
- `--dry-run <true|false>`

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

## 8. 兼容参数

- `--mode`：兼容旧调用，会映射到动作参数并附带 warning，建议迁移。
