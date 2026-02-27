# Repository Guidelines

## Project Structure & Module Organization

- `src/`：核心实现（CLI/TUI、扫描、清理、恢复、更新、配置）。
- `test/`：Node 原生测试（`*.test.js`），含无交互契约、回归与脚本测试。
- `native/`：Zig 核心与产物（`native/zig/src`、`native/bin/darwin-*`）。
- `skills/wecom-cleaner-agent/`：Agent 技能脚本与命令参考。
- `scripts/`：打包、发布门禁、e2e smoke 等工程脚本。
- `docs/`：规范与发布文档（如 `NON_INTERACTIVE_SPEC.md`、`releases/`）。

## Build, Test, and Development Commands

- `npm run dev`：本地启动交互模式。
- `npm run check`：语法检查（`node --check src/*.js`）。
- `npm test`：运行全部单元/集成测试。
- `npm run test:coverage:check`：覆盖率门禁（lines 75 / functions 80 / branches 60 / statements 75）。
- `npm run build:native:release`：构建 macOS x64 + arm64 Zig 核心。
- `npm run release:gate`：发布前全套检查（format/check/test/e2e/pack dry-run）。

## Coding Style & Naming Conventions

- 使用 Node.js ESM（`type: module`），保持 2 空格缩进、单引号、分号。
- 统一用 Prettier：`npm run format` / `npm run format:check`。
- 文件名使用 kebab-case（如 `native-bridge.js`）；函数/变量使用 camelCase；常量使用 UPPER_SNAKE_CASE。
- 输出文案优先中文、可读、面向用户任务目标（避免仅内部术语）。

## Testing Guidelines

- 测试框架：`node --test`（不依赖 Jest）。
- 新功能必须补测试，至少覆盖：
  - 正常路径（成功输出）
  - 失败路径（错误码与错误信息）
  - 安全路径（dry-run、`--yes`、越界保护）
- 测试文件命名：`test/<module>.test.js`，与模块职责对应。

## Commit & Pull Request Guidelines

- 建议使用 Conventional Commits：`feat(scope): ...`、`fix(scope): ...`、`test(scope): ...`、`chore(scope): ...`。
- PR 必须包含：
  - 变更摘要与动机
  - 影响范围（交互/无交互、是否破坏性）
  - 验证命令与结果（至少 `npm test`、`npm run format:check`）
  - 涉及 TUI 文案或布局时附截图

## Security & Safety Notes

- 破坏性动作默认 dry-run；真实执行必须显式确认（如 `--yes`）。
- 严禁绕过白名单路径校验、回收区与索引审计机制。
- 涉及外部存储目录时，优先提示扫描边界（是否纳入“文件存储位置”路径）。
