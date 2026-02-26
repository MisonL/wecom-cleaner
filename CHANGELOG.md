# Changelog

本项目版本变更记录。

格式参考 Keep a Changelog，版本遵循语义化版本（SemVer）。

## [Unreleased]

### Changed

- 规范 `package.json` 的 `bin` 路径写法（`src/cli.js`），避免 `npm publish` 时出现自动清洗提示。

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

