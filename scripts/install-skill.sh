#!/usr/bin/env bash
set -euo pipefail

SKILL_NAME="wecom-cleaner-agent"
REPO_OWNER="MisonL"
REPO_NAME="wecom-cleaner"
REF="main"
FORCE="false"

if [[ -n "${CODEX_HOME:-}" ]]; then
  TARGET_ROOT="${CODEX_HOME}/skills"
else
  TARGET_ROOT="${HOME}/.codex/skills"
fi

usage() {
  cat <<'USAGE'
用法：
  install-skill.sh [--target <目录>] [--ref <git-ref>] [--force]

参数：
  --target  技能安装目录，默认 $CODEX_HOME/skills 或 ~/.codex/skills
  --ref     下载的 Git 引用，默认 main（也可传 tag，如 v1.1.0）
  --force   覆盖已存在技能目录
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      shift
      if [[ $# -eq 0 || "$1" == -* ]]; then
        echo "错误：--target 缺少目录值" >&2
        exit 1
      fi
      TARGET_ROOT="$1"
      ;;
    --ref)
      shift
      if [[ $# -eq 0 || "$1" == -* ]]; then
        echo "错误：--ref 缺少引用值" >&2
        exit 1
      fi
      REF="$1"
      ;;
    --force)
      FORCE="true"
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

# 允许传入尚不存在的目标目录，避免因父目录不存在导致 cd 失败
case "${TARGET_ROOT}" in
  "~" | "~/"*)
    TARGET_ROOT="${HOME}${TARGET_ROOT#"~"}"
    ;;
esac
TARGET_DIR="${TARGET_ROOT}/${SKILL_NAME}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

ARCHIVE_URL="https://codeload.github.com/${REPO_OWNER}/${REPO_NAME}/tar.gz/${REF}"

mkdir -p "${TARGET_ROOT}"

if [[ -e "${TARGET_DIR}" && "${FORCE}" != "true" ]]; then
  echo "错误：目标已存在 ${TARGET_DIR}，如需覆盖请加 --force" >&2
  exit 1
fi

curl -fsSL "${ARCHIVE_URL}" | tar -xz -C "${TMP_DIR}"

SOURCE_DIR="$(find "${TMP_DIR}" -type d -path "*/skills/${SKILL_NAME}" | head -n 1)"
if [[ -z "${SOURCE_DIR}" ]]; then
  echo "错误：下载内容中未找到技能目录 skills/${SKILL_NAME}" >&2
  exit 1
fi

if [[ -e "${TARGET_DIR}" ]]; then
  rm -rf "${TARGET_DIR}"
fi

cp -R "${SOURCE_DIR}" "${TARGET_DIR}"

echo "安装完成"
echo "技能: ${SKILL_NAME}"
echo "目标: ${TARGET_DIR}"
