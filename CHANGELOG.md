# Changelog

本项目版本变更记录。

格式参考 Keep a Changelog，版本遵循语义化版本（SemVer）。

## [Unreleased]

### Added

- 新增极端场景测试矩阵文档：`docs/TEST_MATRIX.md`。
- 新增无交互契约测试：锁定关键动作的公共 JSON 字段与类型稳定性。
- 新增 text/json 一致性测试：无目标场景下结论语义保持一致。
- 新增符号链接逃逸防护测试：
  - `executeCleanup` 的 `source_symlink_escape`
  - `restoreBatch` 的 `source_symlink_escape`

### Changed

- `README.md` 增加“测试矩阵”入口，明确新增动作与字段的补测要求。
- `scripts/e2e-smoke.sh` 增强失败定位信息：输出上下文、落盘关键命令日志。

### Fixed

- 修复 E2E 在 `doctor_json` / `recycle_maintain` 失败时日志不充分的问题，降低排障成本。

## [1.2.0] - 2026-02-26

### Added

- 新增无交互文本任务卡片输出：按动作展示结论、处理范围、统计、分类分布与风险提示。
- 新增 `scripts/pack-release-assets.js`，可生成 GitHub Release 双架构核心附件与 `SHA256SUMS`。
- 新增 npm 脚本：
  - `npm run pack:release-assets`
  - `npm run pack:release-assets:dry-run`
- 新增 `wecom-cleaner-agent` 报告脚本：
  - `cleanup_monthly_report.sh`
  - `analysis_report.sh`
  - `space_governance_report.sh`
  - `restore_batch_report.sh`
  - `recycle_maintain_report.sh`
  - `doctor_report.sh`

### Changed

- 无交互 `cleanup-monthly` / `space-governance` 默认外部目录来源调整为 `all`（减少漏扫）。
- 交互模式外部目录选择默认预选自动探测目录，可手动取消。
- Agent 技能规范升级为“脚本优先 + 用户任务卡片优先”，减少技术键值直出。
- 发布流程调整为：GitHub Release 上传独立附件（`darwin-x64`、`darwin-arm64`）+ npm tgz。
- `native/bin/` 改为构建产物目录，不再纳入 Git 版本管理。

### Fixed

- 修复 Zig 核心目录体积统计错误（目录不再按 inode 大小误判）。
- 增强清理/恢复/回收区治理的执行分布统计（按状态/类别/月份/路径可追踪）。

### Security

- 清理 Git 历史中的二进制构建产物，降低仓库污染与历史包袱风险。

## [1.1.0] - 2026-02-26

### Added

- 新增内置 Agent 技能包：`skills/wecom-cleaner-agent`（含 `SKILL.md`、命令参考与 `agents/openai.yaml`）。
- 新增技能安装命令：`wecom-cleaner-skill install`（支持 `--target`、`--force`、`--dry-run`）。
- 新增 GitHub 一键安装脚本：`scripts/install-skill.sh`。
- 新增 `skill-cli` 单元测试，覆盖 `help/path/install/force/dry-run` 与异常参数分支。

### Changed

- 无交互动作协议正式化：`--cleanup-monthly`、`--analysis-only`、`--space-governance`、`--restore-batch`、`--recycle-maintain`、`--doctor`。
- 新增 AI Agent 无交互规范文档：`docs/NON_INTERACTIVE_SPEC.md`。
- `wecom-cleaner` 启动行为统一为：不带参数进入交互模式，带参数进入无交互模式。
- 无交互默认输出调整为 JSON，支持 `--output json|text`，并保留 `--json` 兼容别名。
- 兼容参数 `--mode` 仍可用，但输出迁移提示，建议改用动作参数。
- Zig 核心自动修复下载地址跟随 `native/manifest.json` 版本标签。
- 锁机制支持自动回收陈旧锁，保留 `--force` 作为兜底。
- 版本号统一升级为 `1.1.0`（`package.json`、`package-lock.json`、`native/manifest.json`、Zig `--ping`）。

### Fixed

- 回收区治理在 `dry-run` 下不再创建缺失回收目录，保持纯只读。
- 恢复流程在 `dry-run + overwrite` 场景不再触发实际删除。
- 回收区治理对异常批次路径增加边界校验，避免越界删除风险。
- `scripts/install-skill.sh` 兼容 `--target` 指向不存在父目录的场景。

### Security

- 清理/恢复/回收区治理链路补齐路径白名单与 `realpath` 边界防护，并写入审计字段。

## [1.0.0] - 2026-02-26

### Added

- 首个正式版本发布（GitHub Release + npm）。
- 新增 `docs/releases/v1.0.0.md` 发布说明。
- 新增 `doctor` 只读体检说明与 `WECOM_CLEANER_NATIVE_PROBE_TIMEOUT_MS` 文档。
- 补充 `native-bridge` 自动修复链路测试覆盖（下载修复、缓存命中、提示合并等场景）。

### Changed

- 版本号统一为 `1.0.0`（`package.json`、`package-lock.json`、`native/manifest.json`、Zig `--ping` 版本信息）。
- 更新 `native/manifest.json` 的 `baseUrl` 到 `v1.0.0`，并同步双架构核心 SHA256。
- 回收区治理由 `recyclePath` 反推批次根并做边界校验，避免异常索引越界删除风险。
- `doctor` 模式调整为只读（不创建状态目录/回收区，不触发自动修复下载）。
- `native` 探针增加超时控制，提升异常场景可恢复性。
- `scripts/e2e-smoke.sh` 增加安全删除保护，避免误删非安全范围目录。

### Fixed

- 修复恢复流程在 `dry-run + overwrite` 场景下的潜在实删问题。
- 修复 `inferDataRootFromProfilesRoot` 对 `Documents/Profiles` 路径大小写敏感的问题。

### Security

- 增强回收区治理与恢复路径的边界保护与审计可观测性。
