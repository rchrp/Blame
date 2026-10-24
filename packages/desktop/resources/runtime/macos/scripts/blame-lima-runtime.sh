#!/bin/sh
set -eu

vm_name="BlameRuntime"
runtime_home="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
manifest_path="$runtime_home/manifest.json"
runtime_version="$(sed -n 's/.*"runtimeVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest_path" | head -n 1)"
runtime_version="${runtime_version:-1}"
manifest_cline_sdk_version="$(sed -n 's/.*"clineSdkVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest_path" | head -n 1)"
cline_sdk_version="${BLAME_CLINE_SDK_VERSION:-${manifest_cline_sdk_version:-0.0.95}}"
runtime_agent_version="$(sed -n 's/.*"runtimeAgentVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$manifest_path" | head -n 1)"
runtime_agent_version="${runtime_agent_version:-1}"
semantic_harness_payload="$runtime_home/payloads/blame-semantic-harness.tgz"
semantic_harness_sha256="$(shasum -a 256 "$semantic_harness_payload" 2>/dev/null | awk '{ print $1 }')"
lima_state_home="${LIMA_HOME:-$HOME/Library/Application Support/Blame/runtime/lima}"
lima_install_home="${BLAME_LIMA_INSTALL_DIR:-$HOME/Library/Application Support/Blame/runtime/tools/lima}"
lima_action="Install Blame again with its verified Lima runtime bundle, then run Blame runtime setup again."
vm_action="Create or repair the BlameRuntime Lima VM from Blame runtime setup."
repair_action="Repair BlameRuntime from Blame runtime setup."
mount_action="Reset BlameRuntime from Blame runtime setup so macOS project folders are mounted."

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

new_check() {
  name="$(json_escape "$1")"
  status="$(json_escape "$2")"
  action="${3:-}"
  if [ -n "$action" ]; then
    printf '{"name":"%s","status":"%s","action":"%s"}' "$name" "$status" "$(json_escape "$action")"
  else
    printf '{"name":"%s","status":"%s"}' "$name" "$status"
  fi
}

append_check() {
  check="$1"
  if [ -n "${checks:-}" ]; then
    checks="$checks,$check"
  else
    checks="$check"
  fi
}

write_status() {
  status="$1"
  action="${2:-}"
  if [ -n "$action" ]; then
    printf '{"status":"%s","checks":[%s],"action":"%s"}\n' "$(json_escape "$status")" "${checks:-}" "$(json_escape "$action")"
  else
    printf '{"status":"%s","checks":[%s]}\n' "$(json_escape "$status")" "${checks:-}"
  fi
}

write_runtime_progress() {
  phase="$1"
  completed_bytes="${2:-0}"
  total_bytes="${3:-0}"
  if [ "$total_bytes" -gt 0 ]; then
    percent=$((completed_bytes * 100 / total_bytes))
    if [ "$percent" -gt 100 ]; then
      percent=100
    fi
    printf 'BLAME_RUNTIME_PROGRESS {"phase":"%s","completedBytes":%s,"totalBytes":%s,"percent":%s}\n' \
      "$phase" "$completed_bytes" "$total_bytes" "$percent"
    return
  fi
  printf 'BLAME_RUNTIME_PROGRESS {"phase":"%s"}\n' "$phase"
}

limactl_path() {
  for candidate in \
    "${BLAME_LIMA_BIN:-}" \
    "${BLAME_LIMA_BIN_DIR:-}/limactl" \
    "${BLAME_LIMA_BUNDLE_DIR:-}/bin/limactl" \
    "$runtime_home/lima/bundle/bin/limactl" \
    "$lima_install_home/bin/limactl" \
    "$runtime_home/lima/bin/limactl"
  do
    if usable_lima_bin "$candidate"; then
      printf '%s' "$candidate"
      return
    fi
  done
}

usable_lima_bin() {
  candidate="$1"
  if [ -z "$candidate" ] || [ ! -x "$candidate" ]; then
    return 1
  fi
  LIMA_HOME="$lima_state_home" \
    PATH="$(dirname "$candidate"):$PATH" \
    "$candidate" --version >/dev/null 2>&1 &&
    LIMA_HOME="$lima_state_home" \
      PATH="$(dirname "$candidate"):$PATH" \
      "$candidate" list --json >/dev/null 2>&1
}

with_lima_environment() {
  limactl="$(limactl_path)"
  if [ -z "$limactl" ]; then
    return 1
  fi
  export LIMA_HOME="$lima_state_home"
  export PATH="$(dirname "$limactl"):$PATH"
  "$limactl" "$@"
}

test_lima_available() {
  with_lima_environment --version >/dev/null 2>&1
}

install_lima_bundle() {
  if test_lima_available; then
    return
  fi
  printf '%s\n' "$lima_action" >&2
  exit 1
}

vm_json() {
  with_lima_environment list --json "$vm_name" 2>/dev/null || true
}

vm_status() {
  vm_json | sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

test_vm_present() {
  [ -n "$(vm_json)" ]
}

test_vm_running() {
  [ "$(vm_status)" = "Running" ]
}

add_vm_checks() {
  output="$(with_lima_environment shell "$vm_name" sudo -n sh -s -- "$HOME/Library/Application Support/Blame" "$cline_sdk_version" "$runtime_version" "$runtime_agent_version" "$semantic_harness_sha256" <<'EOF' 2>/dev/null || true
host_mount="$1"
cline_sdk_version="$2"
runtime_version="$3"
runtime_agent_version="$4"
semantic_harness_sha256="$5"
check() {
  name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    printf '%s\tavailable\n' "$name"
  else
    printf '%s\tmissing\n' "$name"
  fi
}
node_major_ok() {
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'
}
valid_cline_sdk_install() {
  node_major_ok
  global_node_root="$(npm root -g)"
  node - "$global_node_root" "$cline_sdk_version" <<'NODE'
const fs = require("fs");
const path = require("path");
const root = path.join(process.argv[2], "@blame/semantic-harness-runtime/node_modules");
const version = process.argv[3];
const sdkPackage = path.join(root, "@cline/sdk/package.json");
const coreRoot = path.join(root, "../vendor/cline-core");
if (!fs.existsSync(sdkPackage) || !coreRoot) process.exit(1);
const sdk = JSON.parse(fs.readFileSync(sdkPackage, "utf8"));
const core = JSON.parse(fs.readFileSync(path.join(coreRoot, "package.json"), "utf8"));
const sdkEntry = path.join(root, "@cline/sdk/dist/index.js");
process.exit(sdk.version === version && core.version === version && fs.existsSync(sdkEntry) && fs.existsSync(path.join(coreRoot, "dist/blame-patch.json")) ? 0 : 1);
NODE
}
check host-home test -d "$host_mount"
check agent test -x /usr/local/bin/blame-runtime-agent
check agent-version sh -lc 'test "$(blame-runtime-agent agent-version 2>/dev/null)" = "$1"' sh "$runtime_agent_version"
check runtime-version sh -lc 'test "$(cat /etc/blame-runtime-version 2>/dev/null)" = "$1"' sh "$runtime_version"
check docker sh -lc 'command -v dockerd >/dev/null 2>&1 && command -v docker >/dev/null 2>&1'
check docker-compose sh -lc 'docker compose version >/dev/null 2>&1'
check git sh -lc 'command -v git >/dev/null 2>&1'
check cline-sdk valid_cline_sdk_install
check semantic-harness sh -lc 'command -v blame-semantic-harness >/dev/null 2>&1 && test "$(cat /etc/blame-semantic-harness-sha256 2>/dev/null)" = "$1"' sh "$semantic_harness_sha256"
check package-managers sh -lc 'test "$(/opt/blame/package-managers/pnpm/10.33.2/bin/pnpm --version 2>/dev/null)" = "10.33.2" && test "$(/opt/blame/package-managers/npm/11.6.4/bin/npm --version 2>/dev/null)" = "11.6.4" && test "$(/opt/blame/package-managers/yarn/1.22.22/bin/yarn --version 2>/dev/null)" = "1.22.22"'
EOF
)"
  if [ -z "$output" ]; then
    for name in agent agent-version runtime-version docker docker-compose git cline-sdk semantic-harness package-managers; do
      append_check "$(new_check "$name" "missing" "$repair_action")"
    done
    return
  fi
  old_ifs="$IFS"
  IFS='
'
  for line in $output; do
    IFS="$old_ifs"
    name="$(printf '%s' "$line" | cut -f 1)"
    status="$(printf '%s' "$line" | cut -f 2)"
    if [ -z "$name" ]; then
      continue
    fi
    if [ "$status" = "available" ]; then
      append_check "$(new_check "$name" "$status")"
    elif [ "$name" = "host-home" ]; then
      append_check "$(new_check "$name" "missing" "$mount_action")"
    else
      append_check "$(new_check "$name" "missing" "$repair_action")"
    fi
    IFS='
'
  done
  IFS="$old_ifs"
}

runtime_status() {
  checks=""
  if ! test_lima_available; then
    append_check "$(new_check "lima" "missing" "$lima_action")"
    write_status "missing" "$lima_action"
    return
  fi
  append_check "$(new_check "lima" "available")"
  if ! test_vm_present; then
    append_check "$(new_check "vm" "missing" "$vm_action")"
    write_status "missing" "$vm_action"
    return
  fi
  if ! test_vm_running; then
    append_check "$(new_check "vm" "unavailable" "$vm_action")"
    write_status "repairable" "$vm_action"
    return
  fi
  append_check "$(new_check "vm" "available")"
  add_vm_checks
  if printf '%s' "$checks" | grep -q '"status":"missing"'; then
    write_status "repairable" "$repair_action"
    return
  fi
  write_status "ready"
}

assert_lima_available() {
  if test_lima_available; then
    return
  fi
  printf '%s\n' "$lima_action" >&2
  exit 1
}

runtime_image_url() {
  architecture="$(uname -m)"
  case "$architecture" in
    arm64 | aarch64) architecture="aarch64" ;;
    amd64 | x86_64) architecture="x86_64" ;;
  esac
  awk -v architecture="$architecture" '
    $1 == "-" && $2 == "location:" {
      location = $3
      gsub(/"/, "", location)
    }
    $1 == "arch:" {
      image_architecture = $2
      gsub(/"/, "", image_architecture)
      if (image_architecture == architecture) {
        print location
        exit
      }
    }
  ' "$runtime_home/lima/blame-runtime.yaml"
}

remote_content_length() {
  url="$1"
  curl -fsSIL --connect-timeout 3 --max-time 5 "$url" 2>/dev/null |
    tr -d '\r' |
    awk 'tolower($1) == "content-length:" { content_length = $2 } END {
      if (content_length ~ /^[0-9]+$/) print content_length
    }'
}

lima_download_cache_directory() {
  url="$1"
  cache_key="$(printf '%s' "$url" | shasum -a 256 | awk '{ print $1 }')"
  printf '%s/Library/Caches/lima/download/by-url-sha256/%s' "$HOME" "$cache_key"
}

file_size() {
  if file_bytes="$(stat -f '%z' "$1" 2>/dev/null)"; then
    printf '%s' "$file_bytes"
    return
  fi
  if file_bytes="$(stat -c '%s' "$1" 2>/dev/null)"; then
    printf '%s' "$file_bytes"
    return
  fi
  printf '0'
}

downloaded_cache_bytes() {
  cache_directory="$1"
  largest_size=0
  for candidate in "$cache_directory"/data.tmp.* "$cache_directory"/data; do
    if [ ! -f "$candidate" ]; then
      continue
    fi
    candidate_size="$(file_size "$candidate")"
    if [ "$candidate_size" -gt "$largest_size" ]; then
      largest_size="$candidate_size"
    fi
  done
  printf '%s' "$largest_size"
}

monitor_lima_download() {
  process_id="$1"
  image_url="$(runtime_image_url)"
  if [ -z "$image_url" ] ||
    ! command -v curl >/dev/null 2>&1 ||
    ! command -v shasum >/dev/null 2>&1; then
    wait_for_process "$process_id"
    return
  fi
  cache_directory="$(lima_download_cache_directory "$image_url")"
  if [ -f "$cache_directory/data" ]; then
    total_bytes="$(file_size "$cache_directory/data")"
  else
    total_bytes="$(remote_content_length "$image_url")"
  fi
  previous_bytes=-1
  while kill -0 "$process_id" 2>/dev/null; do
    completed_bytes="$(downloaded_cache_bytes "$cache_directory")"
    if [ "$completed_bytes" != "$previous_bytes" ]; then
      write_download_progress "$cache_directory" "$completed_bytes" "${total_bytes:-0}"
      previous_bytes="$completed_bytes"
    fi
    sleep 1
  done
  completed_bytes="$(downloaded_cache_bytes "$cache_directory")"
  write_download_progress "$cache_directory" "$completed_bytes" "${total_bytes:-0}"
}

write_download_progress() {
  cache_directory="$1"
  completed_bytes="$2"
  total_bytes="$3"
  if [ -f "$cache_directory/data" ]; then
    write_runtime_progress "installing" "$completed_bytes" "$total_bytes"
    return
  fi
  if [ "$total_bytes" -gt 0 ] && [ "$completed_bytes" -ge "$total_bytes" ]; then
    write_runtime_progress "verifying" "$completed_bytes" "$total_bytes"
    return
  fi
  write_runtime_progress "downloading" "$completed_bytes" "$total_bytes"
}

wait_for_process() {
  process_id="$1"
  while kill -0 "$process_id" 2>/dev/null; do
    sleep 1
  done
}

create_vm() {
  write_runtime_progress "downloading"
  with_lima_environment create \
    --name "$vm_name" \
    --tty=false \
    "$runtime_home/lima/blame-runtime.yaml" &
  create_process_id=$!
  monitor_lima_download "$create_process_id"
  if wait "$create_process_id"; then
    write_runtime_progress "installing"
    return
  fi
  create_exit_code=$?
  return "$create_exit_code"
}

ensure_vm() {
  install_lima_bundle
  assert_lima_available
  mkdir -p "$lima_state_home"
  if ! test_vm_present; then
    create_vm
  fi
  if ! test_vm_running; then
    write_runtime_progress "starting"
    with_lima_environment start "$vm_name"
  fi
}

invoke_provisioner() {
  provisioner="$runtime_home/scripts/provision-blame-runtime.sh"
  if [ ! -f "$semantic_harness_payload" ]; then
    printf '%s\n' "Blame semantic harness runtime payload is missing." >&2
    exit 1
  fi
  write_runtime_progress "configuring"
  with_lima_environment copy \
    "$semantic_harness_payload" \
    "$vm_name:/tmp/blame-semantic-harness.tgz"
  with_lima_environment shell "$vm_name" sudo -n sh -s -- "$runtime_version" "$cline_sdk_version" <"$provisioner"
}

ensure_runtime() {
  ensure_vm
  invoke_provisioner
  write_runtime_progress "checking"
  runtime_status
}

reset_runtime() {
  assert_lima_available
  if test_vm_present; then
    with_lima_environment delete -f "$vm_name"
  fi
  ensure_runtime
}

uninstall_runtime() {
  assert_lima_available
  if test_vm_present; then
    with_lima_environment delete -f "$vm_name"
  fi
  runtime_status
}

invoke_runtime_command() {
  if ! test_vm_present; then
    printf '%s\n' "BlameRuntime is not installed." >&2
    exit 1
  fi
  user="blame"
  case "${1:-}" in
    root)
      shift
      if [ "$#" -eq 0 ]; then
        printf '%s\n' "Missing runtime command." >&2
        exit 1
      fi
      with_lima_environment shell "$vm_name" sudo -n -- "$@"
      exit $?
      ;;
    agent)
      shift
      with_lima_environment shell "$vm_name" sudo -n -- blame-runtime-agent "$@"
      exit $?
      ;;
    compose | container | info | inspect | network | volume)
      user="root"
      ;;
    sh)
      case " $* " in
        *" docker "*) user="root" ;;
      esac
      ;;
  esac
  if [ "$user" = "root" ]; then
    with_lima_environment shell "$vm_name" sudo -n -- "$@"
    exit $?
  fi
  with_lima_environment shell "$vm_name" sudo -n -u blame -- "$@"
  exit $?
}

if [ "$#" -eq 0 ]; then
  runtime_status
  exit 0
fi

case "$1" in
  --version)
    printf '%s\n' "blame-lima-runtime $runtime_version"
    ;;
  status)
    runtime_status
    ;;
  ensure)
    ensure_runtime
    ;;
  repair)
    ensure_runtime
    ;;
  reset)
    reset_runtime
    ;;
  uninstall)
    uninstall_runtime
    ;;
  *)
    invoke_runtime_command "$@"
    ;;
esac
