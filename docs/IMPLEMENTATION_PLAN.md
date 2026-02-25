# wecom-cleaner 实施与现状说明

## 1. 产品定位

`wecom-cleaner` 是企业微信本地缓存治理工具，核心目标是“可安全回收空间、可审计、可恢复”。

- 软件名：`wecom-cleaner`
- npm 包名：`@mison/wecom-cleaner`
- 命令名：`wecom-cleaner`

## 2. 当前功能范围

1. 开始菜单

- 年月清理（默认，可执行删除）
- 会话分析（只读）
- 全量空间治理（分级治理）
- 恢复已删除批次
- 交互配置

2. 年月清理

- 多账号选择与别名管理。
- 按截止年月或手动勾选月份筛选。
- 按缓存类型筛选，`wwsecurity` 默认不勾选。
- 删除动作统一进入回收区，不直接 `rm`。

3. 会话分析（只读）

- 统计账号/类型/月份维度占用。
- 明确能力边界：不支持按“会话名”自动删除。

4. 全量空间治理

- 对 `Profiles` 外高占用目录进行分层治理（安全层/谨慎层/受保护层）。
- 谨慎层二次确认，受保护层仅分析不删除。
- 支持外部文件存储缓存目录（`WXWork Files/Caches`）纳入治理。

5. 恢复

- 支持按批次恢复。
- 冲突策略：覆盖 / 重命名 / 跳过。
- 恢复路径使用 `realpath` 做越界校验并写审计记录。

## 3. 技术架构

1. CLI 主体

- `src/cli.js`：交互流程编排。
- `src/config.js`：CLI 参数与配置持久化。

2. 领域模块

- `src/scanner.js`：账号发现、目录扫描、体积计算。
- `src/cleanup.js`：删除（迁移到回收区）与索引记录。
- `src/restore.js`：批次恢复与冲突处理。
- `src/analysis.js`：只读分析输出。

3. 引擎层

- `src/native-bridge.js`：Zig 核心探测、校验、自动修复下载、Node 回退。
- `native/manifest.json`：核心下载清单与 `SHA256`。

## 4. 安全与审计策略

1. 删除安全

- 所有删除先进入 `recycle-bin/`。
- 每条动作写入 `index.jsonl`。

2. 恢复安全

- 严格限制恢复源与目标必须位于允许根路径。
- 对软链接逃逸与路径不可解析场景做拒绝与审计。

3. Zig 自动修复安全

- 仅按清单下载固定目标。
- 下载后先做 `SHA256` 校验，再做 `--ping` 探针。
- 校验失败或探针失败会删除缓存并回退 Node。

## 5. 质量保障与门禁

1. 代码风格

- 统一使用 Prettier（仓库内置 `.prettierrc.json`）。
- 执行命令：`npm run format` / `npm run format:check`。

2. 单元测试

- 使用 Node 原生测试框架（`node:test`）。
- 覆盖核心模块：`config/utils/cleanup/restore/scanner/native-bridge/analysis`。

3. 覆盖率

- 使用 `c8` 输出覆盖率报告。
- 门禁阈值：`lines/statements >= 75%`，`functions >= 80%`，`branches >= 60%`。
- 命令：`npm run test:coverage` / `npm run test:coverage:check`。

4. 端到端回归

- 使用 `scripts/e2e-smoke.sh` 覆盖全部一级菜单与关键分支。

## 6. 推荐发布前检查

```bash
npm run check
npm run test:coverage:check
npm run format:check
npm run e2e:smoke -- --keep
npm run pack:tgz:dry-run
```
