#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
用法：
  check_update_report.sh [--channel stable|pre] [--root <path>] [--state-root <path>]

说明：
  - 执行“检查更新（只读）”，不做任何安装动作。
  - 输出用户可读任务卡片。
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

CHANNEL="stable"
ROOT=""
STATE_ROOT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel | --upgrade-channel)
      CHANNEL="${2:-stable}"
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

case "$CHANNEL" in
  stable | pre) ;;
  *)
    echo "错误：--channel 只能是 stable 或 pre" >&2
    exit 2
    ;;
esac

REPORT_JSON="$(mktemp -t wecom-check-update.XXXX.json)"
REPORT_ERR="$(mktemp -t wecom-check-update.XXXX.err)"
trap 'rm -f "$REPORT_JSON" "$REPORT_ERR"' EXIT

cmd=(--check-update --output json --upgrade-channel "$CHANNEL")
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

checked="$(jq -r '.summary.checked // false' "$REPORT_JSON")"
has_update="$(jq -r '.summary.hasUpdate // false' "$REPORT_JSON")"
current_version="$(jq -r '.summary.currentVersion // "-"' "$REPORT_JSON")"
latest_version="$(jq -r '.summary.latestVersion // "-"' "$REPORT_JSON")"
source_used="$(jq -r '.summary.source // "none"' "$REPORT_JSON")"
channel_used="$(jq -r '.summary.channel // "stable"' "$REPORT_JSON")"
skipped_by_user="$(jq -r '.summary.skippedByUser // false' "$REPORT_JSON")"
duration_ms="$(jq -r '.meta.durationMs // 0' "$REPORT_JSON")"
warnings_count="$(jq -r '(.warnings // []) | length' "$REPORT_JSON")"
errors_count="$(jq -r '(.errors // []) | length' "$REPORT_JSON")"

source_label="$source_used"
case "$source_used" in
  npm) source_label="npmjs" ;;
  github) source_label="GitHub Release" ;;
  none) source_label="不可用" ;;
esac

channel_label="稳定版"
if [[ "$channel_used" == "pre" ]]; then
  channel_label="预发布"
fi

if [[ "$checked" != "true" ]]; then
  conclusion="检查失败，请稍后重试。"
elif [[ "$has_update" == "true" ]]; then
  if [[ "$skipped_by_user" == "true" ]]; then
    conclusion="检测到新版本，但该版本已被设置为跳过提醒。"
  else
    conclusion="检测到新版本，可按你确认后升级。"
  fi
else
  conclusion="当前已是最新版本。"
fi

printf '\n=== 更新检查结果（给用户）===\n'
printf -- '- 执行结论：%s\n' "$conclusion"
printf -- '- 本次只做版本检查，不会改动你的数据或本机安装。\n'

printf '\n版本信息\n'
printf -- '- 当前版本：%s\n' "$current_version"
printf -- '- 最新版本：%s\n' "$latest_version"
printf -- '- 检查通道：%s\n' "$channel_label"
printf -- '- 信息来源：%s（先 npm，失败再回退 GitHub）\n' "$source_label"
printf -- '- 用户跳过提醒：%s\n' "$( [[ "$skipped_by_user" == "true" ]] && printf '是' || printf '否' )"

if [[ "$has_update" == "true" && "$skipped_by_user" != "true" ]]; then
  printf '\n建议下一步（需你确认后执行）\n'
  printf -- '- 默认升级方式（npm）：wecom-cleaner --upgrade npm --upgrade-version %s --upgrade-yes\n' "$latest_version"
  printf -- '- 备选方式（GitHub 脚本）：wecom-cleaner --upgrade github-script --upgrade-version %s --upgrade-yes\n' "$latest_version"
fi

printf '\n运行状态\n'
printf -- '- 耗时：%s ms\n' "$duration_ms"
printf -- '- 告警：%s\n' "$warnings_count"
printf -- '- 错误：%s\n' "$errors_count"

printf '\n指标释义\n'
printf -- '- 当前版本：你本机 wecom-cleaner 版本。\n'
printf -- '- 最新版本：按所选通道可获取的最新可用版本。\n'
printf -- '- 用户跳过提醒：表示该版本是否被标记为“暂不提醒”。\n'
