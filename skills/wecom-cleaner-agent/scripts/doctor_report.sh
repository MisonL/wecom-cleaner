#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
用法：
  doctor_report.sh [--root <path>] [--state-root <path>]

说明：
  - 执行系统自检（只读），输出用户可读诊断报告。
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

ROOT=""
STATE_ROOT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
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

REPORT_JSON="$(mktemp -t wecom-doctor.XXXX.json)"
REPORT_ERR="$(mktemp -t wecom-doctor.XXXX.err)"
trap 'rm -f "$REPORT_JSON" "$REPORT_ERR"' EXIT

cmd=(--doctor --output json)
if [[ -n "$ROOT" ]]; then
  cmd+=(--root "$ROOT")
fi
if [[ -n "$STATE_ROOT" ]]; then
  cmd+=(--state-root "$STATE_ROOT")
fi

if ! wecom-cleaner "${cmd[@]}" >"$REPORT_JSON" 2>"$REPORT_ERR"; then
  err_head="$(head -n 3 "$REPORT_ERR" 2>/dev/null || true)"
  echo "执行失败：${err_head:-未知错误}" >&2
  exit 1
fi

overall="$(jq -r '.summary.overall // "unknown"' "$REPORT_JSON")"
pass_count="$(jq -r '.summary.pass // 0' "$REPORT_JSON")"
warn_count="$(jq -r '.summary.warn // 0' "$REPORT_JSON")"
fail_count="$(jq -r '.summary.fail // 0' "$REPORT_JSON")"
account_count="$(jq -r '.data.metrics.accountCount // 0' "$REPORT_JSON")"
external_count="$(jq -r '.data.metrics.externalStorageCount // 0' "$REPORT_JSON")"
recycle_batches="$(jq -r '.data.metrics.recycleBatchCount // 0' "$REPORT_JSON")"
recycle_bytes="$(jq -r '.data.metrics.recycleBytes // 0' "$REPORT_JSON")"
runtime_os="$(jq -r '.data.runtime.os // "-"' "$REPORT_JSON")"
runtime_arch="$(jq -r '.data.runtime.arch // "-"' "$REPORT_JSON")"
duration_ms="$(jq -r '.meta.durationMs // 0' "$REPORT_JSON")"
warnings_count="$(jq -r '(.warnings // []) | length' "$REPORT_JSON")"
errors_count="$(jq -r '(.errors // []) | length' "$REPORT_JSON")"

status_label="$overall"
case "$overall" in
  pass) status_label="健康" ;;
  warn) status_label="有风险" ;;
  fail) status_label="存在故障" ;;
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

printf '\n=== 系统自检结果（给用户）===\n'
printf -- '- 总体结论：%s（通过 %s、警告 %s、失败 %s）。\n' "$status_label" "$pass_count" "$warn_count" "$fail_count"
printf -- '- 这次检查是只读体检，不会改动你的数据。\n'

printf '\n环境概览\n'
printf -- '- 运行平台：%s / %s\n' "$runtime_os" "$runtime_arch"
printf -- '- 识别账号：%s 个\n' "$account_count"
printf -- '- 外部存储目录：%s 个\n' "$external_count"
printf -- '- 回收区批次：%s 个，约 %s\n' "$recycle_batches" "$(human_bytes "$recycle_bytes")"

printf '\n故障项（需要优先处理）\n'
fail_rows=0
while IFS=$'\t' read -r title detail suggestion; do
  [[ -z "${title:-}" ]] && continue
  printf -- '- %s：%s\n' "$title" "$detail"
  if [[ -n "${suggestion:-}" && "$suggestion" != "null" ]]; then
    printf -- '  建议：%s\n' "$suggestion"
  fi
  fail_rows=$((fail_rows + 1))
done < <(
  jq -r '.data.checks // [] | map(select(.status=="fail")) | .[] | [(.title // "-"), (.detail // "-"), (.suggestion // "")] | @tsv' "$REPORT_JSON"
)
if [[ "$fail_rows" -eq 0 ]]; then
  printf -- '- 无故障项。\n'
fi

printf '\n风险项（建议处理）\n'
warn_rows=0
while IFS=$'\t' read -r title detail suggestion; do
  [[ -z "${title:-}" ]] && continue
  printf -- '- %s：%s\n' "$title" "$detail"
  if [[ -n "${suggestion:-}" && "$suggestion" != "null" ]]; then
    printf -- '  建议：%s\n' "$suggestion"
  fi
  warn_rows=$((warn_rows + 1))
done < <(
  jq -r '.data.checks // [] | map(select(.status=="warn")) | .[] | [(.title // "-"), (.detail // "-"), (.suggestion // "")] | @tsv' "$REPORT_JSON"
)
if [[ "$warn_rows" -eq 0 ]]; then
  printf -- '- 无风险项。\n'
fi

printf '\n通过项（当前正常）\n'
pass_rows=0
while IFS=$'\t' read -r title detail; do
  [[ -z "${title:-}" ]] && continue
  printf -- '- %s：%s\n' "$title" "$detail"
  pass_rows=$((pass_rows + 1))
  if [[ "$pass_rows" -ge 12 ]]; then
    break
  fi
done < <(
  jq -r '.data.checks // [] | map(select(.status=="pass")) | .[] | [(.title // "-"), (.detail // "-")] | @tsv' "$REPORT_JSON"
)
if [[ "$pass_rows" -eq 0 ]]; then
  printf -- '- 无通过项。\n'
fi

printf '\n运行状态\n'
printf -- '- 耗时：%s ms\n' "$duration_ms"
printf -- '- 告警：%s\n' "$warnings_count"
printf -- '- 错误：%s\n' "$errors_count"

printf '\n指标释义\n'
printf -- '- 总体结论：pass=健康，warn=可运行但有风险，fail=需先修复。\n'
printf -- '- 回收区批次：当前可用于恢复的数据批次数。\n'
printf -- '- 外部存储目录：纳入扫描范围的企业微信文件存储根目录数量。\n'
