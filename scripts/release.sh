#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

VERSION=""
NOTES_FILE=""
SKIP_GATE="false"
SKIP_NPM="false"
SKIP_GITHUB="false"
DRY_RUN="false"
PUBLISH_TAG="latest"

usage() {
  cat <<'USAGE'
用法：
  release.sh [--version <x.y.z>] [--notes-file <path>] [--dry-run]
             [--skip-gate] [--skip-npm] [--skip-github]

说明：
  - 一键执行发布流程：门禁 -> 产物打包 -> 推送主分支与标签 -> npm 发布 -> GitHub Release。
  - 默认使用 package.json 的版本号；可通过 --version 覆盖（会校验与 package.json 一致）。
  - GitHub Release 附件默认使用：
      dist/release/wecom-cleaner-core-vX.Y.Z-darwin-x64
      dist/release/wecom-cleaner-core-vX.Y.Z-darwin-arm64
      dist/release/wecom-cleaner-skill-vX.Y.Z.tar.gz
      dist/release/wecom-cleaner-vX.Y.Z-SHA256SUMS.txt
  - --dry-run 仅输出将执行的命令，不做真实发布。

参数：
  --version      指定发布版本（如 1.3.3）
  --notes-file   指定 GitHub Release 说明文件（默认 docs/releases/vX.Y.Z.md）
  --skip-gate    跳过 npm run release:gate（不推荐）
  --skip-npm     跳过 npm publish
  --skip-github  跳过 gh release create/upload
  --dry-run      仅预演
USAGE
}

run_cmd() {
  if [[ "$DRY_RUN" == "true" ]]; then
    printf '[dry-run]'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

run_step() {
  local title="$1"
  shift
  echo
  echo "==> ${title}"
  run_cmd "$@"
}

ensure_cmd() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "错误：缺少命令 $name" >&2
    exit 1
  fi
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
    --notes-file)
      shift
      if [[ $# -eq 0 || "$1" == -* ]]; then
        echo "错误：--notes-file 缺少值" >&2
        exit 1
      fi
      NOTES_FILE="$1"
      ;;
    --skip-gate)
      SKIP_GATE="true"
      ;;
    --skip-npm)
      SKIP_NPM="true"
      ;;
    --skip-github)
      SKIP_GITHUB="true"
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

ensure_cmd git
ensure_cmd npm
ensure_cmd node

PACKAGE_NAME="$(node -p "JSON.parse(require('fs').readFileSync('package.json', 'utf8')).name")"
PACKAGE_VERSION="$(node -p "JSON.parse(require('fs').readFileSync('package.json', 'utf8')).version")"
VERSION="${VERSION#v}"
if [[ -z "$VERSION" ]]; then
  VERSION="$PACKAGE_VERSION"
fi

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "错误：版本格式非法: $VERSION" >&2
  exit 1
fi
if [[ "$VERSION" != "$PACKAGE_VERSION" ]]; then
  echo "错误：--version($VERSION) 与 package.json($PACKAGE_VERSION) 不一致，请先完成版本收口。" >&2
  exit 1
fi

TAG="v${VERSION}"
if [[ -z "$NOTES_FILE" ]]; then
  NOTES_FILE="docs/releases/${TAG}.md"
fi

ASSET_DIR="dist/release"
ASSET_X64="${ASSET_DIR}/wecom-cleaner-core-${TAG}-darwin-x64"
ASSET_ARM64="${ASSET_DIR}/wecom-cleaner-core-${TAG}-darwin-arm64"
ASSET_SKILL="${ASSET_DIR}/wecom-cleaner-skill-${TAG}.tar.gz"
ASSET_SUMS="${ASSET_DIR}/wecom-cleaner-${TAG}-SHA256SUMS.txt"
ASSETS=("$ASSET_X64" "$ASSET_ARM64" "$ASSET_SKILL" "$ASSET_SUMS")

if [[ "$DRY_RUN" != "true" ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "错误：工作区存在未提交改动，请先提交后再发布。" >&2
    git status --short >&2
    exit 1
  fi
fi

if [[ "$SKIP_GATE" != "true" ]]; then
  run_step "发布门禁" npm run release:gate
else
  echo "已跳过发布门禁（--skip-gate）"
fi

if [[ "$DRY_RUN" == "true" ]]; then
  run_step "发布资产预演" npm run pack:release-assets:dry-run
else
  run_step "生成发布资产" npm run pack:release-assets
fi

if [[ "$DRY_RUN" != "true" ]]; then
  for asset in "${ASSETS[@]}"; do
    if [[ ! -f "$asset" ]]; then
      echo "错误：缺少发布附件 $asset" >&2
      exit 1
    fi
  done
fi

if git rev-parse "$TAG" >/dev/null 2>&1; then
  TAG_COMMIT="$(git rev-list -n 1 "$TAG")"
  HEAD_COMMIT="$(git rev-parse HEAD)"
  if [[ "$TAG_COMMIT" != "$HEAD_COMMIT" ]]; then
    echo "错误：标签 $TAG 已存在且不指向当前提交($HEAD_COMMIT)。" >&2
    exit 1
  fi
  echo "标签已存在并指向当前提交：$TAG"
else
  run_step "创建标签" git tag -a "$TAG" -m "$TAG"
fi

run_step "推送主分支" git push origin main
run_step "推送标签" git push origin "$TAG"

if [[ "$SKIP_NPM" != "true" ]]; then
  EXIST_VERSION="$(npm view "${PACKAGE_NAME}@${VERSION}" version 2>/dev/null || true)"
  if [[ "$EXIST_VERSION" == "$VERSION" ]]; then
    echo "npm 已存在 ${PACKAGE_NAME}@${VERSION}，跳过发布。"
  else
    run_step "发布 npm" npm publish --access public --tag "$PUBLISH_TAG"
  fi
else
  echo "已跳过 npm 发布（--skip-npm）"
fi

if [[ "$SKIP_GITHUB" != "true" ]]; then
  ensure_cmd gh
  if [[ "$DRY_RUN" != "true" && ! -f "$NOTES_FILE" ]]; then
    echo "错误：未找到 Release 说明文件: $NOTES_FILE" >&2
    exit 1
  fi
  if gh release view "$TAG" >/dev/null 2>&1; then
    run_step "上传/覆盖 GitHub Release 附件" gh release upload "$TAG" "${ASSETS[@]}" --clobber
  else
    run_step "创建 GitHub Release" gh release create "$TAG" \
      --title "$TAG" \
      --notes-file "$NOTES_FILE" \
      "${ASSETS[@]}"
  fi
else
  echo "已跳过 GitHub Release（--skip-github）"
fi

echo
echo "发布流程完成：${TAG}"
