# Zig Core 占位说明

当前版本采用 `Node CLI + Zig核心预留` 架构：

- 如果存在 `native/bin/<platform>-<arch>/wecom-cleaner-core`，CLI 会尝试加载 Zig 核心。
- 如果未检测到 Zig 二进制，会自动回退到 Node 引擎，不影响使用。

后续可将高并发目录扫描、体积计算、索引操作迁移到 Zig，以提升性能和可维护性。
