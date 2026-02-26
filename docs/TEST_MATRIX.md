# 测试矩阵（稳定性与极端场景）

本文用于约束 `wecom-cleaner` 在复杂组合场景与极端输入下的行为一致性，避免“看似成功但语义错误”。

## 目标

- 覆盖高风险动作：年月清理、全量空间治理、恢复、回收区治理。
- 锁定无交互契约：JSON 字段兼容、退出码语义稳定、text 卡片结论可读。
- 验证边界安全：路径越界、符号链接逃逸、索引异常、权限失败、并发竞争。

## 维度定义

### 维度 A：入口

- 交互模式（TUI）
- 无交互 CLI（`--output json|text`）
- Agent 脚本（`skills/wecom-cleaner-agent/scripts/*.sh`）

### 维度 B：动作

- `cleanup_monthly`
- `analysis_only`
- `space_governance`
- `restore`
- `recycle_maintain`
- `doctor`

### 维度 C：范围组合

- 账号：`current` / `all` / 指定 ID 集合
- 月份：显式 `--months` / `--cutoff-month` / 自动窗口
- 类别：默认 / 指定列表 / `all`
- 文件存储目录来源：`preset` / `configured` / `auto` / `all`

### 维度 D：执行模式

- dry-run（预演）
- 真实执行（`--dry-run false --yes`）
- 真实执行后复核（同条件二次运行）

### 维度 E：异常与边界

- 路径越界（`../`、绝对路径、非法根目录）
- 符号链接逃逸（raw 路径在根内，realpath 在根外）
- 索引异常（损坏行、批次根不一致、异常 `batchId`）
- 系统失败（`EACCES`、`ENOENT`、`ENOSPC`）
- 并发锁冲突与陈旧锁恢复

### 维度 F：规模

- 小样本（< 50 目录）
- 中样本（50~500 目录）
- 大样本（> 500 目录，强调耗时与稳定性）

## 关键断言模板（每个场景最少验证）

### 1) 退出码

- `0`：动作完成（可含业务失败明细）
- `2`：参数/用法错误
- `3`：真实执行缺少 `--yes`

### 2) JSON 契约（无交互）

必须存在且类型稳定：

- `ok: boolean`
- `action: string`
- `dryRun: boolean | null`
- `summary: object`
- `warnings: array`
- `errors: array`
- `meta.durationMs: number`
- `meta.engine: string`

### 3) 业务语义

- dry-run 不修改源目录
- 真实执行删除采用“移动到回收区”，可按批次恢复
- 无目标场景不得生成真实批次（或写入误导性“成功删除”）
- 部分失败时必须可见失败统计与错误明细

### 4) 审计一致性

- `index.jsonl` 记录动作、状态、路径、错误类型
- 越界/异常路径必须落审计（`error_type=PATH_VALIDATION_FAILED`）
- 回收区治理异常批次不得触发越界删除

## 最小必跑清单（回归基线）

1. `cleanup_monthly`：`--cutoff-month` + `--output json` + dry-run（有目标 / 无目标）
2. `cleanup_monthly`：真实执行 + 复核（复核命中应下降或归零）
3. `space_governance`：`suggested-only` 与 `allow-recent-active` 组合
4. `restore`：`skip/overwrite/rename` 三冲突策略
5. `recycle_maintain`：`disabled` / `no_candidate` / `partial_failed`
6. `doctor`：只读模式不创建状态目录
7. Agent 报告脚本：成功、无目标、失败三态退出码与卡片完整性

## 当前门禁（执行顺序）

1. `npm run check`
2. `npm run test:coverage:check`
3. `shellcheck skills/wecom-cleaner-agent/scripts/*.sh`
4. `npm run e2e:smoke`

说明：若新增动作/字段，需先补此文档矩阵与断言，再提交实现。
