#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
用法：
  cleanup_monthly_report.sh --cutoff-month YYYY-MM [--accounts all] [--execute true|false]
                           [--root <path>] [--state-root <path>] [--categories <csv>]
                           [--include-non-month-dirs true|false]
                           [--external-roots-source preset|configured|auto|all]

说明：
  - 默认只做预演（--execute false）。
  - 当预演命中目标为 0 时，会自动跳过真实执行与复核。
  - 输出为“交互式任务卡片 + 指标释义”，不回显原始 JSON。
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

CUTOFF_MONTH=""
ACCOUNTS="all"
EXECUTE="false"
ROOT=""
STATE_ROOT=""
CATEGORIES=""
INCLUDE_NON_MONTH_DIRS=""
EXTERNAL_ROOTS_SOURCE="all"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cutoff-month)
      CUTOFF_MONTH="${2:-}"
      shift 2
      ;;
    --accounts)
      ACCOUNTS="${2:-all}"
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
    --categories)
      CATEGORIES="${2:-}"
      shift 2
      ;;
    --include-non-month-dirs)
      INCLUDE_NON_MONTH_DIRS="${2:-}"
      shift 2
      ;;
    --external-roots-source)
      EXTERNAL_ROOTS_SOURCE="${2:-all}"
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

if [[ -z "$CUTOFF_MONTH" ]]; then
  echo "错误：必须提供 --cutoff-month YYYY-MM" >&2
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

account_scope_label="$ACCOUNTS"
if [[ "$ACCOUNTS" == "all" ]]; then
  account_scope_label="全部账号"
elif [[ "$ACCOUNTS" == "current" ]]; then
  account_scope_label="当前账号"
fi

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
  if [[ "$keep" -le 0 ]]; then
    printf '%s' "$raw"
    return
  fi
  printf '...%s' "${raw: -$keep}"
}

category_label_from_key() {
  local key="${1:-}"
  case "$key" in
    images) printf '%s' '聊天图片' ;;
    videos) printf '%s' '聊天视频' ;;
    files) printf '%s' '聊天文件' ;;
    emotions) printf '%s' '表情资源' ;;
    emotion_thumbnails) printf '%s' '表情缩略图' ;;
    video_thumbnails) printf '%s' '视频缩略图' ;;
    link_thumbnails) printf '%s' '链接缩略图' ;;
    voices) printf '%s' '语音消息' ;;
    wwsecurity) printf '%s' '受保护截图缓存' ;;
    *) printf '%s' "$key" ;;
  esac
}

PREVIEW_JSON="$(mktemp -t wecom-cleaner-preview.XXXX.json)"
EXEC_JSON="$(mktemp -t wecom-cleaner-exec.XXXX.json)"
VERIFY_JSON="$(mktemp -t wecom-cleaner-verify.XXXX.json)"
PREVIEW_ERR="$(mktemp -t wecom-cleaner-preview.XXXX.err)"
EXEC_ERR="$(mktemp -t wecom-cleaner-exec.XXXX.err)"
VERIFY_ERR="$(mktemp -t wecom-cleaner-verify.XXXX.err)"

cleanup_tmp() {
  rm -f "$PREVIEW_JSON" "$EXEC_JSON" "$VERIFY_JSON" "$PREVIEW_ERR" "$EXEC_ERR" "$VERIFY_ERR"
}
trap cleanup_tmp EXIT

run_cmd_to_file() {
  local dry_run="$1"
  local output_file="$2"
  local err_file="$3"
  local cmd_parts=(
    --cleanup-monthly
    --cutoff-month "$CUTOFF_MONTH"
    --accounts "$ACCOUNTS"
    --output json
    --dry-run "$dry_run"
  )
  if [[ -n "$ROOT" ]]; then
    cmd_parts+=(--root "$ROOT")
  fi
  if [[ -n "$STATE_ROOT" ]]; then
    cmd_parts+=(--state-root "$STATE_ROOT")
  fi
  if [[ -n "$CATEGORIES" ]]; then
    cmd_parts+=(--categories "$CATEGORIES")
  fi
  if [[ -n "$INCLUDE_NON_MONTH_DIRS" ]]; then
    cmd_parts+=(--include-non-month-dirs "$INCLUDE_NON_MONTH_DIRS")
  fi
  if [[ -n "$EXTERNAL_ROOTS_SOURCE" ]]; then
    cmd_parts+=(--external-roots-source "$EXTERNAL_ROOTS_SOURCE")
  fi
  if [[ "$dry_run" == "false" ]]; then
    cmd_parts+=(--yes)
  fi
  if ! wecom-cleaner "${cmd_parts[@]}" >"$output_file" 2>"$err_file"; then
    local err_head
    err_head="$(head -n 3 "$err_file" 2>/dev/null || true)"
    echo "执行失败（dry-run=$dry_run）：${err_head:-未知错误}" >&2
    return 1
  fi
}

run_cmd_to_file true "$PREVIEW_JSON" "$PREVIEW_ERR"

preview_matched="$(jq -r '.summary.matchedTargets // 0' "$PREVIEW_JSON")"
preview_matched_bytes="$(jq -r '.summary.matchedBytes // 0' "$PREVIEW_JSON")"
preview_reclaimed="$(jq -r '.summary.reclaimedBytes // 0' "$PREVIEW_JSON")"
preview_failed="$(jq -r '.summary.failedCount // 0' "$PREVIEW_JSON")"
scope_accounts="$(jq -r '.summary.accountCount // 0' "$PREVIEW_JSON")"
scope_months="$(jq -r '.summary.monthCount // 0' "$PREVIEW_JSON")"
scope_categories="$(jq -r '.summary.categoryCount // 0' "$PREVIEW_JSON")"
engine="$(jq -r '.meta.engine // "unknown"' "$PREVIEW_JSON")"
duration_preview="$(jq -r '.meta.durationMs // 0' "$PREVIEW_JSON")"
warnings_preview="$(jq -r '(.warnings // []) | length' "$PREVIEW_JSON")"
errors_preview="$(jq -r '(.errors // []) | length' "$PREVIEW_JSON")"
matched_month_start="$(jq -r '.summary.matchedMonthStart // .data.report.matched.monthRange.from // ""' "$PREVIEW_JSON")"
matched_month_end="$(jq -r '.summary.matchedMonthEnd // .data.report.matched.monthRange.to // ""' "$PREVIEW_JSON")"
root_path_count="$(jq -r '.summary.rootPathCount // (.data.report.matched.rootStats // [] | length)' "$PREVIEW_JSON")"

executed="false"
execute_success=0
execute_skipped=0
execute_failed=0
execute_reclaimed=0
execute_batch="-"
verify_matched="$preview_matched"
duration_exec=0
duration_verify=0
warnings_exec=0
warnings_verify=0
errors_exec=0
errors_verify=0

if [[ "$preview_matched" -gt 0 && "$EXECUTE" == "true" ]]; then
  run_cmd_to_file false "$EXEC_JSON" "$EXEC_ERR"
  executed="true"
  execute_success="$(jq -r '.summary.successCount // 0' "$EXEC_JSON")"
  execute_skipped="$(jq -r '.summary.skippedCount // 0' "$EXEC_JSON")"
  execute_failed="$(jq -r '.summary.failedCount // 0' "$EXEC_JSON")"
  execute_reclaimed="$(jq -r '.summary.reclaimedBytes // 0' "$EXEC_JSON")"
  execute_batch="$(jq -r '.summary.batchId // "-"' "$EXEC_JSON")"
  duration_exec="$(jq -r '.meta.durationMs // 0' "$EXEC_JSON")"
  warnings_exec="$(jq -r '(.warnings // []) | length' "$EXEC_JSON")"
  errors_exec="$(jq -r '(.errors // []) | length' "$EXEC_JSON")"

  run_cmd_to_file true "$VERIFY_JSON" "$VERIFY_ERR"
  verify_matched="$(jq -r '.summary.matchedTargets // 0' "$VERIFY_JSON")"
  duration_verify="$(jq -r '.meta.durationMs // 0' "$VERIFY_JSON")"
  warnings_verify="$(jq -r '(.warnings // []) | length' "$VERIFY_JSON")"
  errors_verify="$(jq -r '(.errors // []) | length' "$VERIFY_JSON")"
fi

if [[ "$executed" == "true" ]]; then
  conclusion="已完成"
  reason="已按授权执行真实清理，并完成同范围复核。"
elif [[ "$preview_matched" -eq 0 ]]; then
  conclusion="无需执行"
  reason="范围内无可处理目标，按安全规则未执行真实清理。"
else
  conclusion="仅预演"
  reason="已完成预演，等待授权执行真实清理。"
fi

duration_total=$((duration_preview + duration_exec + duration_verify))
warnings_total=$((warnings_preview + warnings_exec + warnings_verify))
errors_total=$((errors_preview + errors_exec + errors_verify))

selected_categories_human=""
while IFS= read -r key; do
  [[ -z "${key:-}" ]] && continue
  label="$(category_label_from_key "$key")"
  if [[ -n "$selected_categories_human" ]]; then
    selected_categories_human="${selected_categories_human}、${label}"
  else
    selected_categories_human="${label}"
  fi
done < <(jq -r '.data.selectedCategories // [] | .[]' "$PREVIEW_JSON")
if [[ -z "$selected_categories_human" ]]; then
  selected_categories_human="默认类别"
fi

printf '\n=== 清理结果（给用户）===\n'
if [[ "$executed" == "true" ]]; then
  printf -- '- 已完成：已清理 %s 项聊天缓存，释放 %s。\n' "$execute_success" "$(human_bytes "$execute_reclaimed")"
elif [[ "$preview_matched" -eq 0 ]]; then
  printf -- '- 已完成检查：截至 %s 及之前未发现可清理的聊天缓存，本次未执行删除。\n' "$CUTOFF_MONTH"
else
  printf -- '- 已完成预演：预计可清理 %s 项、释放 %s；等待你确认后执行真实清理。\n' "$preview_matched" "$(human_bytes "$preview_reclaimed")"
fi
printf -- '- 你的目标：清理 %s 及之前的企业微信聊天缓存。\n' "$CUTOFF_MONTH"

printf '\n你关心的范围\n'
printf -- '- 账号：%s（识别到 %s 个账号）\n' "$account_scope_label" "$scope_accounts"
printf -- '- 数据类型：%s\n' "$selected_categories_human"
if [[ -n "$matched_month_start" && -n "$matched_month_end" ]]; then
  printf -- '- 实际命中月份：%s ~ %s\n' "$matched_month_start" "$matched_month_end"
else
  printf -- '- 实际命中月份：无\n'
fi
printf -- '- 涉及目录根：%s 个\n' "$root_path_count"

printf '\n清理结果总览\n'
printf -- '- 命中目录：%s 项（表示范围内可处理目录数量）\n' "$preview_matched"
printf -- '- 命中字节：%s（命中目录当前大小）\n' "$(human_bytes "$preview_matched_bytes")"
printf -- '- 预计释放：%s（预演估算）\n' "$(human_bytes "$preview_reclaimed")"
if [[ "$executed" == "true" ]]; then
  printf -- '- 实际释放：%s（真实执行结果）\n' "$(human_bytes "$execute_reclaimed")"
  printf -- '- 清理批次：%s（可用于恢复）\n' "$execute_batch"
  printf -- '- 复核结果：剩余可清理 %s 项\n' "$verify_matched"
else
  printf -- '- 执行状态：未执行真实清理（%s）\n' "$reason"
  printf -- '- 复核结果：沿用预演结论（剩余可清理 %s 项）\n' "$verify_matched"
fi

printf '\n按类别统计（你清理了什么）\n'
category_rows=0
while IFS=$'\t' read -r category_label category_count category_bytes; do
  [[ -z "${category_label:-}" ]] && continue
  printf -- '- %s：%s 项，%s\n' "$category_label" "$category_count" "$(human_bytes "$category_bytes")"
  category_rows=$((category_rows + 1))
  if [[ "$category_rows" -ge 12 ]]; then
    break
  fi
done < <(
  jq -r '.data.report.matched.categoryStats // [] | .[] | [(.categoryLabel // .categoryKey // "-"), ((.targetCount // 0)|tostring), ((.sizeBytes // 0)|tostring)] | @tsv' \
    "$PREVIEW_JSON"
)
if [[ "$category_rows" -eq 0 ]]; then
  printf -- '- 本次范围内没有命中任何可清理类别。\n'
fi

printf '\n按月份统计（你清理了哪些月份）\n'
month_rows=0
while IFS=$'\t' read -r month_key month_count month_bytes; do
  [[ -z "${month_key:-}" ]] && continue
  printf -- '- %s：%s 项，%s\n' "$month_key" "$month_count" "$(human_bytes "$month_bytes")"
  month_rows=$((month_rows + 1))
  if [[ "$month_rows" -ge 24 ]]; then
    break
  fi
done < <(
  jq -r '.data.report.matched.monthStats // [] | .[] | [(.monthKey // "非月份目录"), ((.targetCount // 0)|tostring), ((.sizeBytes // 0)|tostring)] | @tsv' \
    "$PREVIEW_JSON"
)
if [[ "$month_rows" -eq 0 ]]; then
  printf -- '- 本次范围内没有命中任何月份目录。\n'
fi

printf '\n路径范围（主要清理目录）\n'
root_rows=0
while IFS=$'\t' read -r root_path root_count root_bytes root_type; do
  [[ -z "${root_path:-}" ]] && continue
  short_root="$(short_path "$root_path" 88)"
  type_label="账号目录"
  if [[ "$root_type" == "external" ]]; then
    type_label="外部存储"
  fi
  printf -- '- [%s] %s：%s 项，%s\n' "$type_label" "$short_root" "$root_count" "$(human_bytes "$root_bytes")"
  root_rows=$((root_rows + 1))
  if [[ "$root_rows" -ge 8 ]]; then
    break
  fi
done < <(
  jq -r '.data.report.matched.rootStats // [] | .[] | [(.rootPath // "-"), ((.targetCount // 0)|tostring), ((.sizeBytes // 0)|tostring), (.rootType // "profile")] | @tsv' \
    "$PREVIEW_JSON"
)
if [[ "$root_rows" -eq 0 ]]; then
  printf -- '- 本次范围内没有命中具体目录。\n'
fi

printf '\n路径样例（按体积Top 10）\n'
top_rows=0
while IFS=$'\t' read -r target_path target_category target_month target_bytes; do
  [[ -z "${target_path:-}" ]] && continue
  short_target="$(short_path "$target_path" 84)"
  printf -- '- %s | %s | %s | %s\n' \
    "$target_category" \
    "${target_month:-非月份目录}" \
    "$(human_bytes "$target_bytes")" \
    "$short_target"
  top_rows=$((top_rows + 1))
  if [[ "$top_rows" -ge 10 ]]; then
    break
  fi
done < <(
  jq -r '.data.report.matched.topPaths // [] | .[] | [(.path // "-"), (.categoryLabel // .categoryKey // "-"), (.monthKey // "非月份目录"), ((.sizeBytes // 0)|tostring)] | @tsv' \
    "$PREVIEW_JSON"
)
if [[ "$top_rows" -eq 0 ]]; then
  printf -- '- 无样例路径。\n'
fi

if [[ "$executed" == "true" ]]; then
  printf '\n实际执行明细（按类别）\n'
  exec_category_rows=0
  while IFS=$'\t' read -r category_label success_count skipped_count failed_count success_bytes; do
    [[ -z "${category_label:-}" ]] && continue
    printf -- '- %s：成功 %s / 跳过 %s / 失败 %s，实际释放 %s\n' \
      "$category_label" \
      "$success_count" \
      "$skipped_count" \
      "$failed_count" \
      "$(human_bytes "$success_bytes")"
    exec_category_rows=$((exec_category_rows + 1))
    if [[ "$exec_category_rows" -ge 12 ]]; then
      break
    fi
  done < <(
    jq -r '.data.report.executed.byCategory // [] | .[] | [(.categoryLabel // .categoryKey // "-"), ((.successCount // 0)|tostring), ((.skippedCount // 0)|tostring), ((.failedCount // 0)|tostring), ((.successBytes // 0)|tostring)] | @tsv' \
      "$EXEC_JSON"
  )
  if [[ "$exec_category_rows" -eq 0 ]]; then
    printf -- '- 当前未返回按类别执行明细。\n'
  fi

  printf '\n实际执行明细（按月份）\n'
  exec_month_rows=0
  while IFS=$'\t' read -r month_key success_count skipped_count failed_count success_bytes; do
    [[ -z "${month_key:-}" ]] && continue
    printf -- '- %s：成功 %s / 跳过 %s / 失败 %s，实际释放 %s\n' \
      "$month_key" \
      "$success_count" \
      "$skipped_count" \
      "$failed_count" \
      "$(human_bytes "$success_bytes")"
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

if [[ "$warnings_total" -gt 0 || "$errors_total" -gt 0 ]]; then
  printf '\n异常与提示\n'
  printf -- '- 告警：%s\n' "$warnings_total"
  printf -- '- 错误：%s\n' "$errors_total"
fi

if [[ "$preview_matched" -eq 0 ]]; then
  printf '\n给你的建议\n'
  printf -- '- 若你确认历史数据应该存在，可在下一次执行时加上“包含非月份目录”再预演一次。\n'
  printf -- '- 若你使用了外部文件存储目录，请先确认该目录已被纳入扫描范围。\n'
fi

printf '\n指标释义\n'
printf -- '- 命中目录：本次范围内识别到的可处理目录数量。\n'
printf -- '- 命中字节：命中目录当前总大小。\n'
printf -- '- 预计释放：预演估算可回收空间（不会真实删除）。\n'
printf -- '- 清理批次：真实执行产生的恢复标识，后续可用于恢复。\n'
