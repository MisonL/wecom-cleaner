# wecom-cleaner 命令参考（Agent）

## 1. 路径变量

建议先在执行环境准备变量：

```bash
ROOT="/Users/<name>/Library/Containers/com.tencent.WeWorkMac/Data/Documents/Profiles"
STATE="$HOME/.wecom-cleaner-state"
```

如需显式指定外部文件存储目录：

```bash
EXT="/Volumes/Data/WXWork_Data"
```

## 2. 只读动作

系统体检：

```bash
wecom-cleaner --doctor --output json --root "$ROOT" --state-root "$STATE"
```

缓存盘点（按账号/类型）：

```bash
wecom-cleaner --analysis-only \
  --accounts current \
  --categories files,images,videos \
  --output json \
  --root "$ROOT" --state-root "$STATE"
```

## 3. 年月清理（先 dry-run）

```bash
wecom-cleaner --cleanup-monthly \
  --accounts all \
  --cutoff-month 2024-02 \
  --categories files,images \
  --include-non-month-dirs false \
  --output json \
  --root "$ROOT" --state-root "$STATE"
```

真实执行（仅用户明确授权后）：

```bash
wecom-cleaner --cleanup-monthly \
  --accounts all \
  --months 2023-01,2023-02 \
  --categories files \
  --dry-run false \
  --yes \
  --output json \
  --root "$ROOT" --state-root "$STATE"
```

## 4. 全量空间治理（先 dry-run）

```bash
wecom-cleaner --space-governance \
  --suggested-only true \
  --tiers safe,caution \
  --allow-recent-active false \
  --output json \
  --root "$ROOT" --state-root "$STATE"
```

真实执行：

```bash
wecom-cleaner --space-governance \
  --targets <target1,target2> \
  --dry-run false \
  --yes \
  --output json \
  --root "$ROOT" --state-root "$STATE"
```

## 5. 批次恢复

先查可恢复批次（通过审计或先执行 `--doctor`/`--analysis-only` 获取上下文），再恢复：

```bash
wecom-cleaner --restore-batch <batchId> \
  --conflict rename \
  --output json \
  --root "$ROOT" --state-root "$STATE"
```

真实恢复：

```bash
wecom-cleaner --restore-batch <batchId> \
  --conflict overwrite \
  --dry-run false \
  --yes \
  --output json \
  --root "$ROOT" --state-root "$STATE"
```

## 6. 回收区治理

```bash
wecom-cleaner --recycle-maintain \
  --retention-enabled true \
  --retention-max-age-days 30 \
  --retention-min-keep-batches 20 \
  --retention-size-threshold-gb 20 \
  --output json \
  --root "$ROOT" --state-root "$STATE"
```

真实治理：

```bash
wecom-cleaner --recycle-maintain \
  --retention-enabled true \
  --dry-run false \
  --yes \
  --output json \
  --root "$ROOT" --state-root "$STATE"
```

## 7. 输出解析要点

- 成功判定：`ok == true`
- 失败详情：`errors[]`
- 核心统计：`summary`（如 `successCount/skippedCount/failedCount/reclaimedBytes`）
- 执行引擎：`meta.engine`

## 8. 常见失败与处理

- 退出码 `2`：动作参数冲突或缺失，检查是否只给了一个动作参数。
- 退出码 `3`：缺少真实执行确认，补 `--yes` 或回退到 dry-run。
- `errors.code=path_validation_failed`：路径越界/白名单不匹配，核对 `--root` 与目录范围。
- `errors.code=permission_denied`：权限不足，调整目录权限后重试。
