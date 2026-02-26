# Changelog

本项目版本变更记录。

格式参考 Keep a Changelog，版本遵循语义化版本（SemVer）。

## [Unreleased]

### Added

- 新增无交互动作参数协议：`--cleanup-monthly`、`--analysis-only`、`--space-governance`、`--restore-batch`、`--recycle-maintain`、`--doctor`。
- 新增 AI Agent 无交互规范文档：`docs/NON_INTERACTIVE_SPEC.md`。
- 新增无交互 CLI 集成测试：覆盖默认 JSON 输出、缺少动作报错、`--yes` 真实执行门槛与 doctor 输出。
- 新增 `--interactive` 强制交互开关：允许携带参数时进入交互模式，并支持配合 `--mode` 直达功能菜单。

### Changed

- 规范 `package.json` 的 `bin` 路径写法（`src/cli.js`），避免 `npm publish` 时出现自动清洗提示。
- `wecom-cleaner` 启动行为调整为：不带参数进入交互模式，带参数进入无交互模式。
- 无交互默认输出改为 JSON，支持 `--output json|text`；`--json` 作为兼容别名保留。
- `doctor` 回收区建议命令从旧 `--mode recycle_maintain` 更新为 `--recycle-maintain`。
- 外部文件存储自动探测由“仅结构命中”升级为“结构 + 缓存特征”联合判定，并收窄默认扫描基底，降低误判。
- Zig 核心默认下载地址改为跟随 `native/manifest.json` 的版本标签，避免固定版本地址导致的升级漂移。
- 锁机制支持自动回收陈旧锁（保留 `--force` 作为异常场景兜底）。
- 交互 smoke 脚本切换到 `--interactive` 调用方式，兼容“带参数默认无交互”的新契约。

### Fixed

- 回收区治理在 `dry-run` 下不再创建缺失回收目录，保持纯只读。
- 恢复审计补齐账号/分类/月份/分级等上下文字段，便于回放与追踪。

### Security

- 清理执行新增目标路径白名单边界校验（含 `realpath` 防符号链接逃逸），拦截越界目标并写审计。

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
