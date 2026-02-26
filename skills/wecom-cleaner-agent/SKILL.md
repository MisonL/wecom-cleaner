---
name: wecom-cleaner-agent
description: 用于执行和编排 wecom-cleaner 的无交互 Agent 技能。当任务涉及企业微信缓存盘点、年月清理、全量空间治理、批次恢复、回收区治理或系统自检，并要求高效执行与结构化反馈时触发。
---

# wecom-cleaner-agent

## 目标

- 用最少命令完成目标动作。
- 过程反馈简洁、可感知、可追踪。
- 默认安全（先 dry-run，再按授权执行真实动作）。

## 体验优先规则（必须遵守）

1. 全程仅用无交互命令：禁止执行 `wecom-cleaner`（无参数）进入 TUI。
2. 禁止无意义探索：不执行 `which`、不扫源码、不过度 grep，除非命令失败且必须定位原因。
3. 单任务最多三次进度反馈：
   - 开始执行（1句）
   - dry-run 结果（1句）
   - 最终结果（1句 + 关键数字）
4. 非必要不追加动作：真实执行后仅允许做一次同条件 dry-run 复核；复核通过即结束。
5. 仅在异常时扩展检查（如 `ok=false`、`errors` 非空、结果异常波动）。

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

## 安全与授权

- 未获明确授权前，不执行真实删除或真实恢复。
- `cleanup-monthly`、`space-governance`、`restore-batch`、`recycle-maintain` 默认保持 dry-run。
- 真实执行必须同时满足：
  - 用户明确同意
  - 命令显式携带 `--dry-run false --yes`
  - 已确认处理范围（账号、月份/目标、类别、目录来源）

## 默认执行流程（高频任务）

当用户说“清理 X 月及之前”时，固定三步：

1. `cleanup-monthly` dry-run（`--cutoff-month YYYY-MM --accounts all --output json`）
2. 若用户已明确“执行清理”，直接真实执行同参数（加 `--dry-run false --yes`）
3. 同参数再做一次 dry-run 复核并输出结论

约束：

- 默认不加 `--categories`，避免漏类。
- 默认不加 `--include-non-month-dirs true`，除非用户明确要求清理非月份目录。
- 不自动补跑 `analysis-only`；仅在结果异常时再询问用户后执行。

## 输出解析与回报模板

- 必须使用 `--output json`。
- 重点字段：
  - `ok`：是否成功
  - `action`：执行动作
  - `dryRun`：是否预演
  - `summary`：核心统计
  - `warnings`：兼容或降级提示
  - `errors`：错误详情（`code/message/path`）
  - `meta`：版本、耗时、引擎

回报模板：

- dry-run：`预演完成：matchedTargets=<n>，reclaimedBytes=<n>，failed=<n>。`
- 真实执行：`执行完成：success=<n>，failed=<n>，batchId=<id>。`
- 复核：`复核完成：剩余可清理=<n>（同范围）。`
- 异常：`执行失败：code=<code>，message=<msg>，建议=<next_step>。`

## 交互模式原则

- 默认不使用 `--interactive`。
- 仅当用户明确要求“演示交互界面”时才进入交互模式。

## 参考资料

- 常用命令模板：`references/commands.md`
