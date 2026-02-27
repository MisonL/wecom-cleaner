# wecom-cleaner

<p align="left">
  <a href="https://www.npmjs.com/package/@mison/wecom-cleaner"><img alt="npm" src="https://img.shields.io/npm/v/%40mison%2Fwecom-cleaner?style=flat-square" /></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-2ea043?style=flat-square" /></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D20-1f6feb?style=flat-square" />
  <img alt="platform" src="https://img.shields.io/badge/platform-macOS-0ea5e9?style=flat-square" />
  <img alt="engine" src="https://img.shields.io/badge/engine-Node%20%2B%20Zig-0891b2?style=flat-square" />
</p>

企业微信本地缓存清理工具（交互式 CLI/TUI）。

- 软件名：`wecom-cleaner`
- npm 包：`@mison/wecom-cleaner`
- 命令名：`wecom-cleaner`
- 仓库：<https://github.com/MisonL/wecom-cleaner>

> 定位：在“可回收、可恢复、可审计”前提下，清理企业微信本地缓存，避免误删业务资料。

## 目录

- [项目定位](#项目定位)
- [功能总览](#功能总览)
- [能力边界](#能力边界)
- [安装与运行](#安装与运行)
- [Agent Skills 安装](#agent-skills-安装)
- [常用参数](#常用参数)
- [数据与审计文件](#数据与审计文件)
- [开发与质量门禁](#开发与质量门禁)
- [测试矩阵](#测试矩阵)
- [发布与打包](#发布与打包)
- [FAQ](#faq)

## 项目定位

`wecom-cleaner` 解决的是“本地缓存空间治理”问题，不改变服务端数据。

设计原则：

- 安全优先：默认以回收区搬移代替直接删除。
- 可恢复：所有可执行删除都记录索引并支持按批次恢复。
- 可审计：关键分支会写入状态码，便于追踪与复盘。
- 渐进增强：有 Zig 核心则加速，无则自动回退 Node。

## 功能总览

| 模块               | 是否可执行删除 | 说明                                               |
| ------------------ | -------------- | -------------------------------------------------- |
| 年月清理（默认）   | 是             | 按账号 + 年月 + 类型筛选缓存，支持 dry-run。       |
| 会话分析           | 否             | 只读分析目录/体积分布，不做删除。                  |
| 全量空间治理       | 是             | 分级治理高占用缓存目录（安全层/谨慎层/受保护层）。 |
| 回收区治理         | 是             | 按保留策略清理回收区历史批次，支持 dry-run。       |
| 恢复已删除批次     | 是             | 基于索引恢复，支持覆盖/重命名/跳过。               |
| 系统自检（doctor） | 否             | 检查目录权限、账号发现、核心可用性与回收区健康。   |
| 交互配置           | 否             | 配置根目录、主题、文件存储目录、外部自动探测等。   |

### 关键能力

1. 多账号支持

- 自动识别 `Profiles` 下账号目录。
- 账号以 `用户名 | 企业名 | 短ID` 显示，可多选。
- 支持账号别名，修正常见不可读字段。

2. 文件存储目录识别

- 支持默认路径、手动配置路径、自动探测路径。
- 自动探测采用“结构 + 缓存特征”联合识别（如 `*/WXWork Files/Caches` + 企业微信缓存类别/月目录信号），不依赖目录名且降低误判。
- 自动探测结果默认预选，执行前可手动取消；同时保留确认提示，避免误纳入无关目录。

3. 删除与恢复链路

- 删除动作统一进入程序回收区，而不是直接 `rm`。
- 写入 `index.jsonl` 审计记录，恢复按批次回放。
- 恢复时做路径边界校验（含 `realpath` 防符号链接越界）。
- 恢复支持先 `dry-run` 预演，再选择是否执行真实恢复。

4. 回收区保留策略

- 支持“保留最近 N 批 + 保留近 N 天 + 容量阈值”联合治理。
- 超过阈值会给出空间提示，可一键进入回收区治理。

5. Zig 核心与自动修复

- 有可用 Zig 核心时自动启用加速。
- 不可用时自动回退 Node，功能不受影响。
- 可按 manifest 下载并校验 SHA256 后修复核心。

6. 可观测性与并发安全

- `doctor` 模式可输出人类可读报告，或通过 `--output json` 输出结构化结果。
- `doctor` 模式为只读体检：不会自动创建状态目录/回收区，也不会触发 Zig 自动修复下载。
- 多实例并发默认加锁；检测到陈旧锁会优先自动恢复，异常场景可用 `--force` 兜底清理。

7. 自主升级体系

- 启动后按“早/午/晚”三时段检查更新（默认开启）。
- 版本源优先 npmjs，失败自动回退 GitHub Release。
- 检查更新会同时校验 Agent skills 是否与主程序版本匹配。
- 交互模式发现新版本时可直接选择升级方式：
  - npm 升级（默认）
  - GitHub 脚本升级
- 程序升级完成后默认联动同步 skills，避免“程序已升级但 skills 仍旧版”。
- 无交互模式可用 `--sync-skills` 单独修复 skills 版本绑定。

## 能力边界

企业微信会话数据库为私有/加密格式，当前无法稳定建立“会话名 -> 本地缓存目录”的强映射。

因此：

- 支持按“年月目录”执行清理。
- 支持按“会话维度”做只读分析。
- 不提供“按会话自动删除”。

## 安装与运行

### 方式一：直接运行

```bash
npx @mison/wecom-cleaner
```

### 方式二：本地开发

```bash
npm install
npm run build:native
npm run dev
```

### 全菜单 smoke 回归

```bash
npm run e2e:smoke
```

说明：

- 脚本会在 `/tmp/wecom-e2e-*` 构造隔离夹具，不触碰真实企业微信目录。
- 覆盖开始菜单与关键分支：年月清理、会话分析、全量治理、回收区治理、恢复、系统自检、设置。
- 可用 `npm run e2e:smoke -- --keep` 保留日志与测试目录。

## Agent Skills 安装

内置技能：`wecom-cleaner-agent`（用于 Codex/Agent 无交互调用）。

推荐方式（npmjs，最稳定）：

```bash
npx --yes --package=@mison/wecom-cleaner wecom-cleaner-skill install
```

常用参数：

- `--target <dir>`：自定义安装目录（默认 `$CODEX_HOME/skills` 或 `~/.codex/skills`）
- `--force`：覆盖已存在技能目录
- `--dry-run`：仅预演，不落盘
- `status` 子命令：检查 skills 与主程序版本是否匹配
- `sync` 子命令：等价 `install --force`，用于升级 skills

示例：

```bash
npx --yes --package=@mison/wecom-cleaner wecom-cleaner-skill install --force
npx --yes --package=@mison/wecom-cleaner wecom-cleaner-skill install --target ~/.codex/skills
npx --yes --package=@mison/wecom-cleaner wecom-cleaner-skill status --json
npx --yes --package=@mison/wecom-cleaner wecom-cleaner-skill sync
```

GitHub 备选方式（无 npm 包依赖）：

```bash
curl -fsSL https://raw.githubusercontent.com/MisonL/wecom-cleaner/main/scripts/install-skill.sh | bash
```

若需安装指定版本标签（例如 `v1.3.3`）：

```bash
curl -fsSL https://raw.githubusercontent.com/MisonL/wecom-cleaner/main/scripts/install-skill.sh | bash -s -- --ref v1.3.3
```

Agent 侧统一任务入口脚本（位于 `skills/wecom-cleaner-agent/scripts/`）：

- `cleanup_monthly_report.sh`：年月清理任务卡片（预演/执行/复核）
- `analysis_report.sh`：会话分析（只读）任务卡片
- `space_governance_report.sh`：全量空间治理任务卡片
- `restore_batch_report.sh`：批次恢复任务卡片
- `recycle_maintain_report.sh`：回收区治理任务卡片
- `doctor_report.sh`：系统自检任务卡片
- `check_update_report.sh`：检查更新任务卡片
- `upgrade_report.sh`：程序升级任务卡片（默认预演）

## 常用参数

运行方式：

- 不带参数：进入交互菜单（TUI）。
- 带参数：进入无交互执行（默认输出 JSON，适合 AI Agent）。
- 带参数但需交互：可追加 `--interactive` 强制进入交互流程（支持配合 `--mode` 直达功能）。
- 完整契约文档：[`docs/NON_INTERACTIVE_SPEC.md`](./docs/NON_INTERACTIVE_SPEC.md)。

### 无交互动作参数（互斥，必须且只能一个）

- `--cleanup-monthly`
- `--analysis-only`
- `--space-governance`
- `--restore-batch <batchId>`
- `--recycle-maintain`
- `--doctor`
- `--check-update`
- `--upgrade <npm|github-script>`
- `--sync-skills`

### 无交互安全规则

- 破坏性动作（清理/治理/恢复/回收区治理）默认 `dry-run`。
- 显式真实执行需带 `--yes`。
- 若传 `--dry-run false` 但未传 `--yes`，将直接退出（退出码 `3`）。

### 常用无交互示例

```bash
# 年月清理（默认 dry-run）
wecom-cleaner --cleanup-monthly \
  --accounts current \
  --cutoff-month 2024-02 \
  --categories files,images

# 年月清理（真实执行）
wecom-cleaner --cleanup-monthly \
  --accounts all \
  --months 2023-01,2023-02 \
  --categories files \
  --dry-run false \
  --yes

# 全量空间治理（仅建议项，真实执行）
wecom-cleaner --space-governance \
  --suggested-only true \
  --tiers safe,caution \
  --dry-run false \
  --yes

# 回收区治理（按策略执行）
wecom-cleaner --recycle-maintain --dry-run false --yes

# 年月清理（三阶段协议：预演 -> 执行 -> 复核）
wecom-cleaner --cleanup-monthly --accounts all --cutoff-month 2024-04 --run-task preview-execute-verify --yes

# 批次恢复（冲突策略：重命名）
wecom-cleaner --restore-batch 20260226-105009-ffa098 --conflict rename

# 系统自检（默认 JSON 输出）
wecom-cleaner --doctor

# 检查更新（不执行升级）
wecom-cleaner --check-update --output text

# 执行升级（npm 默认方式）
wecom-cleaner --upgrade npm --upgrade-yes

# 执行升级（GitHub 托管脚本方式）
wecom-cleaner --upgrade github-script --upgrade-version 1.3.3 --upgrade-yes

# 单独同步 skills（修复版本不匹配）
wecom-cleaner --sync-skills --skill-sync-method npm --dry-run false
```

### 输出与兼容参数

- `--output json|text`：无交互输出格式，默认 `json`。
- `--json`：兼容别名，等价于 `--output json`。
- `--run-task preview|execute|preview-execute-verify`：阶段任务协议（推荐给 Agent）。
- `--scan-debug off|summary|full`：扫描诊断信息输出等级。
- `--mode`：兼容参数，建议迁移到动作参数（如 `--cleanup-monthly`）。
- `--save-config`：将本次全局配置参数写回 `config.json`。
- `--help` / `-h`：输出命令帮助并退出。
- `--version` / `-v`：输出版本号并退出。
- `--upgrade-channel stable|pre`：升级检查通道（稳定版/预发布）。
- `--upgrade-version <x.y.z>`：指定升级目标版本。
- `--upgrade-yes`：确认执行升级动作（无此参数将拒绝执行升级）。
- `--upgrade-sync-skills true|false`：升级后是否联动同步 skills（默认 `true`）。
- `--skill-sync-method npm|github-script`：skills 同步方式（默认 `npm`）。
- `--skill-sync-ref <x.y.z>`：skills 同步版本标签（通常与程序版本一致）。

### 各动作关键统计字段（JSON）

#### `cleanup-monthly`

- `summary.matchedTargets`：命中目标数
- `summary.matchedBytes`：命中目标总字节
- `summary.hasWork` / `summary.noTarget`：是否存在可执行目标
- `summary.successCount` / `skippedCount` / `failedCount`
- `summary.reclaimedBytes`：预计或实际释放字节
- `summary.batchId`：真实执行批次号（dry-run 为预演批次）
- `summary.matchedMonthStart` / `matchedMonthEnd`：本次命中的月份区间
- `summary.rootPathCount`：涉及的清理根目录数量
- `summary.accountCount` / `monthCount` / `categoryCount` / `externalRootCount`
- `summary.cutoffMonth`：截止月份（当使用 `--cutoff-month` 时）
- `summary.runTaskMode` / `summary.taskDecision`：阶段协议模式与决策（仅 `--run-task`）

`cleanup-monthly` 还会在 `data.report` 中返回可展示明细：

- `data.report.matched.categoryStats`：按类别统计（条目数、体积）
- `data.report.matched.monthStats`：按月份统计（条目数、体积）
- `data.report.matched.rootStats`：按根目录统计（条目数、体积）
- `data.report.matched.topPaths`：按体积 Top 路径样例
- `data.report.executed.byCategory/byMonth/byRoot`：真实执行落地统计（成功/跳过/失败 + 体积）
- `data.taskPhases`：阶段执行明细（预演/执行/复核）
- `data.taskCard`：面向用户的任务卡片聚合结果
- `data.scanDebug`：扫描诊断（当 `--scan-debug summary|full`）

#### `analysis-only`

- `summary.targetCount` / `totalBytes`：命中目录数与总体积
- `summary.accountCount` / `matchedAccountCount` / `categoryCount` / `monthBucketCount`：维度汇总（范围账号数 vs 实际命中账号数）
- `data.accountsSummary` / `categoriesSummary` / `monthsSummary`：分布统计
- `data.report.matched`：统一的类别/月份/根目录/路径样例统计结构

#### `space-governance`

- `summary.matchedTargets` / `matchedBytes`
- `summary.successCount` / `skippedCount` / `failedCount` / `reclaimedBytes`
- `summary.tierCount` / `targetTypeCount` / `rootPathCount`
- `data.report.matched.byTier/byTargetType/byAccount/byRoot/topPaths`
- `data.report.executed.byCategory/byMonth/byRoot/topPaths`（真实执行时）

#### `restore-batch`

- `summary.batchId` / `entryCount` / `matchedBytes`
- `summary.successCount` / `skippedCount` / `failedCount` / `restoredBytes`
- `summary.scopeCount` / `categoryCount` / `rootPathCount`
- `data.report.matched.byScope/byCategory/byMonth/byRoot/topEntries`
- `data.report.executed.byScope/byCategory/byMonth/byRoot/topEntries`（真实执行时）

#### `recycle-maintain`

- `summary.candidateCount` / `selectedByAge` / `selectedBySize`
- `summary.deletedBatches` / `deletedBytes` / `failedBatches`
- `summary.remainingBatches` / `remainingBytes`
- `data.report.before` / `after` / `thresholdBytes` / `overThreshold`
- `data.report.selectedCandidates` / `operations`

#### `doctor`

- `summary.overall` / `pass` / `warn` / `fail`
- `data.checks`：逐项体检结论（pass/warn/fail）
- `data.metrics`：账号数、回收区占用、外部存储等关键指标
- `data.runtime`：运行时环境信息

#### `check-update`

- `summary.checked`：是否完成检查
- `summary.hasUpdate`：是否发现新版本
- `summary.currentVersion` / `latestVersion`
- `summary.source`：`npm` 或 `github`
- `summary.channel`：`stable` 或 `pre`
- `summary.skillsStatus` / `summary.skillsMatched`
- `summary.skillsInstalledVersion` / `summary.skillsBoundAppVersion`
- `data.update`：检查详情（含 `errors`、`checkReason`、`checkedAt`）
- `data.skills`：skills 绑定详情（状态、目录、建议）

#### `upgrade`

- `summary.executed`：是否执行了升级命令
- `summary.method`：`npm` 或 `github-script`
- `summary.targetVersion`：目标版本
- `summary.status`：升级命令退出码
- `data.upgrade.command`：实际执行命令
- `summary.skillSyncStatus` / `summary.skillSyncMethod` / `summary.skillSyncTargetVersion`
- `summary.skillsStatusBefore` / `summary.skillsStatusAfter`
- `data.skillSync`：skills 同步命令结果

#### `sync-skills`

- `summary.method`：skills 同步方式（`npm` / `github-script`）
- `summary.status`：`dry_run` / `synced` / `failed` / `mismatch_after_sync`
- `summary.skillsStatusBefore` / `summary.skillsStatusAfter`
- `data.before` / `data.after`：同步前后 skills 绑定详情
- `data.skillSync`：执行命令与退出码

### 全局参数

- `--root <path>`：Profile 根目录
- `--state-root <path>`：状态目录
- `--external-storage-root <path[,path...]>`：手动文件存储目录（配置层）
- `--external-storage-auto-detect <true|false>`：外部存储自动探测总开关
- `--external-roots <path[,path...]>`：本次动作临时覆盖的文件存储目录
- `--external-roots-source <preset|configured|auto|all>`：按来源筛选探测目录（默认 `all`，优先减少漏扫；可按需收窄）
- `--theme <auto|light|dark>`：Logo 主题
- `--interactive`：即使携带参数也进入交互流程（可配合 `--mode`）
- `--force`：锁异常场景下强制清理并继续（兜底参数，通常无需）
- `--run-task preview|execute|preview-execute-verify`：阶段任务协议（推荐无交互自动化调用）
- `--scan-debug off|summary|full`：附加扫描诊断信息

### `--theme` 可选值

- `auto`：自动判断终端主题
- `light`：亮色
- `dark`：暗色

### 额外环境变量

- `WECOM_CLEANER_NATIVE_AUTO_REPAIR=true|false`：Zig 自动修复总开关（默认 `true`）
- `WECOM_CLEANER_NATIVE_BASE_URL=<url>`：核心下载基地址
- `WECOM_CLEANER_NATIVE_DOWNLOAD_TIMEOUT_MS=<ms>`：下载超时（默认 `15000`）
- `WECOM_CLEANER_NATIVE_PROBE_TIMEOUT_MS=<ms>`：核心探针超时（默认 `3000`，最小 `500`）
- `WECOM_CLEANER_EXTERNAL_AUTO_DETECT=true|false`：外部存储自动探测总开关
- `WECOM_CLEANER_AUTO_UPDATE=true|false`：自主升级自动检查总开关（默认 `true`）

## 数据与审计文件

默认状态目录：`~/.wecom-cleaner-state`

- `config.json`：交互配置
- `account-aliases.json`：账号别名
- `index.jsonl`：删除/恢复流水审计
- `recycle-bin/`：回收区
- `.wecom-cleaner.lock`：运行锁文件（防并发误操作）

`index.jsonl` 常见字段：

- `scope`：`cleanup_monthly` 或 `space_governance`
- `tier`：`safe` / `caution` / `protected`
- `status`：`success`、`dry_run`、`skipped_*`、`failed`
- `error_type`：错误分类（如 `path_not_found`、`path_validation_failed`、`permission_denied`）

回收区治理审计（`action=recycle_maintain`）常见字段：

- `selected_by_age`：按年龄规则选中的批次数
- `selected_by_size`：按容量规则补选的批次数
- `remaining_bytes`：治理后回收区总占用

常见越界拦截原因（`skipped_invalid_path.invalid_reason`）：

- `source_outside_profile_root`
- `source_outside_governance_root`
- `source_symlink_escape`
- `recycle_symlink_escape`
- `missing_allowed_root`
- `missing_recycle_root`
- `source_path_unresolvable`
- `recycle_path_unresolvable`

## 开发与质量门禁

```bash
# 语法检查
npm run check

# 单元测试
npm run test

# 覆盖率报告
npm run test:coverage

# 覆盖率门禁（lines/statements >= 75%，functions >= 80%，branches >= 60%）
npm run test:coverage:check

# 格式化与风格检查
npm run format
npm run format:check
```

发布前推荐全量门禁：

```bash
npm run format:check
npm run check
npm run test:coverage:check
npm run release:gate
npm run e2e:smoke -- --keep
npm run pack:tgz:dry-run
```

当前基线（主分支）：

- 单元测试：`107/107` 通过。
- 覆盖率：`statements 87.66%`，`branches 74.38%`，`functions 92.47%`，`lines 87.66%`。
- 全菜单 smoke：通过（含恢复冲突分支与 doctor JSON 分支）。

## 测试矩阵

- 场景矩阵与断言模板见：[`docs/TEST_MATRIX.md`](./docs/TEST_MATRIX.md)
- 新增动作或输出字段时，需同步更新矩阵并补对应测试。

## 发布与打包

`prepack` 会自动执行：

- `npm run build:native:release`
- `npm run check`

默认构建两个 macOS 核心：

- `native/bin/darwin-x64/wecom-cleaner-core`
- `native/bin/darwin-arm64/wecom-cleaner-core`

说明：`native/bin/` 为构建产物目录，不纳入 Git 版本管理。

本地交付包（无作用域前缀）建议：

```bash
npm run pack:tgz
```

输出示例：`wecom-cleaner-<version>.tgz`

### 正式发布（GitHub Release + npm）

```bash
# 推荐：一键发布（以后统一用这个）
npm run release:ship

# 仅预演（不真正发布）
npm run release:ship:dry-run

# 可选：跳过 npm 或 GitHub 发布（例如仅补传附件）
npm run release:ship -- --skip-npm
npm run release:ship -- --skip-github
```

建议发布前确认登录状态：

- `gh auth status`
- `npm whoami`

跨平台构建示例：

```bash
# 按当前机器平台
./native/zig/build.sh

# 发布前构建 macOS 双架构
npm run build:native:release

# 指定目标编译（示例）
TARGET_OS=darwin TARGET_ARCH=arm64 ./native/zig/build.sh
TARGET_OS=windows TARGET_ARCH=x64 ./native/zig/build.sh
```

## FAQ

### 1) “Zig加速:已就绪” 和 “已生效” 有什么区别？

- 已就绪：检测到 Zig 核心，但当前仅在菜单阶段，还没进入扫描。
- 已生效：已经进入扫描，且本次实际使用 Zig。

### 2) 为什么显示 “Node回退”？

检测到 Zig 核心，但本次运行探针失败或运行异常，已自动切回 Node，功能可继续使用。

### 3) 会不会误删企业文档？

默认策略不会把普通业务文档目录（例如 `WeDrive/<企业名>/...`）纳入治理规则；执行前还有分级提示、确认和回收区兜底。

---

如果你希望我提供“按你当前机器目录结构定制的一键安全清理方案”，可以直接给我一份 `--dry-run` 输出。
