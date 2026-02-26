---
name: wecom-cleaner-agent
description: 用于执行和编排 wecom-cleaner 的无交互 Agent 技能。当任务涉及企业微信缓存盘点、年月清理、全量空间治理、批次恢复、回收区治理或系统自检，并要求 JSON 输出解析与 dry-run 安全门槛时触发。
---

# wecom-cleaner-agent

## 何时触发

- 用户要清理企业微信本地缓存，且希望由 Agent 自动执行。
- 用户要走无交互 CLI，返回可机读 JSON 结果。
- 用户要执行以下任一能力：盘点、年月清理、全量治理、批次恢复、回收区治理、系统自检。

## 默认执行策略

1. 优先无交互模式，不进入 TUI。
2. 先执行 `--doctor --output json` 做只读体检。
3. 每次调用必须且只能提供一个动作参数。
4. 破坏性动作先 dry-run，再根据用户确认决定真实执行。
5. 每次执行都使用 `--output json`，按字段解析结果并汇报。

## 动作契约

无交互模式只能选一个动作：

- `--cleanup-monthly`
- `--analysis-only`
- `--space-governance`
- `--restore-batch <batchId>`
- `--recycle-maintain`
- `--doctor`

退出码约定：

- `0` 成功
- `1` 业务失败或运行失败
- `2` 参数错误或动作冲突
- `3` 请求真实执行但缺少 `--yes`

## 安全门槛

- 未获明确授权前，不执行真实删除或真实恢复。
- `cleanup-monthly`、`space-governance`、`restore-batch`、`recycle-maintain` 默认保持 dry-run。
- 真实执行必须同时满足：
  - 用户明确同意
  - 命令显式携带 `--dry-run false --yes`
  - 已确认处理范围（账号、月份/目标、类别、目录来源）

## 输出解析规则

- 必须使用 `--output json`。
- 重点字段：
  - `ok`：是否成功
  - `action`：执行动作
  - `dryRun`：是否预演
  - `summary`：核心统计
  - `warnings`：兼容或降级提示
  - `errors`：错误详情（`code/message/path`）
  - `meta`：版本、耗时、引擎
- 判定逻辑：
  - `ok=true`：输出关键统计并进入下一步
  - `ok=false`：先汇总 `errors`，再给出修复后重试策略
  - `warnings` 包含引擎回退时：标记为非阻塞风险并继续

## 交互模式原则

- 默认不使用 `--interactive`。
- 仅当用户明确要求交互演示或人工选择时，才进入交互模式。

## 参考资料

- 常用命令模板：`references/commands.md`
