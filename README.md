# wecom-cleaner

企业微信本地缓存清理工具（交互式 CLI/TUI 风格）。

- 软件名：`wecom-cleaner`
- npm 包名：`@mison/wecom-cleaner`
- 命令名：`wecom-cleaner`

## 核心能力

1. 开始菜单
- 年月清理（默认，可执行删除）
- 会话分析（只读，不处理）
- 恢复已删除批次
- 交互配置

2. 多账号支持
- 自动识别 `Profiles` 下多个账号。
- 账号列表按 `用户名 | 企业名 | 短ID` 三列显示并可勾选处理范围。
- 支持账号别名管理（用于修正不可读的本地字段）。

3. 年月清理（默认）
- 进入模式即弹出“年月筛选配置”。
- 支持按截止年月自动筛选，或手动勾选月份。
- 支持按缓存类型筛选（图片、视频、文件、表情、缩略图、语音等）。
- 删除时自动移动到程序回收区，并记录索引，便于恢复。

4. 恢复机制
- 按删除批次恢复。
- 冲突处理支持：`覆盖 / 重命名 / 跳过`。
- 可选择“后续冲突沿用同一策略”。
- 若恢复目标超出 `Profiles` 根目录，会触发高危双重确认，并写入审计字段。

5. 会话分析（只读）
- 分析可见缓存目录分布（账号、类型、月份、体积）。
- 不执行删除。

## 能力边界（重要）

企业微信会话数据库为私有/加密格式，工具无法稳定建立“会话名 -> 本地缓存目录”的强映射。
因此：

- 支持按“年月目录”直接清理（可执行）。
- 支持按“会话维度”做只读分析提示，但不自动按会话删除。

## 安装与运行

### 方式一：直接运行（发布后）

```bash
npx @mison/wecom-cleaner
```

### 方式二：本地开发运行

```bash
npm install
# 编译 Zig 核心（可选但推荐）
./native/zig/build.sh
npm run dev
```

发布打包（`npm pack` / `npm publish`）默认会在 `prepack` 阶段同时构建：
- `native/bin/darwin-x64/wecom-cleaner-core`
- `native/bin/darwin-arm64/wecom-cleaner-core`

如果你看到标题栏 `Zig加速:已生效`，表示正在使用 Zig 扫描引擎；
否则会自动回退到 Node 引擎（功能不受影响，只是扫描速度可能较慢）。

状态含义：
- `Zig加速:已生效(本次扫描更快)`：本次扫描实际使用 Zig。
- `Zig加速:本次未生效(已自动改用Node)`：检测到 Zig，但本次运行回退到 Node。
- `Zig加速:已就绪(开始扫描后自动使用)`：已经检测到 Zig，可直接开始使用。
- `Zig加速:未开启(当前使用Node)`：未检测到可用 Zig 核心。

## 常用参数

```bash
wecom-cleaner --root ~/Library/Containers/com.tencent.WeWorkMac/Data/Documents/Profiles
wecom-cleaner --state-root ~/.wecom-cleaner-state
wecom-cleaner --dry-run-default true
wecom-cleaner --mode cleanup_monthly
wecom-cleaner --theme auto
```

可选 `--mode`：
- `cleanup_monthly`
- `analysis_only`
- `restore`
- `settings`

可选 `--theme`：
- `auto`：自动判断（优先读取终端环境，如 `COLORFGBG`）
- `light`：亮色主题色板
- `dark`：暗色主题色板

跨平台编译 Zig 核心示例：

```bash
# 按当前机器平台编译
./native/zig/build.sh

# 发布前一次构建 macOS 双架构（默认由 prepack 自动触发）
npm run build:native:release

# 指定目标平台编译（示例）
TARGET_OS=darwin TARGET_ARCH=arm64 ./native/zig/build.sh
TARGET_OS=windows TARGET_ARCH=x64 ./native/zig/build.sh
```

## 数据与日志位置

默认状态目录：`~/.wecom-cleaner-state`

- `config.json`：配置文件
- `account-aliases.json`：账号别名
- `index.jsonl`：删除/恢复流水索引
- `recycle-bin/`：回收区
