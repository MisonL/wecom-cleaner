# wecom-cleaner 命令参考（Agent）

## 1. 首选入口：任务卡片脚本（统一体验）

所有动作优先使用 `skills/wecom-cleaner-agent/scripts/` 下脚本，直接输出用户可读报告。
其中破坏性动作脚本（年月清理/全量治理/恢复/回收区治理）已统一内置 `--run-task` 阶段协议：

- `--execute false` 等价于 `preview`
- `--execute true` 等价于 `preview-execute-verify --yes`
- 当命中目标为 `0` 时会自动跳过真实执行，且保留一致的任务卡片输出与退出码语义

### 1.1 年月清理

```bash
bash scripts/cleanup_monthly_report.sh --cutoff-month 2024-07 --accounts all --execute false
bash scripts/cleanup_monthly_report.sh --cutoff-month 2024-07 --accounts all --execute true
```

### 1.2 会话分析（只读）

```bash
bash scripts/analysis_report.sh --accounts all
```

### 1.3 全量空间治理

```bash
bash scripts/space_governance_report.sh --accounts all --tiers safe,caution --execute false
bash scripts/space_governance_report.sh --accounts all --tiers safe,caution --execute true
```

### 1.4 恢复已删除批次

```bash
bash scripts/restore_batch_report.sh --batch-id 20260226-154831-c418d9 --conflict rename --execute false
bash scripts/restore_batch_report.sh --batch-id 20260226-154831-c418d9 --conflict rename --execute true
```

### 1.5 回收区治理

```bash
bash scripts/recycle_maintain_report.sh --execute false
bash scripts/recycle_maintain_report.sh --execute true
```

### 1.6 系统自检（只读）

```bash
bash scripts/doctor_report.sh
```

### 1.7 检查更新（只读）

```bash
bash scripts/check_update_report.sh --channel stable
```

### 1.8 程序升级

```bash
# 默认仅预演（不执行真实升级）
bash scripts/upgrade_report.sh --method npm --execute false

# 明确授权后执行真实升级
bash scripts/upgrade_report.sh --method npm --execute true
bash scripts/upgrade_report.sh --method github-script --version 1.3.2 --execute true
```

### 1.9 同步 Agent Skills

```bash
# 预演同步（不落盘）
wecom-cleaner --sync-skills --dry-run true --output json

# 真实同步（默认 npm）
wecom-cleaner --sync-skills --skill-sync-method npm --dry-run false --output json

# 按 GitHub 版本标签同步
wecom-cleaner --sync-skills --skill-sync-method github-script --skill-sync-ref 1.3.2 --dry-run false --output json
```

## 2. 常用全局参数

以上脚本都支持透传关键参数（按动作有所不同）：

- `--root <path>`
- `--state-root <path>`
- `--accounts all|current|id1,id2`
- `--categories <csv>`
- `--external-roots <path1,path2>`（恢复脚本）
- `--external-roots-source preset|configured|auto|all`（报告脚本默认 `all`）

## 3. 回退方案：直接调用 wecom-cleaner

仅在脚本不可用时使用直接命令，且保持 `--output json`。
破坏性动作必须使用 `--run-task`，并优先消费 `data.taskCard` / `data.taskPhases`。

```bash
# 年月清理（预演）
wecom-cleaner --cleanup-monthly --accounts all --cutoff-month 2024-07 --run-task preview --output json

# 年月清理（真实执行 + 复核）
wecom-cleaner --cleanup-monthly --accounts all --cutoff-month 2024-07 --run-task preview-execute-verify --yes --output json

# 会话分析
wecom-cleaner --analysis-only --accounts all --output json

# 全量空间治理（预演）
wecom-cleaner --space-governance --accounts all --tiers safe,caution --run-task preview --output json

# 全量空间治理（真实执行 + 复核）
wecom-cleaner --space-governance --accounts all --tiers safe,caution --run-task preview-execute-verify --yes --output json

# 批次恢复（预演）
wecom-cleaner --restore-batch 20260226-154831-c418d9 --conflict rename --run-task preview --output json

# 批次恢复（真实执行 + 复核）
wecom-cleaner --restore-batch 20260226-154831-c418d9 --conflict rename --run-task preview-execute-verify --yes --output json

# 回收区治理（预演）
wecom-cleaner --recycle-maintain --run-task preview --output json

# 回收区治理（真实执行 + 复核）
wecom-cleaner --recycle-maintain --run-task preview-execute-verify --yes --output json

# 系统自检
wecom-cleaner --doctor --output json

# 检查更新
wecom-cleaner --check-update --output json

# 程序升级（必须带 --upgrade-yes）
wecom-cleaner --upgrade npm --upgrade-yes --output json
wecom-cleaner --upgrade github-script --upgrade-version 1.3.2 --upgrade-yes --output json

# 同步 skills（独立动作）
wecom-cleaner --sync-skills --skill-sync-method npm --output json
```

## 4. 退出码约定

- `0`：成功（含预演成功）
- `1`：业务失败或运行失败
- `2`：参数错误或动作冲突
- `3`：请求真实执行但缺少确认（`--yes`）

## 5. Agent 输出要求

最终汇报必须包含：

1. 结论（完成/仅预演/无需执行/失败）
2. 范围（账号、月份/类别/批次/策略）
3. 核心统计（命中、预计/实际释放、成功/跳过/失败、批次号）
4. 分布明细（按类别/月份/路径）
5. 安全状态（耗时、引擎、告警、错误）

实现建议（统一体验）：

- 优先消费 `data.userFacingSummary`，并优先展示其中 `scopeNotes`（扫描边界说明）。
- 对 `check-update` 动作，优先展示 `summary.sourceChain`，明确“npm -> GitHub 回退”链路。
