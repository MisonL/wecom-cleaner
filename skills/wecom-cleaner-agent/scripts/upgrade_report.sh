#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
用法：
  upgrade_report.sh [--method npm|github-script] [--version <x.y.z>] [--channel stable|pre]
                    [--execute true|false] [--root <path>] [--state-root <path>]

说明：
  - 默认仅预演（--execute false），不做真实升级。
  - --execute true 时才会实际执行升级。
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

METHOD="npm"
VERSION=""
CHANNEL="stable"
EXECUTE="false"
ROOT=""
STATE_ROOT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --method | --upgrade)
      METHOD="${2:-npm}"
      shift 2
      ;;
    --version | --upgrade-version)
      VERSION="${2:-}"
      shift 2
      ;;
    --channel | --upgrade-channel)
      CHANNEL="${2:-stable}"
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

case "$METHOD" in
  npm | github-script) ;;
  *)
    echo "错误：--method 只能是 npm 或 github-script" >&2
    exit 2
    ;;
esac

case "$CHANNEL" in
  stable | pre) ;;
  *)
    echo "错误：--channel 只能是 stable 或 pre" >&2
    exit 2
    ;;
esac

case "$EXECUTE" in
  true | false) ;;
  *)
    echo "错误：--execute 只能是 true 或 false" >&2
    exit 2
    ;;
esac

CHECK_JSON="$(mktemp -t wecom-upgrade-check.XXXX.json)"
CHECK_ERR="$(mktemp -t wecom-upgrade-check.XXXX.err)"
EXEC_JSON="$(mktemp -t wecom-upgrade-exec.XXXX.json)"
EXEC_ERR="$(mktemp -t wecom-upgrade-exec.XXXX.err)"
trap 'rm -f "$CHECK_JSON" "$CHECK_ERR" "$EXEC_JSON" "$EXEC_ERR"' EXIT

check_cmd=(--check-update --output json --upgrade-channel "$CHANNEL")
if [[ -n "$ROOT" ]]; then
  check_cmd+=(--root "$ROOT")
fi
if [[ -n "$STATE_ROOT" ]]; then
  check_cmd+=(--state-root "$STATE_ROOT")
fi

check_ok="true"
if ! wecom-cleaner "${check_cmd[@]}" >"$CHECK_JSON" 2>"$CHECK_ERR"; then
  check_ok="false"
fi

has_update="false"
current_version="-"
latest_version="-"
source_used="none"
if [[ "$check_ok" == "true" ]]; then
  has_update="$(jq -r '.summary.hasUpdate // false' "$CHECK_JSON")"
  current_version="$(jq -r '.summary.currentVersion // "-"' "$CHECK_JSON")"
  latest_version="$(jq -r '.summary.latestVersion // "-"' "$CHECK_JSON")"
  source_used="$(jq -r '.summary.source // "none"' "$CHECK_JSON")"
fi

plan_target="$VERSION"
if [[ -z "$plan_target" && "$check_ok" == "true" && "$latest_version" != "-" ]]; then
  plan_target="$latest_version"
fi

plan_cmd=(wecom-cleaner --upgrade "$METHOD")
if [[ -n "$plan_target" ]]; then
  plan_cmd+=(--upgrade-version "$plan_target")
fi
plan_cmd+=(--upgrade-channel "$CHANNEL" --upgrade-yes)
if [[ -n "$ROOT" ]]; then
  plan_cmd+=(--root "$ROOT")
fi
if [[ -n "$STATE_ROOT" ]]; then
  plan_cmd+=(--state-root "$STATE_ROOT")
fi
plan_cmd+=(--output json)

if [[ "$EXECUTE" != "true" ]]; then
  printf '\n=== 程序升级预演结果（给用户）===\n'
  if [[ "$check_ok" == "true" ]]; then
    printf -- '- 执行结论：仅预演，未执行真实升级。\n'
    if [[ "$has_update" == "true" ]]; then
      printf -- '- 检查结果：检测到新版本（当前 %s，最新 %s）。\n' "$current_version" "$latest_version"
    else
      printf -- '- 检查结果：当前已是最新版本（%s）。\n' "$current_version"
    fi
    printf -- '- 信息来源：%s（先 npm，失败再回退 GitHub）。\n' "$source_used"
  else
    err_head="$(head -n 3 "$CHECK_ERR" 2>/dev/null || true)"
    echo "执行失败：${err_head:-未知错误}" >&2
    printf -- '- 执行结论：更新检查失败，未进入升级预演。\n'
    printf -- '- 检查结果：%s\n' "${err_head:-未知错误}"
    exit 1
  fi
  printf -- '- 升级方式：%s\n' "$METHOD"
  printf -- '- 计划目标版本：%s\n' "${plan_target:--}"
  printf -- '- 计划执行命令：%s\n' "${plan_cmd[*]}"
  printf '\n说明\n'
  printf -- '- 如需真实执行，请追加参数：--execute true\n'
  printf -- '- 升级会更新本机安装，不会触碰聊天缓存数据。\n'
  exit 0
fi

upgrade_cmd=(--upgrade "$METHOD" --upgrade-channel "$CHANNEL" --upgrade-yes --output json)
if [[ -n "$VERSION" ]]; then
  upgrade_cmd+=(--upgrade-version "$VERSION")
fi
if [[ -n "$ROOT" ]]; then
  upgrade_cmd+=(--root "$ROOT")
fi
if [[ -n "$STATE_ROOT" ]]; then
  upgrade_cmd+=(--state-root "$STATE_ROOT")
fi

upgrade_ok="true"
if ! wecom-cleaner "${upgrade_cmd[@]}" >"$EXEC_JSON" 2>"$EXEC_ERR"; then
  upgrade_ok="false"
fi

if ! jq -e . >/dev/null 2>&1 <"$EXEC_JSON"; then
  err_head="$(head -n 3 "$EXEC_ERR" 2>/dev/null || true)"
  echo "执行失败：${err_head:-未知错误}" >&2
  exit 1
fi

summary_executed="$(jq -r '.summary.executed // false' "$EXEC_JSON")"
summary_method="$(jq -r '.summary.method // "-"' "$EXEC_JSON")"
summary_target="$(jq -r '.summary.targetVersion // "-"' "$EXEC_JSON")"
summary_status="$(jq -r '.summary.status // "-"' "$EXEC_JSON")"
summary_command="$(jq -r '.summary.command // "-"' "$EXEC_JSON")"
duration_ms="$(jq -r '.meta.durationMs // 0' "$EXEC_JSON")"
warnings_count="$(jq -r '(.warnings // []) | length' "$EXEC_JSON")"
errors_count="$(jq -r '(.errors // []) | length' "$EXEC_JSON")"

installed_version="$(wecom-cleaner --version 2>/dev/null || true)"
if [[ -z "$installed_version" ]]; then
  installed_version="-"
fi

printf '\n=== 程序升级结果（给用户）===\n'
if [[ "$upgrade_ok" == "true" ]]; then
  printf -- '- 执行结论：升级流程已完成。\n'
else
  printf -- '- 执行结论：升级执行失败，请按错误信息排查。\n'
fi

printf '\n执行信息\n'
printf -- '- 升级方式：%s\n' "$summary_method"
printf -- '- 目标版本：%s\n' "$summary_target"
printf -- '- 是否执行升级：%s\n' "$( [[ "$summary_executed" == "true" ]] && printf '是' || printf '否' )"
printf -- '- 命令退出码：%s\n' "$summary_status"
printf -- '- 执行命令：%s\n' "$summary_command"
printf -- '- 升级后版本：%s\n' "$installed_version"

if [[ "$errors_count" -gt 0 ]]; then
  printf '\n错误摘要\n'
  while IFS= read -r message; do
    [[ -z "${message:-}" ]] && continue
    printf -- '- %s\n' "$message"
  done < <(jq -r '.errors // [] | .[] | .message // ""' "$EXEC_JSON")
fi

printf '\n运行状态\n'
printf -- '- 耗时：%s ms\n' "$duration_ms"
printf -- '- 告警：%s\n' "$warnings_count"
printf -- '- 错误：%s\n' "$errors_count"

printf '\n指标释义\n'
printf -- '- 目标版本：本次升级计划安装的版本。\n'
printf -- '- 升级后版本：命令执行后本机实际返回的版本号。\n'
printf -- '- 命令退出码：0 表示升级命令执行成功，非 0 表示执行失败。\n'

if [[ "$upgrade_ok" != "true" ]]; then
  exit 1
fi
