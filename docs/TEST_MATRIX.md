# 测试矩阵（稳定性与极端场景）

本文用于约束 `wecom-cleaner` 在复杂组合场景与极端输入下的行为一致性，避免“看似成功但语义错误”。

## 目标

- 覆盖高风险动作：年月清理、全量空间治理、恢复、回收站治理、自动服务。
- 锁定公共 v2 无交互契约：`agent-json` 字段兼容、退出码语义稳定、text 卡片结论可读。
- 验证边界安全：路径越界、符号链接逃逸、索引异常、权限失败、并发竞争。

## 维度定义

### 维度 A：入口

- 交互模式（TUI）
- 无交互 CLI（公共 v2：`inspect / plan / apply / verify / recover / service / update / skills`，输出 `text|agent-json`）
- Agent 脚本（`skills/wecom-cleaner-agent/scripts/*.sh`）

### 维度 B：动作

- `plan monthly-cleanup`
- `inspect footprint`
- `plan space-governance`
- `apply`
- `verify`
- `recover restore`
- `recover recycle`
- `inspect doctor`
- `update check`
- `update apply`
- `skills sync`
- `skills status`
- `service install`
- `service uninstall`
- `service status`
- `service run`

### 维度 C：范围组合

- 账号：`current` / `all` / 指定 ID 集合
- 月份：显式 `--months` / `--cutoff-month` / 自动窗口
- 类别：默认 / 指定列表 / `all`
- 文件存储目录来源：`preset` / `configured` / `auto` / `all`

### 维度 D：执行模式

- dry-run（预演）
- 真实执行（公共 v2：`apply --ack APPLY`、`recover ... --ack ...`、`service run --ack SERVICE_RUN`、`update apply ... --ack UPGRADE`、`skills sync --ack SKILLS_SYNC`）
- 真实执行后复核（`verify <run-id>` 或同策略二次只读核对）
- 阶段协议（仅兼容壳层：`--run-task preview|execute|preview-execute-verify`）
- 扫描诊断（`--scan-debug summary|full`）

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
- `3`：真实执行缺少确认参数（如 `--ack APPLY` / `--ack RESTORE` / `--ack UPGRADE`）

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
- 真实执行删除需区分：`direct`（不可恢复）与 `recycle/service_recycle`（可恢复）
- 无目标场景不得生成真实批次（或写入误导性“成功删除”）
- 部分失败时必须可见失败统计与错误明细

### 4) 审计一致性

- `index.jsonl` 记录动作、状态、路径、错误类型
- 越界/异常路径必须落审计（`error_type=PATH_VALIDATION_FAILED`）
- 回收区治理异常批次不得触发越界删除

## 最小必跑清单（回归基线）

1. `plan monthly-cleanup`：`--cutoff-month` + `--output agent-json` + 预演（有目标 / 无目标）
2. `plan monthly-cleanup -> apply -> verify`：真实执行闭环（复核命中应下降或归零）
3. `plan monthly-cleanup`：`--scan-debug summary/full`（诊断字段稳定）
4. 兼容壳层 `cleanup_monthly`：`--run-task preview-execute-verify --yes`（阶段字段稳定）
5. `plan space-governance`：`suggested-only` 与 `allow-recent-active` 组合
6. `recover restore`：`skip/overwrite/rename` 三冲突策略
7. `recover recycle`：`disabled` / `no_candidate` / `partial_failed`
8. `inspect doctor`：只读模式不创建状态目录
9. `inspect footprint`：严格只读，不创建状态目录且不触发 Zig 自动修复
10. `update check`：npm 正常 / npm 失败回退 GitHub / 全部失败
11. `update apply`：未确认拒绝、已是最新不执行、执行失败可返回非 0
12. `skills sync`：预演/真实同步、版本匹配状态收敛
13. `service install/status/uninstall`：状态链路与 `launchd plist` 稳定
14. `service run`：到期缓存处理、服务回收站治理、低空间紧急治理
15. Agent 报告脚本：成功、无目标、失败三态退出码与卡片完整性

## 当前门禁（执行顺序）

1. `npm run check`
2. `npm run check:skills-version`
3. `npm run test:coverage:check`
4. `shellcheck skills/wecom-cleaner-agent/scripts/*.sh scripts/upgrade.sh scripts/install-skill.sh scripts/release-gate.sh`
5. `npm run e2e:smoke`

说明：若新增动作/字段，需先补此文档矩阵与断言，再提交实现。
