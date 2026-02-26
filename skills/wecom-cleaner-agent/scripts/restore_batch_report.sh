#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
用法：
  restore_batch_report.sh --batch-id <batchId> [--conflict skip|rename|overwrite]
                         [--execute true|false] [--root <path>] [--state-root <path>]
                         [--external-roots <path1,path2>]

说明：
  - 默认只做预演（--execute false）。
  - --execute true 时执行真实恢复（带 --yes）。
EOF
}

if ! command -v jq >/dev/null 2>&1; then
  echo "错误：缺少 jq，请先安装（brew install jq）。" >&2
  exit 2
fi

if ! command -v wecom-cleaner >/dev/null 2>&1; then
  echo "错误：未找到 wecom-cleaner 命令，请先安装 @mison/wecom-cleaner。" >&2
  exit 2
fi

BATCH_ID=""
CONFLICT="rename"
EXECUTE="false"
ROOT=""
STATE_ROOT=""
EXTERNAL_ROOTS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --batch-id | --restore-batch)
      BATCH_ID="${2:-}"
      shift 2
      ;;
    --conflict)
      CONFLICT="${2:-rename}"
      shift 2
      ;;
    --execute)
      EXECUTE="${2:-false}"
      shift 2
      ;;
    --root)
      ROOT="${2:-}"
      shift 2
      ;;
    --state-root)
      STATE_ROOT="${2:-}"
      shift 2
      ;;
    --external-roots)
      EXTERNAL_ROOTS="${2:-}"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "错误：未知参数 $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ -z "$BATCH_ID" ]]; then
  echo "错误：必须提供 --batch-id" >&2
  usage
  exit 2
fi

case "$EXECUTE" in
  true | false) ;;
  *)
    echo "错误：--execute 只能是 true 或 false" >&2
    exit 2
    ;;
esac

case "$CONFLICT" in
  skip | rename | overwrite) ;;
  *)
    echo "错误：--conflict 只能是 skip/rename/overwrite" >&2
    exit 2
    ;;
esac

human_bytes() {
  local bytes="${1:-0}"
  awk -v b="$bytes" '
    BEGIN {
      split("B KB MB GB TB", u, " ");
      i=1;
      while (b>=1024 && i<5) { b=b/1024; i++; }
      if (i==1) printf "%d %s", b, u[i];
      else printf "%.2f %s", b, u[i];
    }
  '
}

short_path() {
  local raw="${1:-}"
  local max_len="${2:-90}"
  if [[ "${#raw}" -le "$max_len" ]]; then
    printf '%s' "$raw"
    return
  fi
  local keep=$((max_len - 3))
  printf '...%s' "${raw: -$keep}"
}

PREVIEW_JSON="$(mktemp -t wecom-restore-preview.XXXX.json)"
EXEC_JSON="$(mktemp -t wecom-restore-exec.XXXX.json)"
PREVIEW_ERR="$(mktemp -t wecom-restore-preview.XXXX.err)"
EXEC_ERR="$(mktemp -t wecom-restore-exec.XXXX.err)"
trap 'rm -f "$PREVIEW_JSON" "$EXEC_JSON" "$PREVIEW_ERR" "$EXEC_ERR"' EXIT

run_cmd_to_file() {
  local dry_run="$1"
  local output_file="$2"
  local err_file="$3"
  local cmd_parts=(
    --restore-batch "$BATCH_ID"
    --conflict "$CONFLICT"
    --output json
    --dry-run "$dry_run"
  )
  if [[ -n "$ROOT" ]]; then
    cmd_parts+=(--root "$ROOT")
  fi
  if [[ -n "$STATE_ROOT" ]]; then
    cmd_parts+=(--state-root "$STATE_ROOT")
  fi
  if [[ -n "$EXTERNAL_ROOTS" ]]; then
    cmd_parts+=(--external-roots "$EXTERNAL_ROOTS")
  fi
  if [[ "$dry_run" == "false" ]]; then
    cmd_parts+=(--yes)
  fi
  if ! wecom-cleaner "${cmd_parts[@]}" >"$output_file" 2>"$err_file"; then
    err_head="$(head -n 3 "$err_file" 2>/dev/null || true)"
    echo "执行失败（dry-run=${dry_run}）：${err_head:-未知错误}" >&2
    return 1
  fi
}

run_cmd_to_file true "$PREVIEW_JSON" "$PREVIEW_ERR"

preview_success="$(jq -r '.summary.successCount // 0' "$PREVIEW_JSON")"
preview_skipped="$(jq -r '.summary.skippedCount // 0' "$PREVIEW_JSON")"
preview_failed="$(jq -r '.summary.failedCount // 0' "$PREVIEW_JSON")"
preview_restored="$(jq -r '.summary.restoredBytes // 0' "$PREVIEW_JSON")"
entry_count="$(jq -r '.summary.entryCount // (.data.report.matched.totalEntries // 0)' "$PREVIEW_JSON")"
matched_bytes="$(jq -r '.summary.matchedBytes // (.data.report.matched.totalBytes // 0)' "$PREVIEW_JSON")"
scope_count="$(jq -r '.summary.scopeCount // (.data.report.matched.byScope // [] | length)' "$PREVIEW_JSON")"
category_count="$(jq -r '.summary.categoryCount // (.data.report.matched.byCategory // [] | length)' "$PREVIEW_JSON")"
root_path_count="$(jq -r '.summary.rootPathCount // (.data.report.matched.byRoot // [] | length)' "$PREVIEW_JSON")"
engine="$(jq -r '.meta.engine // "unknown"' "$PREVIEW_JSON")"
duration_preview="$(jq -r '.meta.durationMs // 0' "$PREVIEW_JSON")"
warnings_preview="$(jq -r '(.warnings // []) | length' "$PREVIEW_JSON")"
errors_preview="$(jq -r '(.errors // []) | length' "$PREVIEW_JSON")"

executed="false"
execute_success=0
execute_skipped=0
execute_failed=0
execute_restored=0
duration_exec=0
warnings_exec=0
errors_exec=0

if [[ "$EXECUTE" == "true" ]]; then
  run_cmd_to_file false "$EXEC_JSON" "$EXEC_ERR"
  executed="true"
  execute_success="$(jq -r '.summary.successCount // 0' "$EXEC_JSON")"
  execute_skipped="$(jq -r '.summary.skippedCount // 0' "$EXEC_JSON")"
  execute_failed="$(jq -r '.summary.failedCount // 0' "$EXEC_JSON")"
  execute_restored="$(jq -r '.summary.restoredBytes // 0' "$EXEC_JSON")"
  duration_exec="$(jq -r '.meta.durationMs // 0' "$EXEC_JSON")"
  warnings_exec="$(jq -r '(.warnings // []) | length' "$EXEC_JSON")"
  errors_exec="$(jq -r '(.errors // []) | length' "$EXEC_JSON")"
fi

duration_total=$((duration_preview + duration_exec))
warnings_total=$((warnings_preview + warnings_exec))
errors_total=$((errors_preview + errors_exec))

printf '\n=== 批次恢复结果（给用户）===\n'
if [[ "$executed" == "true" ]]; then
  printf -- '- 已完成：批次 %s 恢复成功 %s 项，恢复体积 %s。\n' "$BATCH_ID" "$execute_success" "$(human_bytes "$execute_restored")"
else
  printf -- '- 已完成预演：批次 %s 预计可恢复 %s 项（体积 %s）。\n' "$BATCH_ID" "$preview_success" "$(human_bytes "$preview_restored")"
fi
printf -- '- 冲突策略：%s。\n' "$CONFLICT"

printf '\n你关心的范围\n'
printf -- '- 批次号：%s\n' "$BATCH_ID"
printf -- '- 批次条目：%s 项\n' "$entry_count"
printf -- '- 涉及作用域：%s 类\n' "$scope_count"
printf -- '- 涉及类别：%s 类\n' "$category_count"
printf -- '- 涉及目录根：%s 个\n' "$root_path_count"

printf '\n恢复结果总览\n'
printf -- '- 预演成功：%s，跳过：%s，失败：%s，预计恢复：%s\n' \
  "$preview_success" "$preview_skipped" "$preview_failed" "$(human_bytes "$preview_restored")"
if [[ "$executed" == "true" ]]; then
  printf -- '- 实际执行：成功 %s / 跳过 %s / 失败 %s，实际恢复 %s\n' \
    "$execute_success" "$execute_skipped" "$execute_failed" "$(human_bytes "$execute_restored")"
else
  printf -- '- 执行状态：未执行真实恢复（仅预演）。\n'
fi
printf -- '- 批次总量：%s（按批次记录统计）\n' "$(human_bytes "$matched_bytes")"

printf '\n按作用域统计\n'
scope_rows=0
while IFS=$'\t' read -r scope count bytes; do
  [[ -z "${scope:-}" ]] && continue
  printf -- '- %s：%s 项，%s\n' "$scope" "$count" "$(human_bytes "$bytes")"
  scope_rows=$((scope_rows + 1))
done < <(
  jq -r '.data.report.matched.byScope // [] | .[] | [(.scope // "-"), ((.targetCount // 0)|tostring), ((.sizeBytes // 0)|tostring)] | @tsv' \
    "$PREVIEW_JSON"
)
if [[ "$scope_rows" -eq 0 ]]; then
  printf -- '- 无作用域数据。\n'
fi

printf '\n按类别统计\n'
cat_rows=0
while IFS=$'\t' read -r label count bytes; do
  [[ -z "${label:-}" ]] && continue
  printf -- '- %s：%s 项，%s\n' "$label" "$count" "$(human_bytes "$bytes")"
  cat_rows=$((cat_rows + 1))
  if [[ "$cat_rows" -ge 20 ]]; then
    break
  fi
done < <(
  jq -r '.data.report.matched.byCategory // [] | .[] | [(.categoryLabel // .categoryKey // "-"), ((.targetCount // 0)|tostring), ((.sizeBytes // 0)|tostring)] | @tsv' \
    "$PREVIEW_JSON"
)
if [[ "$cat_rows" -eq 0 ]]; then
  printf -- '- 无类别数据。\n'
fi

printf '\n按月份统计\n'
month_rows=0
while IFS=$'\t' read -r month count bytes; do
  [[ -z "${month:-}" ]] && continue
  printf -- '- %s：%s 项，%s\n' "$month" "$count" "$(human_bytes "$bytes")"
  month_rows=$((month_rows + 1))
  if [[ "$month_rows" -ge 24 ]]; then
    break
  fi
done < <(
  jq -r '.data.report.matched.byMonth // [] | .[] | [(.monthKey // "非月份目录"), ((.targetCount // 0)|tostring), ((.sizeBytes // 0)|tostring)] | @tsv' \
    "$PREVIEW_JSON"
)
if [[ "$month_rows" -eq 0 ]]; then
  printf -- '- 无月份数据。\n'
fi

printf '\n路径范围（按体积Top 8根目录）\n'
root_rows=0
while IFS=$'\t' read -r root count bytes; do
  [[ -z "${root:-}" ]] && continue
  printf -- '- %s：%s 项，%s\n' "$(short_path "$root" 86)" "$count" "$(human_bytes "$bytes")"
  root_rows=$((root_rows + 1))
  if [[ "$root_rows" -ge 8 ]]; then
    break
  fi
done < <(
  jq -r '.data.report.matched.byRoot // [] | .[] | [(.rootPath // "-"), ((.targetCount // 0)|tostring), ((.sizeBytes // 0)|tostring)] | @tsv' \
    "$PREVIEW_JSON"
)
if [[ "$root_rows" -eq 0 ]]; then
  printf -- '- 无路径数据。\n'
fi

printf '\n路径样例（按体积Top 10）\n'
top_rows=0
while IFS=$'\t' read -r source recycle label month bytes; do
  [[ -z "${source:-}" ]] && continue
  printf -- '- %s | %s | %s | 原路径:%s | 回收路径:%s\n' \
    "$label" "${month:-非月份目录}" "$(human_bytes "$bytes")" "$(short_path "$source" 56)" "$(short_path "$recycle" 56)"
  top_rows=$((top_rows + 1))
  if [[ "$top_rows" -ge 10 ]]; then
    break
  fi
done < <(
  jq -r '.data.report.matched.topEntries // [] | .[] | [(.sourcePath // "-"), (.recyclePath // "-"), (.categoryLabel // .categoryKey // "-"), (.monthKey // "非月份目录"), ((.sizeBytes // 0)|tostring)] | @tsv' \
    "$PREVIEW_JSON"
)
if [[ "$top_rows" -eq 0 ]]; then
  printf -- '- 无路径样例。\n'
fi

if [[ "$executed" == "true" ]]; then
  printf '\n实际执行明细（按类别）\n'
  exec_rows=0
  while IFS=$'\t' read -r label s k f sbytes; do
    [[ -z "${label:-}" ]] && continue
    printf -- '- %s：成功 %s / 跳过 %s / 失败 %s，恢复 %s\n' "$label" "$s" "$k" "$f" "$(human_bytes "$sbytes")"
    exec_rows=$((exec_rows + 1))
    if [[ "$exec_rows" -ge 20 ]]; then
      break
    fi
  done < <(
    jq -r '.data.report.executed.byCategory // [] | .[] | [(.categoryLabel // .categoryKey // "-"), ((.successCount // 0)|tostring), ((.skippedCount // 0)|tostring), ((.failedCount // 0)|tostring), ((.successBytes // 0)|tostring)] | @tsv' \
      "$EXEC_JSON"
  )
  if [[ "$exec_rows" -eq 0 ]]; then
    printf -- '- 当前未返回执行落地明细。\n'
  fi

  printf '\n实际执行明细（按月份）\n'
  exec_month_rows=0
  while IFS=$'\t' read -r month s k f sbytes; do
    [[ -z "${month:-}" ]] && continue
    printf -- '- %s：成功 %s / 跳过 %s / 失败 %s，恢复 %s\n' "$month" "$s" "$k" "$f" "$(human_bytes "$sbytes")"
    exec_month_rows=$((exec_month_rows + 1))
    if [[ "$exec_month_rows" -ge 24 ]]; then
      break
    fi
  done < <(
    jq -r '.data.report.executed.byMonth // [] | .[] | [(.monthKey // "非月份目录"), ((.successCount // 0)|tostring), ((.skippedCount // 0)|tostring), ((.failedCount // 0)|tostring), ((.successBytes // 0)|tostring)] | @tsv' \
      "$EXEC_JSON"
  )
  if [[ "$exec_month_rows" -eq 0 ]]; then
    printf -- '- 当前未返回按月份执行明细。\n'
  fi
fi

printf '\n运行状态\n'
printf -- '- 扫描引擎：%s\n' "$engine"
printf -- '- 总耗时：%s ms\n' "$duration_total"
printf -- '- 告警：%s\n' "$warnings_total"
printf -- '- 错误：%s\n' "$errors_total"

printf '\n指标释义\n'
printf -- '- 批次条目：该批次里可恢复记录的总数。\n'
printf -- '- 预计恢复：预演阶段判断可恢复的体积。\n'
printf -- '- 冲突策略：目标路径已存在时的处理方式（跳过/重命名/覆盖）。\n'
printf -- '- 实际恢复：仅真实执行时生效，表示已成功回放到原目录的数据量。\n'
