#!/usr/bin/env bash
set -euo pipefail

PACKAGE_NAME="@mison/wecom-cleaner"
VERSION=""
DRY_RUN="false"
SYNC_SKILLS="true"

usage() {
  cat <<'USAGE'
用法：
  upgrade.sh [--version <x.y.z>] [--dry-run] [--sync-skills true|false]

说明：
  - 该脚本通过 npm 全局安装指定版本。
  - 不指定 --version 时默认安装 latest。
  - 默认会在升级后同步 Agent skills（可通过 --sync-skills false 关闭）。

示例：
  curl -fsSL https://raw.githubusercontent.com/MisonL/wecom-cleaner/main/scripts/upgrade.sh | bash -s -- --version 1.3.3
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      shift
      if [[ $# -eq 0 || "$1" == -* ]]; then
        echo "错误：--version 缺少值" >&2
        exit 1
      fi
      VERSION="$1"
      ;;
    --dry-run)
      DRY_RUN="true"
      ;;
    --sync-skills)
      shift
      if [[ $# -eq 0 || "$1" == -* ]]; then
        echo "错误：--sync-skills 缺少值（true|false）" >&2
        exit 1
      fi
      SYNC_SKILLS="$1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "错误：未知参数 $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

case "$SYNC_SKILLS" in
  true | false) ;;
  *)
    echo "错误：--sync-skills 只能是 true 或 false" >&2
    exit 1
    ;;
esac

if ! command -v npm >/dev/null 2>&1; then
  echo "错误：未检测到 npm，请先安装 Node.js/npm。" >&2
  exit 1
fi

if [[ -n "$VERSION" ]]; then
  if [[ ! "$VERSION" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
    echo "错误：版本号格式无效: $VERSION" >&2
    exit 1
  fi
  VERSION="${VERSION#v}"
  SPEC="${PACKAGE_NAME}@${VERSION}"
else
  SPEC="${PACKAGE_NAME}@latest"
fi

echo "准备升级到：$SPEC"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[dry-run] npm i -g $SPEC"
  if [[ "$SYNC_SKILLS" == "true" ]]; then
    echo "[dry-run] wecom-cleaner-skill install --force"
  fi
  exit 0
fi

npm i -g "$SPEC"
if [[ "$SYNC_SKILLS" == "true" ]]; then
  if ! command -v wecom-cleaner-skill >/dev/null 2>&1; then
    echo "错误：升级后未检测到 wecom-cleaner-skill 命令，无法同步 skills。" >&2
    exit 1
  fi
  wecom-cleaner-skill install --force
  echo "skills 同步完成。"
fi
echo "升级完成：$SPEC"
