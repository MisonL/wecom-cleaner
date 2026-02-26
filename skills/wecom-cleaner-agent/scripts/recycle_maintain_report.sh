#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
用法：
  recycle_maintain_report.sh [--execute true|false]
                            [--retention-enabled true|false]
                            [--retention-max-age-days <int>]
                            [--retention-min-keep-batches <int>]
                            [--retention-size-threshold-gb <int>]
                            [--root <path>] [--state-root <path>]

说明：
  - 默认只做预演（--execute false）。
  - --execute true 且候选批次>0 时，执行真实回收区治理。
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

EXECUTE="false"
RETENTION_ENABLED=""
RETENTION_MAX_AGE_DAYS=""
RETENTION_MIN_KEEP_BATCHES=""
RETENTION_SIZE_THRESHOLD_GB=""
ROOT=""
STATE_ROOT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --execute)
      EXECUTE="${2:-false}"
      shift 2
      ;;
    --retention-enabled)
      RETENTION_ENABLED="${2:-}"
      shift 2
      ;;
    --retention-max-age-days)
      RETENTION_MAX_AGE_DAYS="${2:-}"
      shift 2
      ;;
    --retention-min-keep-batches)
      RETENTION_MIN_KEEP_BATCHES="${2:-}"
      shift 2
      ;;
    --retention-size-threshold-gb)
      RETENTION_SIZE_THRESHOLD_GB="${2:-}"
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

local_time() {
  local ts="${1:-0}"
  if [[ "$ts" -le 0 ]]; then
    printf '%s' '-'
    return
  fi
  date -r "$((ts / 1000))" '+%Y-%m-%d %H:%M'
}

PREVIEW_JSON="$(mktemp -t wecom-recycle-preview.XXXX.json)"
EXEC_JSON="$(mktemp -t wecom-recycle-exec.XXXX.json)"
VERIFY_JSON="$(mktemp -t wecom-recycle-verify.XXXX.json)"
PREVIEW_ERR="$(mktemp -t wecom-recycle-preview.XXXX.err)"
EXEC_ERR="$(mktemp -t wecom-recycle-exec.XXXX.err)"
VERIFY_ERR="$(mktemp -t wecom-recycle-verify.XXXX.err)"
trap 'rm -f "$PREVIEW_JSON" "$EXEC_JSON" "$VERIFY_JSON" "$PREVIEW_ERR" "$EXEC_ERR" "$VERIFY_ERR"' EXIT

run_cmd_to_file() {
  local dry_run="$1"
  local output_file="$2"
  local err_file="$3"
  local cmd_parts=(--recycle-maintain --output json --dry-run "$dry_run")
  if [[ -n "$RETENTION_ENABLED" ]]; then
    cmd_parts+=(--retention-enabled "$RETENTION_ENABLED")
  fi
  if [[ -n "$RETENTION_MAX_AGE_DAYS" ]]; then
    cmd_parts+=(--retention-max-age-days "$RETENTION_MAX_AGE_DAYS")
  fi
  if [[ -n "$RETENTION_MIN_KEEP_BATCHES" ]]; then
    cmd_parts+=(--retention-min-keep-batches "$RETENTION_MIN_KEEP_BATCHES")
  fi
  if [[ -n "$RETENTION_SIZE_THRESHOLD_GB" ]]; then
    cmd_parts+=(--retention-size-threshold-gb "$RETENTION_SIZE_THRESHOLD_GB")
  fi
  if [[ -n "$ROOT" ]]; then
    cmd_parts+=(--root "$ROOT")
  fi
  if [[ -n "$STATE_ROOT" ]]; then
    cmd_parts+=(--state-root "$STATE_ROOT")
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

candidate_count="$(jq -r '.summary.candidateCount // 0' "$PREVIEW_JSON")"
deleted_batches_preview="$(jq -r '.summary.deletedBatches // 0' "$PREVIEW_JSON")"
deleted_bytes_preview="$(jq -r '.summary.deletedBytes // 0' "$PREVIEW_JSON")"
failed_batches_preview="$(jq -r '.summary.failedBatches // 0' "$PREVIEW_JSON")"
selected_by_age="$(jq -r '.summary.selectedByAge // 0' "$PREVIEW_JSON")"
selected_by_size="$(jq -r '.summary.selectedBySize // 0' "$PREVIEW_JSON")"
before_batches="$(jq -r '.data.report.before.totalBatches // 0' "$PREVIEW_JSON")"
before_bytes="$(jq -r '.data.report.before.totalBytes // 0' "$PREVIEW_JSON")"
after_batches_preview="$(jq -r '.summary.remainingBatches // 0' "$PREVIEW_JSON")"
after_bytes_preview="$(jq -r '.summary.remainingBytes // 0' "$PREVIEW_JSON")"
threshold_bytes="$(jq -r '.data.report.thresholdBytes // 0' "$PREVIEW_JSON")"
over_threshold="$(jq -r '.data.report.overThreshold // false' "$PREVIEW_JSON")"
engine="$(jq -r '.meta.engine // "unknown"' "$PREVIEW_JSON")"
duration_preview="$(jq -r '.meta.durationMs // 0' "$PREVIEW_JSON")"
warnings_preview="$(jq -r '(.warnings // []) | length' "$PREVIEW_JSON")"
errors_preview="$(jq -r '(.errors // []) | length' "$PREVIEW_JSON")"

executed="false"
deleted_batches_exec=0
deleted_bytes_exec=0
failed_batches_exec=0
after_batches_exec="$after_batches_preview"
after_bytes_exec="$after_bytes_preview"
duration_exec=0
duration_verify=0
warnings_exec=0
warnings_verify=0
errors_exec=0
errors_verify=0
candidate_count_verify="$candidate_count"

if [[ "$candidate_count" -gt 0 && "$EXECUTE" == "true" ]]; then
  run_cmd_to_file false "$EXEC_JSON" "$EXEC_ERR"
  executed="true"
  deleted_batches_exec="$(jq -r '.summary.deletedBatches // 0' "$EXEC_JSON")"
  deleted_bytes_exec="$(jq -r '.summary.deletedBytes // 0' "$EXEC_JSON")"
  failed_batches_exec="$(jq -r '.summary.failedBatches // 0' "$EXEC_JSON")"
  after_batches_exec="$(jq -r '.summary.remainingBatches // 0' "$EXEC_JSON")"
  after_bytes_exec="$(jq -r '.summary.remainingBytes // 0' "$EXEC_JSON")"
  duration_exec="$(jq -r '.meta.durationMs // 0' "$EXEC_JSON")"
  warnings_exec="$(jq -r '(.warnings // []) | length' "$EXEC_JSON")"
  errors_exec="$(jq -r '(.errors // []) | length' "$EXEC_JSON")"

  run_cmd_to_file true "$VERIFY_JSON" "$VERIFY_ERR"
  candidate_count_verify="$(jq -r '.summary.candidateCount // 0' "$VERIFY_JSON")"
  duration_verify="$(jq -r '.meta.durationMs // 0' "$VERIFY_JSON")"
  warnings_verify="$(jq -r '(.warnings // []) | length' "$VERIFY_JSON")"
  errors_verify="$(jq -r '(.errors // []) | length' "$VERIFY_JSON")"
fi

duration_total=$((duration_preview + duration_exec + duration_verify))
warnings_total=$((warnings_preview + warnings_exec + warnings_verify))
errors_total=$((errors_preview + errors_exec + errors_verify))

printf '\n=== 回收区治理结果（给用户）===\n'
if [[ "$executed" == "true" ]]; then
  printf -- '- 已完成：已处理 %s 个候选批次，释放 %s。\n' "$deleted_batches_exec" "$(human_bytes "$deleted_bytes_exec")"
else
  printf -- '- 已完成预演：发现 %s 个候选批次，预计可释放 %s。\n' "$candidate_count" "$(human_bytes "$deleted_bytes_preview")"
fi
printf -- '- 目标：回收区瘦身，释放历史批次占用空间。\n'

printf '\n你关心的范围\n'
printf -- '- 预演前：%s 个批次，%s\n' "$before_batches" "$(human_bytes "$before_bytes")"
printf -- '- 阈值：%s（当前%s阈值）\n' "$(human_bytes "$threshold_bytes")" "$( [[ "$over_threshold" == "true" ]] && printf '高于' || printf '未高于' )"
printf -- '- 候选批次：%s（按年龄 %s，按容量 %s）\n' "$candidate_count" "$selected_by_age" "$selected_by_size"

printf '\n治理结果总览\n'
if [[ "$executed" == "true" ]]; then
  printf -- '- 实际删除批次：%s，释放 %s，失败 %s\n' \
    "$deleted_batches_exec" "$(human_bytes "$deleted_bytes_exec")" "$failed_batches_exec"
  printf -- '- 治理后：%s 个批次，%s\n' "$after_batches_exec" "$(human_bytes "$after_bytes_exec")"
  printf -- '- 复核：当前候选批次剩余 %s 个\n' "$candidate_count_verify"
else
  printf -- '- 预演可删批次：%s，预计释放 %s，失败 %s\n' \
    "$deleted_batches_preview" "$(human_bytes "$deleted_bytes_preview")" "$failed_batches_preview"
  printf -- '- 执行状态：未执行真实治理（仅预演）。\n'
  printf -- '- 预演后估计：%s 个批次，%s\n' "$after_batches_preview" "$(human_bytes "$after_bytes_preview")"
fi

printf '\n候选批次清单（Top 20）\n'
candidate_rows=0
while IFS=$'\t' read -r bid first_time age_days bytes selected_by; do
  [[ -z "${bid:-}" ]] && continue
  printf -- '- 批次 %s | 时间 %s | 年龄 %s 天 | %s | 来源 %s\n' \
    "$bid" "$(local_time "$first_time")" "$age_days" "$(human_bytes "$bytes")" "$selected_by"
  candidate_rows=$((candidate_rows + 1))
  if [[ "$candidate_rows" -ge 20 ]]; then
    break
  fi
done < <(
  jq -r '.data.report.selectedCandidates // [] | sort_by(.totalBytes) | reverse | .[] | [(.batchId // "-"), ((.firstTime // 0)|tostring), ((.ageDays // 0)|tostring), ((.totalBytes // 0)|tostring), (.selectedBy // "-")] | @tsv' \
    "$PREVIEW_JSON"
)
if [[ "$candidate_rows" -eq 0 ]]; then
  printf -- '- 无候选批次。\n'
fi

if [[ "$executed" == "true" ]]; then
  printf '\n实际执行明细（Top 20）\n'
  op_rows=0
  while IFS=$'\t' read -r bid status selected_by bytes batch_root; do
    [[ -z "${bid:-}" ]] && continue
    printf -- '- 批次 %s | 状态 %s | 来源 %s | %s | %s\n' \
      "$bid" "$status" "$selected_by" "$(human_bytes "$bytes")" "${batch_root:--}"
    op_rows=$((op_rows + 1))
    if [[ "$op_rows" -ge 20 ]]; then
      break
    fi
  done < <(
    jq -r '.data.report.operations // [] | .[] | [(.batchId // "-"), (.status // "-"), (.selectedBy // "-"), ((.totalBytes // 0)|tostring), (.batchRoot // "-")] | @tsv' \
      "$EXEC_JSON"
  )
  if [[ "$op_rows" -eq 0 ]]; then
    printf -- '- 无执行明细。\n'
  fi
fi

printf '\n运行状态\n'
printf -- '- 扫描引擎：%s\n' "$engine"
printf -- '- 总耗时：%s ms\n' "$duration_total"
printf -- '- 告警：%s\n' "$warnings_total"
printf -- '- 错误：%s\n' "$errors_total"

printf '\n指标释义\n'
printf -- '- 候选批次：按“保留最近N批 + 最大保留天数 + 容量阈值”筛出的可治理批次。\n'
printf -- '- 按年龄/按容量：分别表示由时间策略和空间策略选中的批次数。\n'
printf -- '- 预计释放：预演阶段估算可释放空间。\n'
printf -- '- 实际删除批次：真实执行时已删除的回收区批次数。\n'
