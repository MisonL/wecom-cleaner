#!/usr/bin/env bash
set -euo pipefail

PACKAGE_NAME="@mison/wecom-cleaner"
VERSION=""
DRY_RUN="false"

usage() {
  cat <<'USAGE'
用法：
  upgrade.sh [--version <x.y.z>] [--dry-run]

说明：
  - 该脚本通过 npm 全局安装指定版本。
  - 不指定 --version 时默认安装 latest。

示例：
  curl -fsSL https://raw.githubusercontent.com/MisonL/wecom-cleaner/main/scripts/upgrade.sh | bash -s -- --version 1.3.0
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
  exit 0
fi

npm i -g "$SPEC"
echo "升级完成：$SPEC"
