---
name: wecom-cleaner-agent
description: 用于执行和编排 wecom-cleaner 的无交互 Agent 技能。当任务涉及企业微信缓存盘点、年月清理、全量空间治理、批次恢复、回收区治理或系统自检，并要求高效执行与结构化反馈时触发。
---

# wecom-cleaner-agent

## 目标

- 用最少命令完成目标动作。
- 默认安全（先预演，再按授权执行真实动作）。
- 输出“用户可读任务卡片”，避免技术键值堆砌。

## 强制规则

1. 全程只用无交互命令（禁止直接运行 `wecom-cleaner` 进入 TUI）。
2. 优先脚本入口，禁止手写三步命令流（除非脚本失败或缺失）。
3. 破坏性动作（清理/治理/恢复/回收区治理）默认预演；真实执行必须有明确授权。
4. 若预演命中为 `0`，必须结束并说明“无需执行”，不得继续真实执行。
5. 最终汇报必须是中文用户视角，先结论再细节，并解释关键指标含义。
6. 禁止在终端回显完整 JSON；只输出人类可读摘要。

## 动作到脚本映射（必须）

- 年月清理：`scripts/cleanup_monthly_report.sh`
- 会话分析（只读）：`scripts/analysis_report.sh`
- 全量空间治理：`scripts/space_governance_report.sh`
- 恢复已删除批次：`scripts/restore_batch_report.sh`
- 回收区治理：`scripts/recycle_maintain_report.sh`
- 系统自检：`scripts/doctor_report.sh`

调用顺序：

1. 先判断用户意图对应哪个动作。
2. 直接调用对应脚本。
3. 脚本失败时，才回退到 `wecom-cleaner --<action> --output json` 手工流程。

## 脚本调用约定

- 默认 `--execute false`（仅预演）。
- 用户明确“现在执行/开始清理/确认执行”时才传 `--execute true`。
- 破坏性动作脚本内部会做：预演 ->（可选）真实执行 ->（可选）复核。

推荐参数：

- `--root <path>`：显式指定 Profile 根目录（在多环境时强烈建议）。
- `--state-root <path>`：显式指定状态目录（便于审计与回放）。
- `--accounts all|current|id1,id2`：明确账号范围。
- `--external-roots-source all`：优先纳入自动探测目录，避免漏扫用户自定义文件存储位置。

## 最终汇报规范（对用户）

每次都要给“任务卡片”风格输出，至少包含：

1. 结果结论：是否完成、是否真实执行、是否无需执行。
2. 用户范围：账号范围、数据范围（月份/类别/批次/策略）。
3. 关键统计：命中数量、预计/实际释放（或恢复）空间、成功/跳过/失败、批次号。
4. 分布明细：按类别、按月份、按路径（Top 路径样例）。
5. 安全状态：引擎、耗时、告警数、错误数。
6. 指标释义：解释“命中目标、预计释放、批次号、复核剩余”等含义。

## 异常处理

- 参数错误（退出码 `2`）：说明缺失参数并给出可执行示例。
- 缺少确认（退出码 `3`）：提示需加 `--execute true`（脚本）或 `--dry-run false --yes`（CLI）。
- 业务失败（退出码 `1`）：提取 `errors.code/message`，给出下一步排查建议。
- 若发现 `warnings` 或 `errors` 非空，结论里必须明确标注。

## 参考资料

- 命令参考：`references/commands.md`
- 脚本目录：`scripts/`
