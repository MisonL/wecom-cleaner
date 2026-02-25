# wecom-cleaner

企业微信本地缓存清理工具（交互式 CLI/TUI 风格）。

- 软件名：`wecom-cleaner`
- npm 包名：`@mison/wecom-cleaner`
- 命令名：`wecom-cleaner`

## 核心能力

1. 开始菜单
- 年月清理（默认，可执行删除）
- 会话分析（只读，不处理）
- 全量空间治理（分级，安全优先）
- 恢复已删除批次
- 交互配置

2. 多账号支持
- 自动识别 `Profiles` 下多个账号。
- 账号列表按 `用户名 | 企业名 | 短ID` 三列显示并可勾选处理范围。
- 支持账号别名管理（用于修正不可读的本地字段）。
- 当 `Profile` 根目录不存在或未识别到账号时，启动页会给出候选目录提示（不自动改配置）。

3. 年月清理（默认）
- 进入模式即弹出“年月筛选配置”。
- 支持按截止年月自动筛选，或手动勾选月份。
- 支持按缓存类型筛选（图片、视频、文件、表情、缩略图、语音、`wwsecurity` 等）。
- `wwsecurity` 默认不勾选（需手动勾选后才会进入清理范围）。
- 自动识别文件存储目录（含默认路径与自定义路径，按结构匹配 `*/WXWork Files/Caches`，不依赖目录名称），并在执行前让用户确认是否纳入本次扫描。
- 文件存储目录选择默认策略：仅预选“默认路径 + 手动配置路径”，自动探测路径默认不预选（降低误选风险）。
- 删除时自动移动到程序回收区，并记录索引，便于恢复。

4. 全量空间治理（新增）
- 独立模式，覆盖 `Profiles` 外及账号内的高占用缓存/临时目录（如 `WXWork/Temp/ScreenCapture`、`cefcache`、`WebsiteDataStore`、`tmp`、`Publishsys/pkg`、`WXWork/Log` 等）。
- 若检测到文件存储目录，会额外纳入 `WXWork Files/Caches` 作为谨慎层治理项。
- 三层分级：
  - 安全层：可建议清理
  - 谨慎层：可选清理，执行前额外确认
  - 受保护层：只分析，不允许删除
- 支持通配目录匹配（如 `WeDrive/.WeDriveTrash-*`），用于识别同类临时目录。
- 自动建议规则：`体积阈值 + 静置天数`（默认 `>=512MB` 且 `>=7天`）。
- 删除保护：双确认 + 冷静期 + 确认词 `CLEAN`。
- 所有处理仍走回收区，可按批次恢复。
- 若 `--root` 不是标准 `.../Data/Documents/Profiles` 结构，程序会禁用容器级目录推导，仅扫描账号目录相关目标。
- 默认不把普通业务文档目录（例如 `WeDrive/<企业名>/...`）纳入治理规则，避免误删工作资料。

5. 恢复机制
- 按删除批次恢复。
- 冲突处理支持：`覆盖 / 重命名 / 跳过`。
- 可选择“后续冲突沿用同一策略”。
- 恢复路径强约束：
  - 月度清理批次：`sourcePath` 必须位于 `Profiles` 根目录或已登记文件存储根目录内
  - 全量治理批次：优先使用容器 `Data` 根目录校验；若无法推断，会自动回退到 `Profiles` 根目录 + 文件存储根目录白名单
  - 通用：`recyclePath` 必须位于回收区目录内
  - 校验基于 `realpath`（防止符号链接越界恢复）
  - 越界记录直接拦截并审计（`skipped_invalid_path`）。

6. 会话分析（只读）
- 分析可见缓存目录分布（账号、类型、月份、体积）。
- 默认包含 `wwsecurity` 目录体积分析（只读，不自动删除）。
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

### 开发回归（全菜单 smoke）

```bash
npm run e2e:smoke
```

说明：
- 该脚本会在 `/tmp/wecom-e2e-*` 下构造隔离测试夹具，不会触碰真实企业微信目录。
- 覆盖菜单与关键交互：年月清理、会话分析、全量治理、恢复、设置，以及恢复冲突分支验证。
- 依赖 `expect`（macOS 通常自带）；可用 `npm run e2e:smoke -- --keep` 保留测试目录与日志。

发布前手动门禁（推荐）：

```bash
npm run check
npm run e2e:smoke -- --keep
npm run pack:tgz:dry-run
```

发布打包（`npm pack` / `npm publish`）默认会在 `prepack` 阶段同时构建：
- `native/bin/darwin-x64/wecom-cleaner-core`
- `native/bin/darwin-arm64/wecom-cleaner-core`

如果你要生成本地交付包（避免作用域前缀），建议使用：

```bash
npm run pack:tgz
```

该命令会生成：`wecom-cleaner-<version>.tgz`（不会带 `mison-` 前缀）。

如果你看到标题栏 `Zig加速:已生效`，表示正在使用 Zig 扫描引擎；
否则会自动回退到 Node 引擎（功能不受影响，只是扫描速度可能较慢）。

当 Zig 核心缺失或损坏时，程序会自动尝试下载修复到状态目录：
`~/.wecom-cleaner-state/native-cache/<platform-arch>/`

自动修复安全策略：
- 下载目标由 `native/manifest.json` 提供（固定版本清单，避免漂移到 `main`）。
- 下载完成后必须通过 `SHA256` 校验。
- 通过校验后仍需通过 `--ping` 探针，才会启用该核心。
- 本地缓存核心命中时也会先做校验，再进入扫描。

状态含义：
- `Zig加速:已生效(本次扫描更快)`：本次扫描实际使用 Zig。
- `Zig加速:本次未生效(已自动改用Node)`：检测到 Zig，但本次运行回退到 Node。
- `Zig加速:已就绪(开始扫描后自动使用)`：已经检测到 Zig，可直接开始使用。
- `Zig加速:未开启(当前使用Node)`：未检测到可用 Zig 核心。

## 常用参数

```bash
wecom-cleaner --root ~/Library/Containers/com.tencent.WeWorkMac/Data/Documents/Profiles
wecom-cleaner --state-root ~/.wecom-cleaner-state
wecom-cleaner --external-storage-root /Volumes/Data/MyWeComStorage
wecom-cleaner --external-storage-auto-detect false
wecom-cleaner --dry-run-default true
wecom-cleaner --mode cleanup_monthly
wecom-cleaner --mode space_governance
wecom-cleaner --theme auto
```

可选 `--mode`：
- `cleanup_monthly`
- `analysis_only`
- `space_governance`
- `restore`
- `settings`

参数错误会直接报错并返回非 0 状态码，例如：

```bash
wecom-cleaner --root --mode analysis_only
# 参数错误: 参数 --root 缺少值

wecom-cleaner --mode foo
# 运行失败: 不支持的运行模式: foo
```

可选 `--theme`：
- `auto`：自动判断（优先读取终端环境，如 `COLORFGBG`）
- `light`：亮色主题色板
- `dark`：暗色主题色板

可选 `--external-storage-root`：
- 手动追加文件存储根目录（示例：`/Volumes/Data/MyWeComStorage`）。
- 支持多路径，使用逗号分隔（示例：`--external-storage-root /Volumes/A/WXWork_Data,/Volumes/B/WXWork_Data`）。

可选 `--external-storage-auto-detect`：
- `true`（默认）：自动探测默认/自定义文件存储目录。
- `false`：关闭自动探测，仅使用默认路径与手动配置路径（更适合受控测试环境）。

可选环境变量：
- `WECOM_CLEANER_NATIVE_AUTO_REPAIR=true|false`：是否开启 Zig 自动修复下载（默认 `true`）
- `WECOM_CLEANER_NATIVE_BASE_URL=<url>`：自定义核心下载基地址
- `WECOM_CLEANER_NATIVE_DOWNLOAD_TIMEOUT_MS=<ms>`：下载超时时间（默认 `15000`）
- `WECOM_CLEANER_EXTERNAL_AUTO_DETECT=true|false`：外部存储自动探测总开关（未传 `--external-storage-auto-detect` 时生效，默认 `true`）

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
- `config.externalStorageRoots`：手动登记的文件存储根目录（默认路径与自动探测仍会生效）
- `config.externalStorageAutoDetect`：是否启用外部存储自动探测（可在“交互配置”里开关）
- `account-aliases.json`：账号别名
- `index.jsonl`：删除/恢复流水索引
- `recycle-bin/`：回收区

常见 `index.jsonl` 字段：
- `scope`：`cleanup_monthly` 或 `space_governance`
- `tier`：`safe` / `caution` / `protected`（全量治理模式）

常见 `index.jsonl` 状态值：
- 清理：`success`、`dry_run`、`skipped_missing_source`、`skipped_recently_active`、`skipped_policy_protected`、`failed`
- 恢复：`success`、`skipped_missing_recycle`、`skipped_conflict`、`skipped_invalid_path`、`failed`

常见 `skipped_invalid_path.invalid_reason`：
- `source_outside_profile_root` / `source_outside_governance_root`
- `source_symlink_escape` / `recycle_symlink_escape`
- `missing_allowed_root` / `missing_recycle_root`
- `source_path_unresolvable` / `recycle_path_unresolvable`
