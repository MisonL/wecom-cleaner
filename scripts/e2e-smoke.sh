#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

KEEP_ARTIFACTS=0
if [[ "${1:-}" == "--keep" ]]; then
  KEEP_ARTIFACTS=1
  shift
fi

if ! command -v expect >/dev/null 2>&1; then
  echo "缺少 expect，无法执行交互 smoke。请先安装 expect。"
  exit 2
fi

BASE_DIR_AUTO_CREATED=0
if [[ -n "${WECOM_CLEANER_E2E_BASE:-}" ]]; then
  BASE_DIR="${WECOM_CLEANER_E2E_BASE}"
else
  BASE_DIR="$(mktemp -d /tmp/wecom-e2e-XXXXXX)"
  BASE_DIR_AUTO_CREATED=1
fi
DATA_ROOT="$BASE_DIR/ContainerData"
PROFILE_ROOT="$DATA_ROOT/Documents/Profiles"
DOCS_ROOT="$DATA_ROOT/Documents"
STATE_ROOT="$BASE_DIR/state"
EXTERNAL_ROOT="$BASE_DIR/ExternalCustom/WXWork_Data_Custom"
LOG_DIR="$BASE_DIR/logs"
SPECS_DIR="$BASE_DIR/specs"
EMPTY_STATE="$BASE_DIR/state-empty"
UI_STATE="$BASE_DIR/state-restore-ui"
UI_CONFLICT_SKIP_STATE="$BASE_DIR/state-restore-ui-conflict-skip"
UI_CONFLICT_OVERWRITE_STATE="$BASE_DIR/state-restore-ui-conflict-overwrite"
UI_CONFLICT_RENAME_STATE="$BASE_DIR/state-restore-ui-conflict-rename"

export E2E_BASE="$BASE_DIR"
export E2E_DATA_ROOT="$DATA_ROOT"
export E2E_PROFILE_ROOT="$PROFILE_ROOT"
export E2E_STATE_ROOT="$STATE_ROOT"
export E2E_EXTERNAL_ROOT="$EXTERNAL_ROOT"
export E2E_UI_STATE_ROOT="$UI_STATE"
export WECOM_CLEANER_AUTO_UPDATE="false"

cleanup() {
  if [[ "$KEEP_ARTIFACTS" -eq 1 ]]; then
    echo "已保留测试目录: $BASE_DIR"
    return
  fi
  if [[ "$BASE_DIR_AUTO_CREATED" -ne 1 ]]; then
    echo "已保留测试目录(外部指定，不自动删除): $BASE_DIR"
    return
  fi
  if [[ "$BASE_DIR" != /tmp/wecom-e2e-* ]]; then
    echo "跳过删除：目录不在安全范围内: $BASE_DIR"
    return
  fi
  rm -rf "$BASE_DIR"
}
trap cleanup EXIT

pass() {
  echo "[PASS] $1"
}

fail() {
  local name="$1"
  local log_path="${2:-}"
  local context="${3:-}"
  echo "[FAIL] $name"
  if [[ -n "$context" ]]; then
    echo "上下文: $context"
  fi
  if [[ -n "$log_path" && -f "$log_path" ]]; then
    echo "日志: $log_path"
    tail -n 80 "$log_path" || true
  fi
  exit 1
}

clear_e2e_locks() {
  if [[ -d "$BASE_DIR" ]]; then
    find "$BASE_DIR" -type f -name ".wecom-cleaner.lock" -delete 2>/dev/null || true
  fi
}

run_expect() {
  local name="$1"
  local script_path="$2"
  shift 2
  local args=("$@")
  local log_path=""
  if [[ "${#args[@]}" -gt 0 ]]; then
    log_path="${args[${#args[@]}-1]}"
  fi
  clear_e2e_locks
  if "$script_path" "${args[@]}"; then
    pass "$name"
    return
  fi
  fail "$name" "$log_path" "expect脚本: $script_path"
}

prepare_fixture() {
  mkdir -p "$PROFILE_ROOT" "$STATE_ROOT" "$EXTERNAL_ROOT" "$LOG_DIR" "$SPECS_DIR" "$EMPTY_STATE" "$UI_STATE"

  for account_id in acc001 acc002; do
    local account_path="$PROFILE_ROOT/$account_id"
    mkdir -p \
      "$account_path/Caches/Images/2023-01" \
      "$account_path/Caches/Images/2025-12" \
      "$account_path/Caches/Images/temp-nonmonth" \
      "$account_path/Caches/Videos/2023-01" \
      "$account_path/Caches/Files/2023-01" \
      "$account_path/Caches/Voices/2023-01" \
      "$account_path/Caches/Emotions/2023-01" \
      "$account_path/Caches/Emotion_Thumbnail/2023-01" \
      "$account_path/Caches/Video_Thumbnail/2023-01" \
      "$account_path/Caches/Link_Thumbnail/2023-01" \
      "$account_path/Caches/wwsecurity/slotA/deep1" \
      "$account_path/Caches/wwsecurity/slotB" \
      "$account_path/SecSdk/tmp" \
      "$account_path/sqlite_temp_dir" \
      "$account_path/Publishsys/pkg" \
      "$account_path/VOIP"

    printf '{"user_info":"%s","corp_info":"%s"}\n' '5L2g5aW9PGJvc3MxQGV4YW1wbGUuY29tPg==' '5LyB5LiaQQ==' > "$account_path/io_data.json"

    dd if=/dev/zero of="$account_path/Caches/Images/2023-01/img.bin" bs=1024 count=4 >/dev/null 2>&1
    dd if=/dev/zero of="$account_path/Caches/Images/temp-nonmonth/raw.bin" bs=1024 count=2 >/dev/null 2>&1
    dd if=/dev/zero of="$account_path/Caches/Images/direct-file.dat" bs=1024 count=1 >/dev/null 2>&1
    dd if=/dev/zero of="$account_path/Publishsys/pkg/chunk.bin" bs=1024 count=3 >/dev/null 2>&1
    dd if=/dev/zero of="$account_path/SecSdk/tmp/tmp.bin" bs=1024 count=1 >/dev/null 2>&1
    dd if=/dev/zero of="$account_path/VOIP/voip.bin" bs=1024 count=1 >/dev/null 2>&1

    touch -t 202402010101 "$account_path/SecSdk/tmp"
    touch -t 202402010101 "$account_path/Publishsys/pkg"
    touch -t 202602250101 "$account_path/VOIP"
  done

  cat > "$PROFILE_ROOT/setting.json" <<'JSON'
{"CurrentProfile":"acc001"}
JSON

  mkdir -p \
    "$DATA_ROOT/Library/Application Support/WXWork/Temp/ScreenCapture" \
    "$DATA_ROOT/Library/Application Support/WXWork/Temp/wetype/realPic" \
    "$DATA_ROOT/Library/Application Support/WXWork/Temp/FtnLocalCache" \
    "$DATA_ROOT/Library/Application Support/WXWork/Temp/Voip" \
    "$DATA_ROOT/tmp" \
    "$DATA_ROOT/Documents/log" \
    "$DATA_ROOT/Documents/GYLog" \
    "$DATA_ROOT/Documents/GYOssLog" \
    "$DATA_ROOT/Documents/UserAvatarUrl" \
    "$DATA_ROOT/Library/Application Support/WXWork/Log" \
    "$DATA_ROOT/WeDrive/.Temp" \
    "$DATA_ROOT/WeDrive/.C2CUploadTemp" \
    "$DATA_ROOT/WeDrive/.WeDriveTrash-abc" \
    "$DATA_ROOT/Library/WebKit/com.tencent.WeWorkMac/WebsiteData/LocalStorage" \
    "$DATA_ROOT/Library/Caches/com.tencent.WeWorkMac"

  mkdir -p "$DATA_ROOT/Documents/WXWork Files/Caches/Images/2023-01"
  mkdir -p "$DATA_ROOT/Documents/WXWork Files/Caches/Files/2023-01"
  dd if=/dev/zero of="$DATA_ROOT/Documents/WXWork Files/Caches/Images/2023-01/extimg.bin" bs=1024 count=4 >/dev/null 2>&1

  mkdir -p "$EXTERNAL_ROOT/WXWork Files/Caches/Images/2023-01"
  mkdir -p "$EXTERNAL_ROOT/WXWork Files/Caches/Files/2023-01"
  mkdir -p "$EXTERNAL_ROOT/WXWork Files/Caches/Videos/2023-01"
  dd if=/dev/zero of="$EXTERNAL_ROOT/WXWork Files/Caches/Files/2023-01/file.bin" bs=1024 count=3 >/dev/null 2>&1

  pass "fixture_ready"
}

write_specs() {
  cat > "$SPECS_DIR/start_menu.expect" <<'EOF'
#!/usr/bin/expect -f
set timeout 40
set root [lindex $argv 0]
set state [lindex $argv 1]
set ext [lindex $argv 2]
set logfile [lindex $argv 3]
log_user 0
log_file -noappend $logfile
spawn node src/cli.js --interactive --root $root --state-root $state --external-storage-root $ext --external-storage-auto-detect false
expect "开始菜单"
send "\033\[B\033\[B\033\[B\033\[B\033\[B\033\[B\033\[B\033\[B\033\[B\r"
expect {
  "已退出。" { exit 0 }
  timeout { exit 11 }
}
EOF

  cat > "$SPECS_DIR/cleanup_dry.expect" <<'EOF'
#!/usr/bin/expect -f
set timeout 80
set root [lindex $argv 0]
set state [lindex $argv 1]
set ext [lindex $argv 2]
set logfile [lindex $argv 3]
log_user 0
log_file -noappend $logfile
spawn node src/cli.js --interactive --mode cleanup_monthly --root $root --state-root $state --external-storage-root $ext --external-storage-auto-detect false
expect "请选择要处理的账号"
send "\r"
expect "检测到文件存储目录"
send "\r"
expect "请选择筛选方式"
send "\r"
expect "请输入截止年月"
send "\r"
expect "是否手动微调月份列表"
send "\r"
expect "选择要清理的缓存类型"
send "\r"
expect "是否包含非月份目录"
send "y\r"
expect "先 dry-run 预览"
send "\r"
expect "是否继续执行真实删除"
send "\r"
expect {
  "已结束：仅预览，无删除。" { exit 0 }
  timeout { exit 21 }
}
EOF

  cat > "$SPECS_DIR/cleanup_real.expect" <<'EOF'
#!/usr/bin/expect -f
set timeout 120
set root [lindex $argv 0]
set state [lindex $argv 1]
set ext [lindex $argv 2]
set logfile [lindex $argv 3]
log_user 0
log_file -noappend $logfile
spawn node src/cli.js --interactive --mode cleanup_monthly --root $root --state-root $state --external-storage-root $ext --external-storage-auto-detect false
expect "请选择要处理的账号"
send "\r"
expect "检测到文件存储目录"
send "\r"
expect "请选择筛选方式"
send "\r"
expect "请输入截止年月"
send "\r"
expect "是否手动微调月份列表"
send "\r"
expect "选择要清理的缓存类型"
send "\r"
expect "是否包含非月份目录"
send "y\r"
expect "先 dry-run 预览"
send "n\r"
expect "请输入 DELETE 确认"
send "DELETE\r"
expect {
  "=== 删除结果 ===" {}
  timeout { exit 31 }
}
exit 0
EOF

  cat > "$SPECS_DIR/analysis.expect" <<'EOF'
#!/usr/bin/expect -f
set timeout 70
set root [lindex $argv 0]
set state [lindex $argv 1]
set ext [lindex $argv 2]
set logfile [lindex $argv 3]
log_user 0
log_file -noappend $logfile
spawn node src/cli.js --interactive --mode analysis_only --root $root --state-root $state --external-storage-root $ext --external-storage-auto-detect false
expect "请选择要处理的账号"
send "\r"
expect "检测到文件存储目录"
send "\r"
expect "选择分析范围"
send "\r"
expect {
  "=== 分析结果（只读） ===" { exit 0 }
  timeout { exit 41 }
}
EOF

  cat > "$SPECS_DIR/governance.expect" <<'EOF'
#!/usr/bin/expect -f
set timeout 140
set root [lindex $argv 0]
set state [lindex $argv 1]
set ext [lindex $argv 2]
set logfile [lindex $argv 3]
log_user 0
log_file -noappend $logfile
spawn node src/cli.js --interactive --mode space_governance --root $root --state-root $state --external-storage-root $ext --external-storage-auto-detect false
expect "请选择要处理的账号"
send "\r"
expect "检测到文件存储目录"
send "\r"
expect "选择要治理的目录"
send "a\r"
expect "已选择谨慎层目录"
send "y\r"
expect "默认会跳过"
send "y\r"
expect "先 dry-run 预览"
send "\r"
expect {
  "=== 治理结果 ===" {}
  timeout { exit 51 }
}
exit 0
EOF

  cat > "$SPECS_DIR/restore_ui.expect" <<'EOF'
#!/usr/bin/expect -f
set timeout 70
set root [lindex $argv 0]
set state [lindex $argv 1]
set ext [lindex $argv 2]
set logfile [lindex $argv 3]
log_user 0
log_file -noappend $logfile
spawn node src/cli.js --interactive --mode restore --root $root --state-root $state --external-storage-root $ext --external-storage-auto-detect false
expect "请选择要恢复的批次"
send "\r"
expect "确认恢复批次"
send "y\r"
expect "先 dry-run 预演恢复"
send "n\r"
expect {
  "=== 恢复结果 ===" {}
  timeout { exit 61 }
}
expect {
  -re {成功数量\s*[:：]\s*1} { exit 0 }
  timeout { exit 62 }
  }
EOF

  cat > "$SPECS_DIR/restore_ui_conflict_skip.expect" <<'EOF'
#!/usr/bin/expect -f
set timeout 90
set root [lindex $argv 0]
set state [lindex $argv 1]
set ext [lindex $argv 2]
set logfile [lindex $argv 3]
log_user 0
log_file -noappend $logfile
spawn node src/cli.js --interactive --mode restore --root $root --state-root $state --external-storage-root $ext --external-storage-auto-detect false
expect "请选择要恢复的批次"
send "\r"
expect "确认恢复批次"
send "y\r"
expect "先 dry-run 预演恢复"
send "n\r"
expect "请选择冲突处理策略"
send "\r"
expect "后续冲突是否沿用同一策略"
send "n\r"
expect {
  "=== 恢复结果 ===" {}
  timeout { exit 63 }
}
expect {
  -re {跳过数量\s*[:：]\s*1} { exit 0 }
  timeout { exit 64 }
}
EOF

  cat > "$SPECS_DIR/restore_ui_conflict_overwrite.expect" <<'EOF'
#!/usr/bin/expect -f
set timeout 90
set root [lindex $argv 0]
set state [lindex $argv 1]
set ext [lindex $argv 2]
set logfile [lindex $argv 3]
log_user 0
log_file -noappend $logfile
spawn node src/cli.js --interactive --mode restore --root $root --state-root $state --external-storage-root $ext --external-storage-auto-detect false
expect "请选择要恢复的批次"
send "\r"
expect "确认恢复批次"
send "y\r"
expect "先 dry-run 预演恢复"
send "n\r"
expect "请选择冲突处理策略"
send "\033\[B\r"
expect "后续冲突是否沿用同一策略"
send "n\r"
expect {
  "=== 恢复结果 ===" {}
  timeout { exit 65 }
}
expect {
  -re {成功数量\s*[:：]\s*1} { exit 0 }
  timeout { exit 66 }
}
EOF

  cat > "$SPECS_DIR/restore_ui_conflict_rename.expect" <<'EOF'
#!/usr/bin/expect -f
set timeout 90
set root [lindex $argv 0]
set state [lindex $argv 1]
set ext [lindex $argv 2]
set logfile [lindex $argv 3]
log_user 0
log_file -noappend $logfile
spawn node src/cli.js --interactive --mode restore --root $root --state-root $state --external-storage-root $ext --external-storage-auto-detect false
expect "请选择要恢复的批次"
send "\r"
expect "确认恢复批次"
send "y\r"
expect "先 dry-run 预演恢复"
send "n\r"
expect "请选择冲突处理策略"
send "\033\[B\033\[B\r"
expect "后续冲突是否沿用同一策略"
send "n\r"
expect {
  "=== 恢复结果 ===" {}
  timeout { exit 67 }
}
expect {
  -re {成功数量\s*[:：]\s*1} { exit 0 }
  timeout { exit 68 }
}
EOF

  cat > "$SPECS_DIR/settings_root.expect" <<'EOF'
#!/usr/bin/expect -f
set timeout 70
set root [lindex $argv 0]
set state [lindex $argv 1]
set ext [lindex $argv 2]
set logfile [lindex $argv 3]
log_user 0
log_file -noappend $logfile
spawn node src/cli.js --interactive --mode settings --root $root --state-root $state --external-storage-root $ext --external-storage-auto-detect false
expect "选择要调整的配置项"
send "\r"
expect "输入新的 Profile 根目录"
send "$root\r"
expect "已保存根目录配置。"
send "\003"
expect {
  "已取消。" { exit 0 }
  timeout { exit 75 }
}
EOF

  cat > "$SPECS_DIR/settings_external_roots.expect" <<'EOF'
#!/usr/bin/expect -f
set timeout 70
set root [lindex $argv 0]
set state [lindex $argv 1]
set ext [lindex $argv 2]
set docs [lindex $argv 3]
set logfile [lindex $argv 4]
log_user 0
log_file -noappend $logfile
spawn node src/cli.js --interactive --mode settings --root $root --state-root $state --external-storage-root $ext --external-storage-auto-detect false
expect "选择要调整的配置项"
send "\033\[B\r"
expect "输入手动追加的文件存储根目录"
send "$ext,$docs\r"
expect "已保存手动文件存储根目录配置。"
send "\003"
expect {
  "已取消。" { exit 0 }
  timeout { exit 76 }
}
EOF

  cat > "$SPECS_DIR/settings_recycle.expect" <<'EOF'
#!/usr/bin/expect -f
set timeout 70
set root [lindex $argv 0]
set state [lindex $argv 1]
set ext [lindex $argv 2]
set recycle [lindex $argv 3]
set logfile [lindex $argv 4]
log_user 0
log_file -noappend $logfile
spawn node src/cli.js --interactive --mode settings --root $root --state-root $state --external-storage-root $ext --external-storage-auto-detect false
expect "选择要调整的配置项"
send "\033\[B\033\[B\033\[B\r"
expect "输入新的回收区目录"
send "$recycle\r"
expect "已保存回收区配置。"
send "\003"
expect {
  "已取消。" { exit 0 }
  timeout { exit 77 }
}
EOF

  cat > "$SPECS_DIR/settings_suggest.expect" <<'EOF'
#!/usr/bin/expect -f
set timeout 70
set root [lindex $argv 0]
set state [lindex $argv 1]
set ext [lindex $argv 2]
set logfile [lindex $argv 3]
log_user 0
log_file -noappend $logfile
spawn node src/cli.js --interactive --mode settings --root $root --state-root $state --external-storage-root $ext --external-storage-auto-detect false
expect "选择要调整的配置项"
send "\033\[B\033\[B\033\[B\033\[B\033\[B\r"
expect "输入建议体积阈值"
send "8\r"
expect "输入建议静置天数"
send "2\r"
expect "已保存全量治理建议阈值。"
send "\003"
expect {
  "已取消。" { exit 0 }
  timeout { exit 78 }
}
EOF

  cat > "$SPECS_DIR/settings_cooldown.expect" <<'EOF'
#!/usr/bin/expect -f
set timeout 70
set root [lindex $argv 0]
set state [lindex $argv 1]
set ext [lindex $argv 2]
set logfile [lindex $argv 3]
log_user 0
log_file -noappend $logfile
spawn node src/cli.js --interactive --mode settings --root $root --state-root $state --external-storage-root $ext --external-storage-auto-detect false
expect "选择要调整的配置项"
send "\033\[B\033\[B\033\[B\033\[B\033\[B\033\[B\r"
expect "输入冷静期秒数"
send "3\r"
expect "已保存全量治理冷静期。"
send "\003"
expect {
  "已取消。" { exit 0 }
  timeout { exit 79 }
}
EOF

  cat > "$SPECS_DIR/settings_auto_detect.expect" <<'EOF'
#!/usr/bin/expect -f
set timeout 60
set root [lindex $argv 0]
set state [lindex $argv 1]
set ext [lindex $argv 2]
set logfile [lindex $argv 3]
log_user 0
log_file -noappend $logfile
spawn node src/cli.js --interactive --mode settings --root $root --state-root $state --external-storage-root $ext --external-storage-auto-detect false
expect "选择要调整的配置项"
send "\033\[B\033\[B\r"
expect "是否启用外部存储自动探测"
send "n\r"
expect "已保存外部存储自动探测：关闭。"
send "\003"
expect {
  "已取消。" { exit 0 }
  timeout { exit 71 }
}
EOF

  cat > "$SPECS_DIR/settings_dryrun.expect" <<'EOF'
#!/usr/bin/expect -f
set timeout 60
set root [lindex $argv 0]
set state [lindex $argv 1]
set ext [lindex $argv 2]
set logfile [lindex $argv 3]
log_user 0
log_file -noappend $logfile
spawn node src/cli.js --interactive --mode settings --root $root --state-root $state --external-storage-root $ext --external-storage-auto-detect false
expect "选择要调整的配置项"
send "\033\[B\033\[B\033\[B\033\[B\r"
expect "默认是否启用 dry-run"
send "n\r"
expect "已保存 dry-run 默认值。"
send "\003"
expect {
  "已取消。" { exit 0 }
  timeout { exit 72 }
}
EOF

  cat > "$SPECS_DIR/settings_theme.expect" <<'EOF'
#!/usr/bin/expect -f
set timeout 70
set root [lindex $argv 0]
set state [lindex $argv 1]
set ext [lindex $argv 2]
set logfile [lindex $argv 3]
log_user 0
log_file -noappend $logfile
spawn node src/cli.js --interactive --mode settings --root $root --state-root $state --external-storage-root $ext --external-storage-auto-detect false
expect "选择要调整的配置项"
send "\033\[B\033\[B\033\[B\033\[B\033\[B\033\[B\033\[B\r"
expect "选择 Logo 主题"
send "\033\[B\r"
expect "已保存 Logo 主题：亮色。"
send "\003"
expect {
  "已取消。" { exit 0 }
  timeout { exit 73 }
}
EOF

  cat > "$SPECS_DIR/settings_alias.expect" <<'EOF'
#!/usr/bin/expect -f
set timeout 80
set root [lindex $argv 0]
set state [lindex $argv 1]
set ext [lindex $argv 2]
set logfile [lindex $argv 3]
log_user 0
log_file -noappend $logfile
spawn node src/cli.js --interactive --mode settings --root $root --state-root $state --external-storage-root $ext --external-storage-auto-detect false
expect "选择要调整的配置项"
send "\033\[B\033\[B\033\[B\033\[B\033\[B\033\[B\033\[B\033\[B\r"
expect "选择要修改别名的账号"
send "\r"
expect "用户名别名"
send "测试用户E2E\r"
expect "企业名别名"
send "测试企业E2E\r"
expect "已保存账号别名。"
send "\003"
expect {
  "已取消。" { exit 0 }
  timeout { exit 74 }
}
EOF

  chmod +x "$SPECS_DIR"/*.expect
  pass "specs_ready"
}

run_smoke() {
  run_expect "start_menu" "$SPECS_DIR/start_menu.expect" "$PROFILE_ROOT" "$STATE_ROOT" "$EXTERNAL_ROOT" "$LOG_DIR/start-menu.log"
  run_expect "cleanup_dry" "$SPECS_DIR/cleanup_dry.expect" "$PROFILE_ROOT" "$STATE_ROOT" "$EXTERNAL_ROOT" "$LOG_DIR/cleanup-dry.log"
  run_expect "cleanup_real" "$SPECS_DIR/cleanup_real.expect" "$PROFILE_ROOT" "$STATE_ROOT" "$EXTERNAL_ROOT" "$LOG_DIR/cleanup-real.log"
  run_expect "analysis_only" "$SPECS_DIR/analysis.expect" "$PROFILE_ROOT" "$STATE_ROOT" "$EXTERNAL_ROOT" "$LOG_DIR/analysis.log"
  run_expect "space_governance" "$SPECS_DIR/governance.expect" "$PROFILE_ROOT" "$STATE_ROOT" "$EXTERNAL_ROOT" "$LOG_DIR/governance.log"

  local doctor_output
  local doctor_log="$LOG_DIR/doctor-json.log"
  clear_e2e_locks
  doctor_output="$(
    node src/cli.js \
      --mode doctor \
      --json \
      --root "$PROFILE_ROOT" \
      --state-root "$STATE_ROOT" \
      --external-storage-root "$EXTERNAL_ROOT" \
      --external-storage-auto-detect false \
      2>&1
  )"
  printf '%s\n' "$doctor_output" >"$doctor_log"
  if ! printf '%s' "$doctor_output" | rg -q '"overall"'; then
    fail "doctor_json" "$doctor_log" "命令: node src/cli.js --mode doctor --json ..."
  fi
  pass "doctor_json"

  local maintain_output
  local maintain_log="$LOG_DIR/recycle-maintain.log"
  clear_e2e_locks
  maintain_output="$(
    node src/cli.js \
      --mode recycle_maintain \
      --output text \
      --force \
      --root "$PROFILE_ROOT" \
      --state-root "$STATE_ROOT" \
      --external-storage-root "$EXTERNAL_ROOT" \
      --external-storage-auto-detect false \
      2>&1
  )"
  printf '%s\n' "$maintain_output" >"$maintain_log"
  if ! printf '%s' "$maintain_output" | rg -q "(\[SUCCESS\] recycle_maintain|动作：回收区治理|=== 任务结论 ===)"; then
    fail "recycle_maintain" "$maintain_log" "命令: node src/cli.js --mode recycle_maintain --output text ..."
  fi
  pass "recycle_maintain"

  local restore_empty_output
  clear_e2e_locks
  restore_empty_output="$(node src/cli.js --interactive --mode restore --root "$PROFILE_ROOT" --state-root "$EMPTY_STATE" --external-storage-root "$EXTERNAL_ROOT" --external-storage-auto-detect false)"
  if ! printf '%s' "$restore_empty_output" | rg -q "暂无可恢复批次"; then
    fail "restore_empty" ""
  fi
  pass "restore_empty"

  node scripts/e2e-restore-verify.mjs --prepare-ui > "$LOG_DIR/prepare-restore-ui.log"
  run_expect "restore_ui" "$SPECS_DIR/restore_ui.expect" "$PROFILE_ROOT" "$UI_STATE" "$EXTERNAL_ROOT" "$LOG_DIR/restore-ui.log"

  E2E_UI_STATE_ROOT="$UI_CONFLICT_SKIP_STATE" node scripts/e2e-restore-verify.mjs --prepare-ui-conflict > "$LOG_DIR/prepare-restore-ui-conflict-skip.log"
  run_expect "restore_ui_conflict_skip" "$SPECS_DIR/restore_ui_conflict_skip.expect" "$PROFILE_ROOT" "$UI_CONFLICT_SKIP_STATE" "$EXTERNAL_ROOT" "$LOG_DIR/restore-ui-conflict-skip.log"
  E2E_UI_STATE_ROOT="$UI_CONFLICT_OVERWRITE_STATE" node scripts/e2e-restore-verify.mjs --prepare-ui-conflict > "$LOG_DIR/prepare-restore-ui-conflict-overwrite.log"
  run_expect "restore_ui_conflict_overwrite" "$SPECS_DIR/restore_ui_conflict_overwrite.expect" "$PROFILE_ROOT" "$UI_CONFLICT_OVERWRITE_STATE" "$EXTERNAL_ROOT" "$LOG_DIR/restore-ui-conflict-overwrite.log"
  E2E_UI_STATE_ROOT="$UI_CONFLICT_RENAME_STATE" node scripts/e2e-restore-verify.mjs --prepare-ui-conflict > "$LOG_DIR/prepare-restore-ui-conflict-rename.log"
  run_expect "restore_ui_conflict_rename" "$SPECS_DIR/restore_ui_conflict_rename.expect" "$PROFILE_ROOT" "$UI_CONFLICT_RENAME_STATE" "$EXTERNAL_ROOT" "$LOG_DIR/restore-ui-conflict-rename.log"

  run_expect "settings_root" "$SPECS_DIR/settings_root.expect" "$PROFILE_ROOT" "$STATE_ROOT" "$EXTERNAL_ROOT" "$LOG_DIR/settings-root.log"
  run_expect "settings_external_roots" "$SPECS_DIR/settings_external_roots.expect" "$PROFILE_ROOT" "$STATE_ROOT" "$EXTERNAL_ROOT" "$DOCS_ROOT" "$LOG_DIR/settings-external-roots.log"
  run_expect "settings_recycle" "$SPECS_DIR/settings_recycle.expect" "$PROFILE_ROOT" "$STATE_ROOT" "$EXTERNAL_ROOT" "$STATE_ROOT/custom-recycle" "$LOG_DIR/settings-recycle.log"
  run_expect "settings_suggest" "$SPECS_DIR/settings_suggest.expect" "$PROFILE_ROOT" "$STATE_ROOT" "$EXTERNAL_ROOT" "$LOG_DIR/settings-suggest.log"
  run_expect "settings_cooldown" "$SPECS_DIR/settings_cooldown.expect" "$PROFILE_ROOT" "$STATE_ROOT" "$EXTERNAL_ROOT" "$LOG_DIR/settings-cooldown.log"
  run_expect "settings_auto_detect" "$SPECS_DIR/settings_auto_detect.expect" "$PROFILE_ROOT" "$STATE_ROOT" "$EXTERNAL_ROOT" "$LOG_DIR/settings-auto-detect.log"
  run_expect "settings_dryrun" "$SPECS_DIR/settings_dryrun.expect" "$PROFILE_ROOT" "$STATE_ROOT" "$EXTERNAL_ROOT" "$LOG_DIR/settings-dryrun.log"
  run_expect "settings_theme" "$SPECS_DIR/settings_theme.expect" "$PROFILE_ROOT" "$STATE_ROOT" "$EXTERNAL_ROOT" "$LOG_DIR/settings-theme.log"
  run_expect "settings_alias" "$SPECS_DIR/settings_alias.expect" "$PROFILE_ROOT" "$STATE_ROOT" "$EXTERNAL_ROOT" "$LOG_DIR/settings-alias.log"

  node scripts/e2e-restore-verify.mjs > "$LOG_DIR/restore-verify.log"
  pass "restore_branch_verify"
}

print_summary() {
  echo
  echo "E2E smoke 完成"
  echo "测试目录: $BASE_DIR"
  echo "日志目录: $LOG_DIR"
  echo "关键文件:"
  echo "- state index: $STATE_ROOT/index.jsonl"
  echo "- state aliases: $STATE_ROOT/account-aliases.json"
}

prepare_fixture
write_specs
run_smoke
print_summary
