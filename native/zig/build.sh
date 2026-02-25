#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

HOST_OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
HOST_ARCH="$(uname -m)"

RAW_OS="${TARGET_OS:-$HOST_OS}"
RAW_ARCH="${TARGET_ARCH:-$HOST_ARCH}"

case "$RAW_OS" in
  darwin|macos)
    OS_TAG="darwin"
    ZIG_OS="macos"
    ;;
  linux)
    OS_TAG="linux"
    ZIG_OS="linux"
    ;;
  windows|windows_nt|mingw*|msys*|cygwin*)
    OS_TAG="windows"
    ZIG_OS="windows"
    ;;
  *)
    echo "不支持的操作系统: $RAW_OS" >&2
    exit 1
    ;;
esac

case "$RAW_ARCH" in
  x86_64|amd64|x64)
    ARCH_TAG="x64"
    ZIG_ARCH="x86_64"
    ;;
  arm64|aarch64)
    ARCH_TAG="arm64"
    ZIG_ARCH="aarch64"
    ;;
  *)
    echo "不支持的架构: $RAW_ARCH" >&2
    exit 1
    ;;
esac

OUT_DIR="$ROOT_DIR/native/bin/${OS_TAG}-${ARCH_TAG}"
mkdir -p "$OUT_DIR"

BIN_NAME="wecom-cleaner-core"
if [[ "$OS_TAG" == "windows" ]]; then
  BIN_NAME="${BIN_NAME}.exe"
fi

declare -a BUILD_CMD
BUILD_CMD=(
  zig build-exe "$ROOT_DIR/native/zig/src/main.zig"
  -O ReleaseFast
  -fstrip
  -femit-bin="$OUT_DIR/$BIN_NAME"
)

if [[ -n "${TARGET_OS:-}" || -n "${TARGET_ARCH:-}" ]]; then
  BUILD_CMD+=(-target "${ZIG_ARCH}-${ZIG_OS}")
fi

"${BUILD_CMD[@]}"

echo "构建完成: $OUT_DIR/$BIN_NAME"
