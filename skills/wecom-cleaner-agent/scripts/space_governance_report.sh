#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
用法：
  space_governance_report.sh [--accounts all|current|id1,id2] [--tiers safe,caution,protected]
                            [--suggested-only true|false] [--allow-recent-active true|false]
                            [--targets id1,id2] [--execute true|false]
                            [--root <path>] [--state-root <path>]
                            [--external-roots-source preset|configured|auto|all]

说明：
  - 默认只做预演（--execute false）。
  - --execute true 且预演命中>0 时，才执行真实治理。
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
TIERS="safe,caution"
SUGGESTED_ONLY="true"
ALLOW_RECENT_ACTIVE="false"
TARGETS=""
EXECUTE="false"
ROOT=""
STATE_ROOT=""
EXTERNAL_ROOTS_SOURCE="all"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --accounts)
      ACCOUNTS="${2:-all}"
      shift 2
      ;;
    --tiers)
      TIERS="${2:-safe,caution}"
      shift 2
      ;;
    --suggested-only)
      SUGGESTED_ONLY="${2:-true}"
      shift 2
      ;;
    --allow-recent-active)
      ALLOW_RECENT_ACTIVE="${2:-false}"
      shift 2
      ;;
    --targets)
      TARGETS="${2:-}"
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

case "$EXECUTE" in
  true | false) ;;
  *)
    echo "错误：--execute 只能是 true 或 false" >&2
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

tier_label() {
  local tier="${1:-}"
  case "$tier" in
    safe) printf '%s' '安全层' ;;
    caution) printf '%s' '谨慎层' ;;
    protected) printf '%s' '保护层' ;;
    *) printf '%s' "$tier" ;;
  esac
}

account_scope_label="$ACCOUNTS"
if [[ "$ACCOUNTS" == "all" ]]; then
  account_scope_label="全部账号"
elif [[ "$ACCOUNTS" == "current" ]]; then
  account_scope_label="当前账号"
fi

PREVIEW_JSON="$(mktemp -t wecom-space-preview.XXXX.json)"
EXEC_JSON="$(mktemp -t wecom-space-exec.XXXX.json)"
VERIFY_JSON="$(mktemp -t wecom-space-verify.XXXX.json)"
PREVIEW_ERR="$(mktemp -t wecom-space-preview.XXXX.err)"
EXEC_ERR="$(mktemp -t wecom-space-exec.XXXX.err)"
VERIFY_ERR="$(mktemp -t wecom-space-verify.XXXX.err)"
trap 'rm -f "$PREVIEW_JSON" "$EXEC_JSON" "$VERIFY_JSON" "$PREVIEW_ERR" "$EXEC_ERR" "$VERIFY_ERR"' EXIT

run_cmd_to_file() {
  local dry_run="$1"
  local output_file="$2"
  local err_file="$3"
  local cmd_parts=(
    --space-governance
    --accounts "$ACCOUNTS"
    --tiers "$TIERS"
    --suggested-only "$SUGGESTED_ONLY"
    --allow-recent-active "$ALLOW_RECENT_ACTIVE"
    --output json
    --dry-run "$dry_run"
  )
  if [[ -n "$TARGETS" ]]; then
    cmd_parts+=(--targets "$TARGETS")
  fi
  if [[ -n "$ROOT" ]]; then
    cmd_parts+=(--root "$ROOT")
  fi
  if [[ -n "$STATE_ROOT" ]]; then
    cmd_parts+=(--state-root "$STATE_ROOT")
  fi
  if [[ -n "$EXTERNAL_ROOTS_SOURCE" ]]; then
    cmd_parts+=(--external-roots-source "$EXTERNAL_ROOTS_SOURCE")
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

matched_targets="$(jq -r '.summary.matchedTargets // 0' "$PREVIEW_JSON")"
matched_bytes="$(jq -r '.summary.matchedBytes // (.data.report.matched.totalBytes // 0)' "$PREVIEW_JSON")"
preview_reclaimed="$(jq -r '.summary.reclaimedBytes // 0' "$PREVIEW_JSON")"
preview_failed="$(jq -r '.summary.failedCount // 0' "$PREVIEW_JSON")"
tier_count="$(jq -r '.summary.tierCount // (.data.report.matched.byTier // [] | length)' "$PREVIEW_JSON")"
target_type_count="$(jq -r '.summary.targetTypeCount // (.data.report.matched.byTargetType // [] | length)' "$PREVIEW_JSON")"
root_path_count="$(jq -r '.summary.rootPathCount // (.data.report.matched.byRoot // [] | length)' "$PREVIEW_JSON")"
engine="$(jq -r '.data.engineUsed // .meta.engine // "unknown"' "$PREVIEW_JSON")"
duration_preview="$(jq -r '.meta.durationMs // 0' "$PREVIEW_JSON")"
warnings_preview="$(jq -r '(.warnings // []) | length' "$PREVIEW_JSON")"
errors_preview="$(jq -r '(.errors // []) | length' "$PREVIEW_JSON")"

executed="false"
execute_success=0
execute_skipped=0
execute_failed=0
execute_reclaimed=0
execute_batch="-"
verify_matched="$matched_targets"
duration_exec=0
duration_verify=0
warnings_exec=0
warnings_verify=0
errors_exec=0
errors_verify=0

if [[ "$matched_targets" -gt 0 && "$EXECUTE" == "true" ]]; then
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
  reason="已按授权执行全量空间治理，并完成同条件复核。"
elif [[ "$matched_targets" -eq 0 ]]; then
  conclusion="无需执行"
  reason="当前筛选条件下没有可治理目标，按安全规则未执行真实删除。"
else
  conclusion="仅预演"
  reason="已完成预演，等待你确认执行真实治理。"
fi

duration_total=$((duration_preview + duration_exec + duration_verify))
warnings_total=$((warnings_preview + warnings_exec + warnings_verify))
errors_total=$((errors_preview + errors_exec + errors_verify))

printf '\n=== 全量空间治理结果（给用户）===\n'
printf -- '- 执行结论：%s（%s）\n' "$conclusion" "$reason"
if [[ "$executed" == "true" ]]; then
  printf -- '- 已完成：已治理 %s 项空间目标，释放 %s。\n' "$execute_success" "$(human_bytes "$execute_reclaimed")"
elif [[ "$matched_targets" -eq 0 ]]; then
  printf -- '- 已完成检查：当前条件下未发现可治理目标，本次未执行删除。\n'
else
  printf -- '- 已完成预演：预计可治理 %s 项、释放 %s；等待确认执行。\n' "$matched_targets" "$(human_bytes "$preview_reclaimed")"
fi
printf -- '- 你的目标：按“全量空间治理”规则清理低风险缓存目录。\n'

printf '\n你关心的范围\n'
printf -- '- 账号：%s\n' "$account_scope_label"
printf -- '- 层级：%s\n' "$TIERS"
printf -- '- 仅建议项：%s\n' "$SUGGESTED_ONLY"
printf -- '- 允许近期活跃：%s\n' "$ALLOW_RECENT_ACTIVE"
printf -- '- 命中路径根：%s 个\n' "$root_path_count"

printf '\n治理结果总览\n'
printf -- '- 命中治理项：%s 项\n' "$matched_targets"
printf -- '- 命中体积：%s\n' "$(human_bytes "$matched_bytes")"
printf -- '- 预计释放：%s\n' "$(human_bytes "$preview_reclaimed")"
if [[ "$executed" == "true" ]]; then
  printf -- '- 实际释放：%s\n' "$(human_bytes "$execute_reclaimed")"
  printf -- '- 执行明细：成功 %s / 跳过 %s / 失败 %s\n' "$execute_success" "$execute_skipped" "$execute_failed"
  printf -- '- 清理批次：%s（可用于恢复）\n' "$execute_batch"
  printf -- '- 复核结果：剩余可治理 %s 项\n' "$verify_matched"
else
  printf -- '- 执行状态：未执行真实治理（%s）\n' "$reason"
  printf -- '- 复核结果：沿用预演结论（剩余可治理 %s 项）\n' "$verify_matched"
fi

printf '\n按风险层级统计\n'
tier_rows=0
while IFS=$'\t' read -r tier tier_label_raw count bytes suggested_count active_count; do
  [[ -z "${tier:-}" ]] && continue
  if [[ -z "$tier_label_raw" || "$tier_label_raw" == "null" ]]; then
    tier_label_raw="$(tier_label "$tier")"
  fi
  printf -- '- %s：%s 项，%s（建议 %s 项，近期活跃 %s 项）\n' \
    "$tier_label_raw" "$count" "$(human_bytes "$bytes")" "$suggested_count" "$active_count"
  tier_rows=$((tier_rows + 1))
done < <(
  jq -r '.data.report.matched.byTier // [] | .[] | [(.tier // "-"), (.tierLabel // ""), ((.targetCount // 0)|tostring), ((.sizeBytes // 0)|tostring), ((.suggestedCount // 0)|tostring), ((.recentlyActiveCount // 0)|tostring)] | @tsv' \
    "$PREVIEW_JSON"
)
if [[ "$tier_rows" -eq 0 ]]; then
  printf -- '- 无层级数据。\n'
fi

printf '\n按目标类型统计（你清理了什么）\n'
target_rows=0
while IFS=$'\t' read -r label count bytes; do
  [[ -z "${label:-}" ]] && continue
  printf -- '- %s：%s 项，%s\n' "$label" "$count" "$(human_bytes "$bytes")"
  target_rows=$((target_rows + 1))
  if [[ "$target_rows" -ge 20 ]]; then
    break
  fi
done < <(
  jq -r '.data.report.matched.byTargetType // [] | .[] | [(.targetLabel // .targetKey // "-"), ((.targetCount // 0)|tostring), ((.sizeBytes // 0)|tostring)] | @tsv' \
    "$PREVIEW_JSON"
)
if [[ "$target_rows" -eq 0 ]]; then
  printf -- '- 无命中目标类型。\n'
fi

printf '\n路径范围（主要治理目录）\n'
root_rows=0
while IFS=$'\t' read -r root_path count bytes root_type; do
  [[ -z "${root_path:-}" ]] && continue
  type_label="账号目录"
  if [[ "$root_type" == "external" ]]; then
    type_label="外部存储"
  fi
  printf -- '- [%s] %s：%s 项，%s\n' "$type_label" "$(short_path "$root_path" 88)" "$count" "$(human_bytes "$bytes")"
  root_rows=$((root_rows + 1))
  if [[ "$root_rows" -ge 10 ]]; then
    break
  fi
done < <(
  jq -r '.data.report.matched.byRoot // [] | .[] | [(.rootPath // "-"), ((.targetCount // 0)|tostring), ((.sizeBytes // 0)|tostring), (.rootType // "profile")] | @tsv' \
    "$PREVIEW_JSON"
)
if [[ "$root_rows" -eq 0 ]]; then
  printf -- '- 无命中目录。\n'
fi

printf '\n路径样例（按体积Top 10）\n'
top_rows=0
while IFS=$'\t' read -r p label tier_label_text bytes acc suggested active; do
  [[ -z "${p:-}" ]] && continue
  tag=""
  if [[ "$suggested" == "true" ]]; then
    tag="${tag}建议 "
  fi
  if [[ "$active" == "true" ]]; then
    tag="${tag}活跃 "
  fi
  printf -- '- %s | %s | %s | %s | %s%s\n' "$label" "$tier_label_text" "$acc" "$(human_bytes "$bytes")" "$tag" "$(short_path "$p" 80)"
  top_rows=$((top_rows + 1))
  if [[ "$top_rows" -ge 10 ]]; then
    break
  fi
done < <(
  jq -r '.data.report.matched.topPaths // [] | .[] | [(.path // "-"), (.targetLabel // .targetKey // "-"), (.tierLabel // .tier // "-"), (.sizeBytes // 0 | tostring), (.accountShortId // "-"), ((.suggested // false)|tostring), ((.recentlyActive // false)|tostring)] | @tsv' \
    "$PREVIEW_JSON"
)
if [[ "$top_rows" -eq 0 ]]; then
  printf -- '- 无路径样例。\n'
fi

if [[ "$executed" == "true" ]]; then
  printf '\n实际执行明细（按目标类型）\n'
  exec_rows=0
  while IFS=$'\t' read -r label s k f sbytes; do
    [[ -z "${label:-}" ]] && continue
    printf -- '- %s：成功 %s / 跳过 %s / 失败 %s，实际释放 %s\n' "$label" "$s" "$k" "$f" "$(human_bytes "$sbytes")"
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
    printf -- '- %s：成功 %s / 跳过 %s / 失败 %s，实际释放 %s\n' "$month" "$s" "$k" "$f" "$(human_bytes "$sbytes")"
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
printf -- '- 耗时：%s ms\n' "$duration_total"
printf -- '- 告警：%s\n' "$warnings_total"
printf -- '- 错误：%s\n' "$errors_total"
printf -- '- 预演失败项：%s\n' "$preview_failed"
printf -- '- 风险层级数量：%s，目标类型数量：%s\n' "$tier_count" "$target_type_count"

printf '\n指标释义\n'
printf -- '- 命中治理项：本次筛选条件下可处理的目录目标数量。\n'
printf -- '- 预计释放：预演估算可回收空间，真实执行前不会实际删除。\n'
printf -- '- 建议项：由策略判断为优先治理的低风险目标。\n'
printf -- '- 近期活跃：最近仍有访问行为的目录，默认建议跳过。\n'
