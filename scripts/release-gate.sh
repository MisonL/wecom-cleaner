#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

run_step() {
  local name="$1"
  local cmd="$2"
  echo
  echo "==> [GATE] $name"
  if bash -lc "$cmd"; then
    echo "[PASS] $name"
    return
  fi
  echo "[FAIL] $name"
  exit 1
}

run_step "format:check" "npm run format:check"
run_step "check" "npm run check"
run_step "test:coverage:check" "npm run test:coverage:check"
run_step "shellcheck(skills)" "shellcheck skills/wecom-cleaner-agent/scripts/*.sh scripts/upgrade.sh scripts/install-skill.sh scripts/release-gate.sh"
run_step "e2e:smoke" "npm run e2e:smoke"
run_step "pack:tgz:dry-run" "npm run pack:tgz:dry-run"
run_step "pack:release-assets:dry-run" "npm run pack:release-assets:dry-run"

echo
echo "所有发布门禁已通过。"
