#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
用法：
  analysis_report.sh [--accounts all|current|id1,id2] [--categories csv]
                    [--root <path>] [--state-root <path>]
                    [--external-roots-source preset|configured|auto|all]

说明：
  - 执行“会话分析（只读）”，输出用户可读的盘点报告。
  - 不执行删除操作。
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

ACCOUNTS="all"
CATEGORIES=""
ROOT=""
STATE_ROOT=""
EXTERNAL_ROOTS_SOURCE="all"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --accounts)
      ACCOUNTS="${2:-all}"
      shift 2
      ;;
    --categories)
      CATEGORIES="${2:-}"
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
  local max_len="${2:-88}"
  if [[ "${#raw}" -le "$max_len" ]]; then
    printf '%s' "$raw"
    return
  fi
  local keep=$((max_len - 3))
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

account_scope_label="$ACCOUNTS"
if [[ "$ACCOUNTS" == "all" ]]; then
  account_scope_label="全部账号"
elif [[ "$ACCOUNTS" == "current" ]]; then
  account_scope_label="当前账号"
fi

REPORT_JSON="$(mktemp -t wecom-analysis.XXXX.json)"
REPORT_ERR="$(mktemp -t wecom-analysis.XXXX.err)"
trap 'rm -f "$REPORT_JSON" "$REPORT_ERR"' EXIT

cmd=(--analysis-only --accounts "$ACCOUNTS" --output json)
if [[ -n "$CATEGORIES" ]]; then
  cmd+=(--categories "$CATEGORIES")
fi
if [[ -n "$ROOT" ]]; then
  cmd+=(--root "$ROOT")
fi
if [[ -n "$STATE_ROOT" ]]; then
  cmd+=(--state-root "$STATE_ROOT")
fi
if [[ -n "$EXTERNAL_ROOTS_SOURCE" ]]; then
  cmd+=(--external-roots-source "$EXTERNAL_ROOTS_SOURCE")
fi

if ! wecom-cleaner "${cmd[@]}" >"$REPORT_JSON" 2>"$REPORT_ERR"; then
  err_head="$(head -n 3 "$REPORT_ERR" 2>/dev/null || true)"
  echo "执行失败：${err_head:-未知错误}" >&2
  exit 1
fi

target_count="$(jq -r '.summary.targetCount // 0' "$REPORT_JSON")"
total_bytes="$(jq -r '.summary.totalBytes // 0' "$REPORT_JSON")"
account_count="$(jq -r '.summary.accountCount // 0' "$REPORT_JSON")"
matched_account_count="$(jq -r '.summary.matchedAccountCount // (.data.accountsSummary // [] | length)' "$REPORT_JSON")"
category_count="$(jq -r '.summary.categoryCount // 0' "$REPORT_JSON")"
month_bucket_count="$(jq -r '.summary.monthBucketCount // 0' "$REPORT_JSON")"
engine="$(jq -r '.data.engineUsed // .meta.engine // "unknown"' "$REPORT_JSON")"
duration_ms="$(jq -r '.meta.durationMs // 0' "$REPORT_JSON")"
warnings_count="$(jq -r '(.warnings // []) | length' "$REPORT_JSON")"
errors_count="$(jq -r '(.errors // []) | length' "$REPORT_JSON")"

selected_categories_human=""
while IFS= read -r key; do
  [[ -z "${key:-}" ]] && continue
  label="$(category_label_from_key "$key")"
  if [[ -n "$selected_categories_human" ]]; then
    selected_categories_human="${selected_categories_human}、${label}"
  else
    selected_categories_human="${label}"
  fi
done < <(jq -r '.data.selectedCategories // [] | .[]' "$REPORT_JSON")
if [[ -z "$selected_categories_human" ]]; then
  selected_categories_human="默认类别"
fi

printf '\n=== 会话分析结果（给用户）===\n'
printf -- '- 已完成盘点：当前共识别到 %s 项缓存目录，总体积 %s。\n' "$target_count" "$(human_bytes "$total_bytes")"
printf -- '- 这一步是只读分析，不会删除任何数据。\n'

printf '\n你关心的范围\n'
printf -- '- 账号：%s（范围内 %s 个账号，实际命中数据 %s 个）\n' "$account_scope_label" "$account_count" "$matched_account_count"
printf -- '- 数据类型：%s\n' "$selected_categories_human"
printf -- '- 月份桶数量：%s（含“非月份目录”）\n' "$month_bucket_count"

printf '\n结果总览\n'
printf -- '- 缓存目录数量：%s 项\n' "$target_count"
printf -- '- 总体积：%s\n' "$(human_bytes "$total_bytes")"
printf -- '- 类别数：%s\n' "$category_count"

printf '\n按类别统计（缓存主要来源）\n'
cat_rows=0
while IFS=$'\t' read -r label count bytes; do
  [[ -z "${label:-}" ]] && continue
  printf -- '- %s：%s 项，%s\n' "$label" "$count" "$(human_bytes "$bytes")"
  cat_rows=$((cat_rows + 1))
  if [[ "$cat_rows" -ge 16 ]]; then
    break
  fi
done < <(
  jq -r '.data.categoriesSummary // [] | .[] | [(.categoryLabel // .categoryKey // "-"), ((.count // 0)|tostring), ((.sizeBytes // 0)|tostring)] | @tsv' \
    "$REPORT_JSON"
)
if [[ "$cat_rows" -eq 0 ]]; then
  printf -- '- 无类别数据。\n'
fi

printf '\n按月份统计（缓存分布）\n'
month_rows=0
while IFS=$'\t' read -r month_key count bytes; do
  [[ -z "${month_key:-}" ]] && continue
  printf -- '- %s：%s 项，%s\n' "$month_key" "$count" "$(human_bytes "$bytes")"
  month_rows=$((month_rows + 1))
  if [[ "$month_rows" -ge 24 ]]; then
    break
  fi
done < <(
  jq -r '.data.monthsSummary // [] | .[] | [(.monthKey // "非月份目录"), ((.count // 0)|tostring), ((.sizeBytes // 0)|tostring)] | @tsv' \
    "$REPORT_JSON"
)
if [[ "$month_rows" -eq 0 ]]; then
  printf -- '- 无月份数据。\n'
fi

printf '\n按账号统计（谁占用更多空间）\n'
acc_rows=0
while IFS=$'\t' read -r short_id user_name corp_name count bytes; do
  [[ -z "${short_id:-}" ]] && continue
  printf -- '- %s | %s | %s：%s 项，%s\n' "$short_id" "$user_name" "$corp_name" "$count" "$(human_bytes "$bytes")"
  acc_rows=$((acc_rows + 1))
  if [[ "$acc_rows" -ge 12 ]]; then
    break
  fi
done < <(
  jq -r '.data.accountsSummary // [] | .[] | [(.shortId // "-"), (.userName // "-"), (.corpName // "-"), ((.count // 0)|tostring), ((.sizeBytes // 0)|tostring)] | @tsv' \
    "$REPORT_JSON"
)
if [[ "$acc_rows" -eq 0 ]]; then
  printf -- '- 无账号数据。\n'
fi

printf '\n路径范围（主要目录）\n'
root_rows=0
while IFS=$'\t' read -r p count bytes root_type; do
  [[ -z "${p:-}" ]] && continue
  type_label="账号目录"
  if [[ "$root_type" == "external" ]]; then
    type_label="外部存储"
  fi
  printf -- '- [%s] %s：%s 项，%s\n' "$type_label" "$(short_path "$p" 84)" "$count" "$(human_bytes "$bytes")"
  root_rows=$((root_rows + 1))
  if [[ "$root_rows" -ge 12 ]]; then
    break
  fi
done < <(
  jq -r '.data.report.matched.rootStats // [] | .[] | [(.rootPath // "-"), ((.targetCount // 0)|tostring), ((.sizeBytes // 0)|tostring), (.rootType // "profile")] | @tsv' \
    "$REPORT_JSON"
)
if [[ "$root_rows" -eq 0 ]]; then
  printf -- '- 无路径范围数据。\n'
fi

printf '\n路径样例（按体积Top 10）\n'
top_rows=0
while IFS=$'\t' read -r p label month bytes; do
  [[ -z "${p:-}" ]] && continue
  printf -- '- %s | %s | %s | %s\n' "$label" "${month:-非月份目录}" "$(human_bytes "$bytes")" "$(short_path "$p" 84)"
  top_rows=$((top_rows + 1))
  if [[ "$top_rows" -ge 10 ]]; then
    break
  fi
done < <(
  jq -r '.data.report.matched.topPaths // [] | .[] | [(.path // "-"), (.categoryLabel // .categoryKey // "-"), (.monthKey // "非月份目录"), ((.sizeBytes // 0)|tostring)] | @tsv' \
    "$REPORT_JSON"
)
if [[ "$top_rows" -eq 0 ]]; then
  printf -- '- 无路径样例。\n'
fi

printf '\n运行状态\n'
printf -- '- 扫描引擎：%s\n' "$engine"
printf -- '- 耗时：%s ms\n' "$duration_ms"
printf -- '- 告警：%s\n' "$warnings_count"
printf -- '- 错误：%s\n' "$errors_count"

printf '\n指标释义\n'
printf -- '- 缓存目录数量：本次命中范围内识别到的目录条目总数。\n'
printf -- '- 总体积：当前已占用空间，不代表会自动删除。\n'
printf -- '- 月份桶：用于观察历史分布，含“非月份目录”。\n'
