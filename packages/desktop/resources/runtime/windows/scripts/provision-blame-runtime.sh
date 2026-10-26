set -eu

runtime_version="${1:-11}"
runtime_root="/home/blame/.local/share/blame/runtime"
package_manager_root="/opt/blame/package-managers"
cline_sdk_version="${BLAME_CLINE_SDK_VERSION:-${2:-0.2.0}}"
docker_version="${BLAME_DOCKER_VERSION:-29.9.1}"
compose_version="${BLAME_COMPOSE_VERSION:-5.6.0}"
buildx_version="${BLAME_BUILDX_VERSION:-0.38.0}"
node_version="${BLAME_NODE_VERSION:-22.23.1}"
npm_version="${BLAME_NPM_VERSION:-11.6.4}"
pnpm_version="${BLAME_PNPM_VERSION:-10.33.2}"
yarn_version="${BLAME_YARN_VERSION:-1.22.22}"
runtime_packages="bubblewrap ca-certificates curl dbus-user-session git gzip iptables procps python3 tar xz-utils"

ensure_user() {
  if id blame >/dev/null 2>&1; then
    return
  fi
  useradd --create-home --shell /bin/bash blame
}

ensure_packages() {
  if ! command -v apt-get >/dev/null 2>&1; then
    return
  fi
  missing="$(missing_runtime_packages)"
  if [ -z "$missing" ]; then
    return
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y $missing
}

missing_runtime_packages() {
  missing=""
  for package in $runtime_packages; do
    if ! dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q "install ok installed"; then
      missing="$missing $package"
    fi
  done
  printf '%s' "$missing"
}

ensure_node() {
  if command -v node >/dev/null 2>&1 && node -e 'process.exit(process.versions.node === process.argv[1] ? 0 : 1)' "$node_version" >/dev/null 2>&1; then
    return
  fi
  arch="$(node_archive_architecture)"
  archive="node-v${node_version}-linux-${arch}.tar.xz"
  temp_dir="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/v${node_version}/${archive}" -o "$temp_dir/$archive"
  printf '%s  %s\n' "$(node_archive_sha256 "$arch")" "$temp_dir/$archive" | sha256sum -c - >/dev/null
  tar -C /usr/local --strip-components=1 -xJf "$temp_dir/$archive"
  rm -rf "$temp_dir"
}

ensure_package_managers() {
  ensure_package_manager npm "$npm_version"
  ensure_package_manager pnpm "$pnpm_version"
  ensure_package_manager yarn "$yarn_version"
}

ensure_package_manager() {
  name="$1"
  version="$2"
  destination="$package_manager_root/$name/$version"
  executable="$destination/bin/$name"
  if [ -x "$executable" ] && [ "$("$executable" --version 2>/dev/null)" = "$version" ]; then
    return
  fi
  rm -rf "$destination"
  mkdir -p "$destination/bin"
  npm install --prefix "$destination" --omit=dev --ignore-scripts "$name@$version"
  ln -sf "../node_modules/.bin/$name" "$executable"
  [ "$("$executable" --version)" = "$version" ]
}

node_archive_architecture() {
  case "$(runtime_architecture)" in
    amd64) printf '%s' "x64" ;;
    arm64) printf '%s' "arm64" ;;
    *) return 1 ;;
  esac
}

node_archive_sha256() {
  case "$node_version:$1" in
    22.23.1:x64) printf '%s' "9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578" ;;
    22.23.1:arm64) printf '%s' "0294e8b915ab75f92c7513d2fcb830ae06e10684e6c603e99a87dbf8835389c1" ;;
    *)
      if [ -z "${BLAME_NODE_SHA256:-}" ]; then
        printf '%s\n' "BLAME_NODE_SHA256 is required for Node $node_version on $1." >&2
        return 1
      fi
      printf '%s' "$BLAME_NODE_SHA256"
      ;;
  esac
}

ensure_cline_sdk() {
  if valid_cline_sdk_install; then return; fi
  printf '%s\n' "Bundled Cline SDK is missing or incompatible." >&2
  return 1
}

valid_semantic_harness_install() {
  global_node_root="$(npm root -g)"
  package_path="$global_node_root/@blame/semantic-harness-runtime/package.json"
  [ -x /usr/local/bin/blame-semantic-harness ] &&
    [ -f "$package_path" ] &&
    node -e '
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
process.exit(manifest.version === process.argv[2] ? 0 : 1);
' "$package_path" "0.0.0-$runtime_version" >/dev/null 2>&1 &&
    semantic_harness_smoke_test
}

semantic_harness_smoke_test() {
  workspace="$(mktemp -d)"
  printf '%s\n' '{"scripts":{}}' >"$workspace/package.json"
  if printf '{"input":{"target":"@capabilities"},"taskContract":{"session_id":"provision-smoke"},"tool":"read_code","workspaceRoot":"%s"}' "$workspace" |
    blame-semantic-harness |
    node -e '
let value = "";
process.stdin.on("data", (chunk) => value += chunk);
process.stdin.on("end", () => {
  const result = JSON.parse(value);
  const valid = result.status === "ok" && typeof result.data?.description === "string";
  process.exit(valid ? 0 : 1);
});
'; then
    status=0
  else
    status=$?
  fi
  rm -rf "$workspace"
  return "$status"
}

ensure_semantic_harness() {
  payload="/tmp/blame-semantic-harness.tgz"
  if [ ! -f "$payload" ]; then
    printf '%s\n' "Blame semantic harness runtime payload is missing." >&2
    return 1
  fi
  payload_sha256="$(sha256sum "$payload" | awk '{ print $1 }')"
  marker="/etc/blame-semantic-harness-sha256"
  if valid_semantic_harness_install && valid_cline_sdk_install &&
    [ "$(cat "$marker" 2>/dev/null || true)" = "$payload_sha256" ]; then
    return
  fi
  npm install -g --force "$payload"
  valid_semantic_harness_install
  printf '%s\n' "$payload_sha256" >"$marker"
}

valid_cline_sdk_install() {
  global_node_root="$(npm root -g)"
  node -e '
const fs = require("fs");
const path = require("path");
const root = path.join(process.argv[1], "@blame/semantic-harness-runtime/node_modules");
const version = process.argv[2];
const readVersion = (name) => JSON.parse(fs.readFileSync(path.join(root, name, "package.json"), "utf8")).version;
const coreRoot = path.join(root, "../vendor/cline-core");
const sdkEntry = path.join(root, "@cline/sdk/dist/index.js");
process.exit(
  readVersion("@cline/sdk") === version &&
  coreRoot &&
  JSON.parse(fs.readFileSync(path.join(coreRoot, "package.json"), "utf8")).version === version &&
  fs.existsSync(sdkEntry) && fs.existsSync(path.join(coreRoot, "dist/blame-patch.json"))
    ? 0
    : 1
);
' "$global_node_root" "$cline_sdk_version" >/dev/null 2>&1
}

runtime_architecture() {
  case "$(uname -m)" in
    x86_64 | amd64) printf '%s' "amd64" ;;
    aarch64 | arm64) printf '%s' "arm64" ;;
    *) uname -m ;;
  esac
}

remove_external_cli_payloads() {
  global_node_root="$(npm root -g)"
  find "$global_node_root" -type d \
    \( -path "*/node_modules/@openai/codex-linux-*" \
    -o -path "*/node_modules/@anthropic-ai/claude-agent-sdk-linux-*" \) \
    -prune -exec rm -rf {} +
}

# Docker Engine runs the previews, the same engine and Compose as the cloud
# sandbox runner. Static binaries keep the image free of apt repositories;
# every download is checked against a pinned checksum.
ensure_container_stack() {
  if docker_stack_current; then
    return
  fi
  arch="$(runtime_architecture)"
  docker_arch="$(docker_archive_architecture "$arch")"
  temp_dir="$(mktemp -d)"
  download_verified \
    "https://download.docker.com/linux/static/stable/${docker_arch}/docker-${docker_version}.tgz" \
    "$temp_dir/docker.tgz" "$(docker_artifact_sha256 docker "$arch")"
  tar -C "$temp_dir" -xzf "$temp_dir/docker.tgz"
  for binary in docker dockerd docker-init docker-proxy containerd containerd-shim-runc-v2 runc; do
    install -m 0755 "$temp_dir/docker/$binary" "/usr/local/bin/$binary"
  done
  mkdir -p /usr/local/lib/docker/cli-plugins
  download_verified \
    "https://github.com/docker/compose/releases/download/v${compose_version}/docker-compose-linux-${docker_arch}" \
    "$temp_dir/docker-compose" "$(docker_artifact_sha256 compose "$arch")"
  install -m 0755 "$temp_dir/docker-compose" /usr/local/lib/docker/cli-plugins/docker-compose
  download_verified \
    "https://github.com/docker/buildx/releases/download/v${buildx_version}/buildx-v${buildx_version}.linux-${arch}" \
    "$temp_dir/docker-buildx" "$(docker_artifact_sha256 buildx "$arch")"
  install -m 0755 "$temp_dir/docker-buildx" /usr/local/lib/docker/cli-plugins/docker-buildx
  rm -rf "$temp_dir"
}

docker_stack_current() {
  docker --version 2>/dev/null | grep -q "Docker version ${docker_version}," &&
    [ -x /usr/local/bin/dockerd ] &&
    [ -x /usr/local/bin/docker-init ] &&
    [ "$(docker compose version --short 2>/dev/null)" = "$compose_version" ] &&
    docker buildx version 2>/dev/null | grep -q " v${buildx_version} "
}

download_verified() {
  curl -fsSL "$1" -o "$2"
  printf '%s  %s\n' "$3" "$2" | sha256sum -c - >/dev/null
}

docker_archive_architecture() {
  case "$1" in
    amd64) printf '%s' "x86_64" ;;
    arm64) printf '%s' "aarch64" ;;
    *) return 1 ;;
  esac
}

docker_artifact_sha256() {
  case "$1" in
    docker) version="$docker_version" ;;
    compose) version="$compose_version" ;;
    buildx) version="$buildx_version" ;;
    *) return 1 ;;
  esac
  case "$1:$version:$2" in
    docker:29.9.1:amd64) printf '%s' "c158ecc55adb3afb01bbd3539ed3b997d20c26dbdc418080506cc1bf5243ff57" ;;
    docker:29.9.1:arm64) printf '%s' "3e93cc6d1a686456a3b18eefdde26467a837a7a2b257af22e27cba1dbc1b2018" ;;
    compose:5.6.0:amd64) printf '%s' "40343e21ca777173e69cff5dbafeb37c6f81f3b0d57d9e597f036e95eb63e76a" ;;
    compose:5.6.0:arm64) printf '%s' "733ec76717ceb59052a9609b9dadfb523b2df8eab57a54212872d10a58078ea2" ;;
    buildx:0.38.0:amd64) printf '%s' "4fe4cc38adf48169132749b6ca22a990928db0118e3407584ee553723115d287" ;;
    buildx:0.38.0:arm64) printf '%s' "38e890e1a162bfdbf32fbe91404991dc4fc28e55b0de901b34374a061bab4d2c" ;;
    *)
      printf '%s\n' "No pinned checksum for $1 $version on $2." >&2
      return 1
      ;;
  esac
}

# Logs and the build cache stay bounded; small address pools let many
# previews run at once; overlay2 keeps a single copy of each image layer.
# A changed configuration restarts Docker, which stops running previews;
# the desktop restarts the ones it wants.
ensure_docker_config() {
  mkdir -p /etc/docker
  previous="$(cat /etc/docker/daemon.json 2>/dev/null || true)"
  cat >/etc/docker/daemon.json <<'JSON'
{
  "builder": { "gc": { "enabled": true, "defaultKeepStorage": "3GB" } },
  "default-address-pools": [{ "base": "172.20.0.0/14", "size": 24 }],
  "features": { "containerd-snapshotter": false },
  "log-driver": "local",
  "log-opts": { "max-file": "3", "max-size": "10m" },
  "max-concurrent-downloads": 4,
  "storage-driver": "overlay2"
}
JSON
  if [ -n "$previous" ] && [ "$previous" != "$(cat /etc/docker/daemon.json)" ]; then
    stop_docker
  fi
}

stop_docker() {
  pkill -x dockerd >/dev/null 2>&1 || return 0
  attempt=0
  while pgrep -x dockerd >/dev/null 2>&1 && [ "$attempt" -lt 120 ]; do
    attempt=$((attempt + 1))
    sleep 0.25
  done
}

ensure_docker_running() {
  if [ "${BLAME_RUNTIME_BAKE:-0}" = "1" ]; then
    return
  fi
  blame-runtime-agent docker-ensure
}

# Runtime 10 ran previews on a standalone containerd with nerdctl. Stop its
# containers and drop its network rules before Docker takes over: a stale
# port mapping would capture a reused preview port.
stop_legacy_container_stack() {
  if [ ! -x /usr/local/bin/nerdctl ] && [ ! -d /var/lib/nerdctl ]; then
    return
  fi
  if [ -x /usr/local/bin/nerdctl ] && [ -S /run/containerd/containerd.sock ]; then
    for namespace in $(nerdctl namespace ls -q 2>/dev/null || true); do
      containers="$(nerdctl --namespace "$namespace" ps -aq 2>/dev/null || true)"
      if [ -n "$containers" ]; then
        nerdctl --namespace "$namespace" rm -f $containers >/dev/null 2>&1 || true
      fi
    done
  fi
  pkill -x buildkitd 2>/dev/null || true
  if ! docker info >/dev/null 2>&1; then
    pkill -x containerd 2>/dev/null || true
    rm -f /run/containerd/containerd.sock
  fi
  ip link delete nerdctl0 2>/dev/null || true
  for table in nat filter; do
    rules="$(iptables-save -t "$table" 2>/dev/null || true)"
    if printf '%s\n' "$rules" | grep -q 'CNI'; then
      printf '%s\n' "$rules" | grep -v 'CNI' | iptables-restore 2>/dev/null || true
    fi
  done
}

# Data volumes of existing worktrees, such as database directories, move to
# Docker under the name the new renderer gives them. Dependency installs and
# caches are not copied: Docker fills them again on the next start.
migrate_legacy_volumes() {
  if [ ! -d /var/lib/nerdctl ] || [ "${BLAME_RUNTIME_BAKE:-0}" = "1" ]; then
    return
  fi
  projects="$(legacy_live_projects)"
  for data in /var/lib/nerdctl/*/volumes/*/*/_data; do
    [ -d "$data" ] || continue
    name="$(basename "$(dirname "$data")")"
    project="$(printf '%s' "$name" | sed -n 's/^\(blame_[0-9a-f]\{12\}\)_.*/\1/p')"
    volume="${name#"${project}_"}"
    if [ -z "$project" ] || ! printf '%s\n' "$projects" | grep -qx "$project"; then
      continue
    fi
    case "$volume" in
      *node_modules* | *_next | *_nuxt | *cache* | *pnpm_store*) continue ;;
    esac
    target="${project}_cache-${volume}"
    if docker volume inspect "$target" >/dev/null 2>&1; then
      continue
    fi
    docker volume create --label blame.preview=true "$target" >/dev/null
    mountpoint="$(docker volume inspect --format '{{.Mountpoint}}' "$target")"
    cp -a "$data/." "$mountpoint/"
    chown "$(stat -c %u:%g "$data")" "$mountpoint"
    chmod "$(stat -c %a "$data")" "$mountpoint"
  done
}

legacy_live_projects() {
  find "$runtime_root/worktrees" "$runtime_root/repos" -mindepth 1 -maxdepth 3 -name .git 2>/dev/null |
    while IFS= read -r git_path; do
      printf 'blame_%s\n' "$(printf '%s' "${git_path%/.git}" | sha1sum | cut -c1-12)"
    done
}

remove_legacy_container_stack() {
  rm -f /usr/local/bin/nerdctl /usr/local/bin/buildctl /usr/local/bin/buildkitd /usr/local/bin/tini
  rm -rf /usr/local/libexec/cni /etc/cni /var/lib/cni /etc/containerd \
    /var/lib/nerdctl /var/lib/buildkit /var/lib/containerd
}

# The VM only runs Blame: hardware, snap and update services cost memory
# and wake the CPU for nothing. The journal stays small.
trim_guest_services() {
  if [ "${BLAME_RUNTIME_BAKE:-0}" = "1" ] || [ ! -d /run/systemd/system ]; then
    return
  fi
  for unit in \
    snapd.service snapd.socket snapd.seeded.service \
    ModemManager.service multipathd.service multipathd.socket \
    udisks2.service unattended-upgrades.service packagekit.service \
    apt-daily.timer apt-daily-upgrade.timer motd-news.timer \
    fwupd.service fwupd-refresh.timer man-db.timer \
    rsyslog.service syslog.socket \
    update-notifier-download.timer update-notifier-motd.timer \
    sysstat-collect.timer sysstat-summary.timer \
    e2scrub_all.timer dpkg-db-backup.timer; do
    systemctl disable --now "$unit" >/dev/null 2>&1 || true
    systemctl mask "$unit" >/dev/null 2>&1 || true
  done
  mkdir -p /etc/systemd/journald.conf.d
  if [ ! -s /etc/systemd/journald.conf.d/blame.conf ]; then
    printf '[Journal]\nSystemMaxUse=64M\n' >/etc/systemd/journald.conf.d/blame.conf
    systemctl restart systemd-journald >/dev/null 2>&1 || true
  fi
  if dpkg-query -W -f='${Status}' snapd 2>/dev/null | grep -q "install ok installed"; then
    DEBIAN_FRONTEND=noninteractive apt-get purge -y snapd >/dev/null 2>&1 || true
    rm -rf /var/lib/snapd /var/cache/snapd /snap
  fi
  systemctl enable fstrim.timer >/dev/null 2>&1 || true
}

ensure_runtime_paths() {
  mkdir -p \
    "$runtime_root/repos" \
    "$runtime_root/worktrees" \
    "$runtime_root/caches" \
    "$runtime_root/logs" \
    "$runtime_root/env"
  chown -R blame:blame /home/blame/.local
}

ensure_agent() {
  cat >/usr/local/bin/blame-runtime-agent <<'EOF'
#!/usr/bin/env python3
import atexit
import concurrent.futures
import json
import multiprocessing
import os
import pwd
import signal
import subprocess
import sys
import threading
import uuid
import urllib.request
import traceback

def log_error(msg):
    try:
        os.makedirs("/var/log/blame-runtime", exist_ok=True)
        with open("/var/log/blame-runtime/agent.log", "a", encoding="utf-8") as f_err:
            f_err.write(msg + "\n")
    except Exception:
        pass

sys.excepthook = lambda exctype, value, tb: log_error("".join(traceback.format_exception(exctype, value, tb)))


processes = {}
semantic_processes = {}
write_lock = threading.Lock()
processes_lock = threading.Lock()
semantic_processes_lock = threading.Lock()
json_pool_lock = threading.Lock()
json_pool = None
json_worker_count = max(1, min(2, os.cpu_count() or 1))
large_json_threshold = 64 * 1024
ignored_env_directories = {".git", ".blame", "build", "coverage", "dist", "node_modules", "out"}
env_template_suffixes = (".example", ".sample", ".template")
runtime_agent_version = "10"

def serialize_json_line(value):
    return json.dumps(value, separators=(",", ":")) + "\n"

def json_size(value):
    if value is None or isinstance(value, bool):
        return 4
    if isinstance(value, (int, float)):
        return 16
    if isinstance(value, str):
        return len(value)
    if isinstance(value, list):
        return sum(json_size(item) for item in value)
    if isinstance(value, dict):
        return sum(len(str(key)) + json_size(item) for key, item in value.items())
    return len(str(value))

def json_executor():
    global json_pool
    with json_pool_lock:
        if json_pool is None:
            context = multiprocessing.get_context("spawn")
            json_pool = concurrent.futures.ProcessPoolExecutor(max_workers=json_worker_count, mp_context=context)
        return json_pool

def shutdown_json_executor():
    global json_pool
    with json_pool_lock:
        pool = json_pool
        json_pool = None
    if pool is not None:
        pool.shutdown(wait=False, cancel_futures=True)

atexit.register(shutdown_json_executor)

def json_line(value):
    if json_size(value) < large_json_threshold:
        return serialize_json_line(value)
    try:
        return json_executor().submit(serialize_json_line, value).result()
    except Exception:
        return serialize_json_line(value)

def write(value):
    line = json_line(value)
    with write_lock:
        sys.stdout.write(line)
        sys.stdout.flush()

def version():
    try:
        with open("/etc/blame-runtime-version", "r", encoding="utf-8") as file:
            return file.read().strip()
    except OSError:
        return "unknown"

docker_lock = threading.Lock()

def docker_ready():
    try:
        return subprocess.run(["docker", "info"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2).returncode == 0
    except subprocess.TimeoutExpired:
        return False

# Provisioning and every agent process share this lock. A thread-only lock
# allowed two dockerd processes to race while opening the volume database.
def ensure_docker():
    import fcntl
    import time
    if docker_ready():
        return
    deadline = time.monotonic() + 90
    os.makedirs("/var/log/blame-runtime", exist_ok=True)
    os.makedirs("/run/lock", exist_ok=True)
    with docker_lock, open("/run/lock/blame-docker.lock", "a") as lock:
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("Timed out waiting for Docker Engine startup.")
                time.sleep(0.25)
        launched = None
        starts = 0
        while time.monotonic() < deadline:
            if docker_ready():
                return
            # Reap our failed child before checking for an existing daemon.
            if launched is not None:
                launched.poll()
            running = (launched is not None and launched.returncode is None) or subprocess.run(["pgrep", "-x", "dockerd"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
            if not running:
                if starts >= 3:
                    break
                with open("/var/log/blame-runtime/dockerd.log", "ab") as log:
                    launched = subprocess.Popen(["dockerd", "--config-file", "/etc/docker/daemon.json"], stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
                starts += 1
            time.sleep(0.25)
    raise RuntimeError("Docker Engine did not start; see /var/log/blame-runtime/dockerd.log.")

def target_user(name):
    if os.geteuid() != 0:
        return None
    return pwd.getpwnam(name)

def demote(account):
    if not account or account.pw_uid == os.geteuid():
        return None
    def apply():
        os.initgroups(account.pw_name, account.pw_gid)
        os.setgid(account.pw_gid)
        os.setuid(account.pw_uid)
    return apply

def clean_env(values, account):
    env = os.environ.copy()
    for key, value in values.items():
        if isinstance(key, str) and isinstance(value, str):
            if key == "PATH" and windows_path(value):
                continue
            if account and key in ("HOME", "LOGNAME", "SHELL", "USER"):
                continue
            env[key] = value
    if account:
        env["HOME"] = account.pw_dir
        env["LOGNAME"] = account.pw_name
        env["SHELL"] = account.pw_shell
        env["USER"] = account.pw_name
    return env

def windows_path(value):
    return ";" in value or "\\" in value

def command_env(params, account):
    return clean_env(params.get("env") or {}, account)

def command_cwd(params):
    cwd = params.get("cwd")
    return cwd if isinstance(cwd, str) and cwd else None

def command_user(params):
    user = params.get("user")
    return user if user in ("blame", "root") else "blame"

def prepare_command(params):
    command = str(params.get("command") or "")
    args = [str(value) for value in params.get("args") or []]
    if command == "docker" or any("docker" in value for value in args):
        ensure_docker()
    return command, args

def run_exec(params):
    command, args = prepare_command(params)
    account = target_user(command_user(params))
    timeout = params.get("timeoutMs")
    timeout_seconds = float(timeout) / 1000 if isinstance(timeout, (int, float)) else None
    process = subprocess.run(
        [command, *args],
        cwd=command_cwd(params),
        env=command_env(params, account),
        stdin=subprocess.DEVNULL,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout_seconds,
        preexec_fn=demote(account),
    )
    result = {"stdout": process.stdout, "stderr": process.stderr, "code": process.returncode}
    if process.returncode != 0:
        raise CommandError(result)
    return result

class CommandError(Exception):
    def __init__(self, result):
        super().__init__("Runtime command failed")
        self.result = result

def stream_output(process_id, stream, stream_type):
    for chunk in iter(lambda: stream.readline(), ""):
        if chunk:
            write({"event": "spawn", "processId": process_id, "type": stream_type, "data": chunk})
    stream.close()

def wait_process(process_id, process):
    code = process.wait()
    with processes_lock:
        processes.pop(process_id, None)
    write({"event": "spawn", "processId": process_id, "type": "exit", "code": code})

def terminate_process(process):
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    except Exception:
        process.terminate()
    try:
        process.wait(timeout=2)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    except Exception:
        process.kill()
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass

def cleanup_processes():
    with processes_lock:
        active = list(processes.values())
    with semantic_processes_lock:
        active.extend(semantic_processes.values())
    for process in active:
        terminate_process(process)

def run_spawn(params):
    command, args = prepare_command(params)
    account = target_user(command_user(params))
    process = subprocess.Popen(
        [command, *args],
        cwd=command_cwd(params),
        env=command_env(params, account),
        stdin=subprocess.DEVNULL,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        preexec_fn=demote(account),
        start_new_session=True,
    )
    process_id = uuid.uuid4().hex
    with processes_lock:
        processes[process_id] = process
    threading.Thread(target=stream_output, args=(process_id, process.stdout, "stdout"), daemon=True).start()
    threading.Thread(target=stream_output, args=(process_id, process.stderr, "stderr"), daemon=True).start()
    threading.Thread(target=wait_process, args=(process_id, process), daemon=True).start()
    return {"processId": process_id}

def run_kill(params):
    process_id = str(params.get("processId") or "")
    with processes_lock:
        process = processes.get(process_id)
    if process and process.poll() is None:
        terminate_process(process)
    return {"stopped": bool(process)}

def runtime_env_file(name):
    if name != ".env" and not name.startswith(".env."):
        return False
    return not name.endswith(env_template_suffixes)

def template_env_file(name):
    return name.startswith(".env") and name.endswith(env_template_suffixes)

def run_scan_env_files(params):
    root = str(params.get("root") or "")
    runtime = []
    templates = []
    for directory, names, files in os.walk(root):
        names[:] = [name for name in names if name not in ignored_env_directories]
        for name in files:
            path = os.path.join(directory, name)
            if runtime_env_file(name):
                runtime.append(path)
            if template_env_file(name):
                templates.append(path)
    return {"runtime": runtime, "templates": templates}

def run_read_existing_files(params):
    result = {}
    for path in params.get("paths") or []:
        path = str(path)
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as file:
                result[path] = file.read()
        else:
            result[path] = None
    return {"files": result}

def run_semantic_workspace(params):
    operation_id = str(params.get("operationId") or "")
    if not operation_id:
        raise RuntimeError("Semantic workspace operation id is required")
    account = target_user("blame")
    request = {
        "input": params.get("input"),
        "taskContract": params.get("taskContract"),
        "tool": params.get("tool"),
        "toolContext": params.get("toolContext"),
        "workspaceRoot": params.get("workspaceRoot"),
    }
    process = subprocess.Popen(
        ["blame-semantic-harness"],
        env=clean_env({}, account),
        stdin=subprocess.PIPE,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        preexec_fn=demote(account),
        start_new_session=True,
    )
    with semantic_processes_lock:
        semantic_processes[operation_id] = process
    try:
        stdout, stderr = process.communicate(json.dumps(request))
    finally:
        with semantic_processes_lock:
            semantic_processes.pop(operation_id, None)
    if process.returncode != 0:
        raise CommandError({"stdout": stdout, "stderr": stderr, "code": process.returncode})
    return json.loads(stdout or "{}")

def run_semantic_workspace_cancel(params):
    operation_id = str(params.get("operationId") or "")
    with semantic_processes_lock:
        process = semantic_processes.get(operation_id)
    if process is not None:
        terminate_process(process)
    return {"stopped": bool(process)}

def npm_root():
    return subprocess.check_output(["npm", "root", "-g"], text=True).strip()

def cline_hub_module_path():
    root = npm_root()
    path = os.path.join(root, "@blame", "semantic-harness-runtime", "vendor", "cline-core", "dist", "index.js")
    if not path:
        raise RuntimeError("Cline SDK is not installed in BlameRuntime")
    if not os.path.exists(path):
        raise RuntimeError("Cline SDK is not installed in BlameRuntime")
    return path

def run_node_json(script, timeout=15):
    process = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        env=clean_env({}, target_user("blame")),
        stdin=subprocess.DEVNULL,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        preexec_fn=demote(target_user("blame")),
    )
    if process.returncode != 0:
        raise CommandError({"stdout": process.stdout, "stderr": process.stderr, "code": process.returncode})
    return json.loads(process.stdout or "{}")

hub_process = None
hub_result_cache = None
hub_lock = threading.Lock()

def read_line_with_timeout(pipe, timeout):
    result = [None]
    def read():
        result[0] = pipe.readline()
    t = threading.Thread(target=read, daemon=True)
    t.start()
    t.join(timeout)
    return result[0]

def cline_hub_build_id():
    module = "file://" + cline_hub_module_path()
    script = f"const hub = await import({json.dumps(module)}); console.log(JSON.stringify({{\"buildId\": hub.resolveHubBuildId()}}));"
    return run_node_json(script)["buildId"]

def run_cline_hub_ensure(params):
    # Serialize the whole startup, including callers from another agent process.
    import fcntl
    os.makedirs("/var/log/blame-runtime", exist_ok=True)
    with hub_lock, open("/var/log/blame-runtime/cline-hub.lock", "a") as lock_file:
        fcntl.flock(lock_file, fcntl.LOCK_EX)
        return ensure_cline_hub_locked(params)

def ensure_cline_hub_locked(params):
    global hub_process, hub_result_cache
    import hashlib
    module = cline_hub_module_path()
    with open(module, "rb") as source:
        fingerprint = runtime_agent_version + ":" + hashlib.sha256(source.read()).hexdigest()
    instance_path = "/var/log/blame-runtime/cline-hub-instance.json"
    try:
        with open(instance_path, "r", encoding="utf-8") as instance_file:
            instance = json.load(instance_file)
    except (OSError, ValueError):
        instance = {}

    import socket

    def is_pid_alive(pid):
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

    def is_port_listening(port):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(1.0)
        try:
            s.connect(("127.0.0.1", port))
            s.close()
            return True
        except Exception:
            return False

    # In VMware nested-virtualisation, the WSL2 localhost proxy (127.0.0.1)
    # does not work. We must use the real WSL2 VM IP. The Hyper-V NAT has a
    # cold-start delay of ~30 s for the first TCP connection; we pre-warm it
    # with a Windows-side curl so Electron always gets a fast route.
    try:
        hub_host = subprocess.run(
            ["hostname", "-I"], stdin=subprocess.DEVNULL, capture_output=True, text=True
        ).stdout.strip().split()[0]
    except Exception:
        hub_host = "127.0.0.1"

    # Try to reuse an existing healthy hub running inside WSL2
    discovery_root = None
    try:
        blame_account = pwd.getpwnam("blame")
        discovery_root = os.path.join(blame_account.pw_dir, ".cline", "data", "locks", "hub")
    except Exception:
        pass

    import time

    expected_build_id = cline_hub_build_id()
    reused = False
    if discovery_root:
        discovery_files = [os.path.join(discovery_root, "production.json")]
        owners_dir = os.path.join(discovery_root, "owners")
        if os.path.isdir(owners_dir):
            discovery_files.extend(
                os.path.join(owners_dir, filename)
                for filename in os.listdir(owners_dir)
                if filename.endswith(".json")
            )
        for filepath in discovery_files:
            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    data = json.load(f)
                pid = data.get("pid")
                authToken = data.get("authToken")
                if (pid and authToken and data.get("buildId") == expected_build_id
                        and instance.get("pid") == pid and instance.get("fingerprint") == fingerprint
                        and is_pid_alive(pid)):
                    # Process is alive. Wait up to 3 seconds for the port to start listening.
                    port_ready = False
                    for _ in range(15):
                        if is_port_listening(25463):
                            port_ready = True
                            break
                        time.sleep(0.2)
                    
                    if port_ready and run_cline_hub_status({}).get("status") == "ready":
                        baseUrl = f"ws://{hub_host}:25463/hub"
                        url = f"{baseUrl}?authToken={authToken}"
                        hub_result_cache = {
                            "action": "connected",
                            "authToken": authToken,
                            "status": "ready",
                            "url": url
                        }
                        reused = True
                        break
            except Exception:
                continue

    if reused:
        return hub_result_cache

    # If we could not reuse, clean up port 25463 and discovery files to avoid EADDRINUSE
    try:
        subprocess.run(["fuser", "-k", "25463/tcp"], stdin=subprocess.DEVNULL, capture_output=True)
    except Exception:
        pass
    if discovery_root:
        try:
            production_file = os.path.join(discovery_root, "production.json")
            if os.path.exists(production_file):
                os.remove(production_file)
            owners_dir = os.path.join(discovery_root, "owners")
            if os.path.isdir(owners_dir):
                for filename in os.listdir(owners_dir):
                    if filename.endswith(".json"):
                        os.remove(os.path.join(owners_dir, filename))
        except Exception:
            pass

    module = cline_hub_module_path()
    ready_read, ready_write = os.pipe()
    script = f"""
import {{ writeSync, closeSync }} from "node:fs";
const hub = await import({json.dumps("file://" + module)});
const result = await hub.ensureHubServer({{
  host: "0.0.0.0",
  port: 25463,
  runtimeHandlers: hub.createLocalHubScheduleRuntimeHandlers()
}});
// Replace host with the actual WSL2 IP, then embed authToken as a query
// parameter so that connectToHub() (which runs on Windows and cannot read
// the WSL2 discovery file) can still authenticate without the discovery file.
const baseUrl = result.url ? result.url.replace(/^ws:\\/\\/[^/]+/, "ws://{hub_host}:25463") : result.url;
const url = baseUrl && result.authToken
  ? baseUrl + "?authToken=" + encodeURIComponent(result.authToken)
  : baseUrl;
writeSync({ready_write}, JSON.stringify({{
  action: result.action,
  authToken: result.authToken,
  status: "ready",
  url: url
}}) + "\\n");
closeSync({ready_write});
"""
    log_path = "/var/log/blame-runtime/cline-hub.log"
    proc = None
    try:
        # The hub outlives the RPC agent. Its logs must never depend on an
        # agent-owned pipe; readiness uses a separate, short-lived descriptor.
        with open(log_path, "a", encoding="utf-8") as log_file:
            log_file.write(f"Starting Cline hub with runtime agent {runtime_agent_version} using {module}\n")
            log_file.flush()
            proc = subprocess.Popen(
                ["node", "--input-type=module", "-e", script],
                env=clean_env({}, target_user("blame")),
                stdin=subprocess.DEVNULL,
                stdout=log_file,
                stderr=log_file,
                pass_fds=(ready_write,),
                text=True,
                preexec_fn=demote(target_user("blame")),
                start_new_session=True,
            )
    finally:
        os.close(ready_write)
        if proc is None:
            os.close(ready_read)

    def monitor_hub(process):
        code = process.wait()
        with open(log_path, "a", encoding="utf-8") as log_file:
            log_file.write(f"Cline hub process {process.pid} exited with code {code}\n")

    threading.Thread(target=monitor_hub, args=(proc,), daemon=True).start()
    with os.fdopen(ready_read, "r", encoding="utf-8") as ready_pipe:
        line = read_line_with_timeout(ready_pipe, 10)
        if not line:
            if proc.poll() is None:
                proc.kill()
            proc.wait()
            raise RuntimeError(f"Cline hub startup failed (exit={proc.returncode}); see {log_path}")
    try:
        result = json.loads(line)
        if result.get("status") != "ready" or not result.get("url"):
            raise ValueError("Cline hub returned an invalid startup result")
        with open(instance_path, "w", encoding="utf-8") as instance_file:
            json.dump({"pid": proc.pid, "fingerprint": fingerprint}, instance_file)
    except Exception:
        proc.kill()
        proc.wait()
        raise
    hub_process = proc
    hub_result_cache = result
    return result

def run_cline_hub_status(params):
    try:
        with urllib.request.urlopen("http://127.0.0.1:25463/health", timeout=3) as response:
            payload = json.loads(response.read().decode("utf-8"))
            return {"status": "ready", "url": payload.get("url")}
    except Exception as error:
        return {"status": "unavailable", "error": str(error)}

def run_cline_hub_stop(params):
    global hub_process, hub_result_cache
    with hub_lock:
        if hub_process is not None:
            hub_process.terminate()
            try:
                hub_process.wait(timeout=5)
            except Exception:
                pass
            hub_process = None
            hub_result_cache = None
        return {"status": "stopped"}

def run_status():
    checks = {
        "version": version(),
        "python": True,
        "docker": os.path.exists("/var/run/docker.sock"),
        "git": subprocess.run(["sh", "-lc", "command -v git"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL).returncode == 0,
        "compose": subprocess.run(["docker", "compose", "version"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0,
    }
    return checks

methods = {
    "exec": run_exec,
    "spawn": run_spawn,
    "kill": run_kill,
    "scanEnvFiles": run_scan_env_files,
    "readExistingFiles": run_read_existing_files,
    "lightWorkspace": run_semantic_workspace,
    "lightWorkspaceCancel": run_semantic_workspace_cancel,
    "clineHubEnsure": run_cline_hub_ensure,
    "clineHubStatus": run_cline_hub_status,
    "clineHubStop": run_cline_hub_stop,
    "status": lambda params: run_status(),
}

def handle(request):
    request_id = request.get("id")
    method = methods.get(request.get("method"))
    if not method:
        write({"id": request_id, "ok": False, "error": {"message": "Unknown method"}})
        return
    try:
        write({"id": request_id, "ok": True, "result": method(request.get("params") or {})})
    except CommandError as error:
        write({"id": request_id, "ok": False, "error": {"message": str(error), **error.result}})
    except Exception as error:
        write({"id": request_id, "ok": False, "error": {"message": str(error)}})

def serve():
    try:
        for line in sys.stdin:
            try:
                req = json.loads(line)
                threading.Thread(target=handle, args=(req,), daemon=True).start()
            except Exception as error:
                write({"id": 0, "ok": False, "error": {"message": str(error)}})
    finally:
        cleanup_processes()

def main():
    try:
        command = sys.argv[1] if len(sys.argv) > 1 else "status"
        if command == "status":
            print("ready")
        elif command == "docker-ensure":
            ensure_docker()
        elif command == "agent-version":
            print(runtime_agent_version)
        elif command == "version":
            print(version())
        elif command == "cline-hub-ensure":
            print(json.dumps(run_cline_hub_ensure({})))
        elif command == "serve":
            serve()
        else:
            os.execvp(command, sys.argv[1:])
    except Exception as e:
        print(str(e), file=sys.stderr)
        log_error(f"Error in main: {e}\n{traceback.format_exc()}")
        sys.exit(1)

if __name__ == "__main__":
    main()
EOF
  chmod 755 /usr/local/bin/blame-runtime-agent
}

write_marker() {
  printf '%s\n' "$runtime_version" >/etc/blame-runtime-version
}

ensure_user
ensure_packages
ensure_node
ensure_package_managers
ensure_semantic_harness
ensure_cline_sdk
remove_external_cli_payloads
ensure_container_stack
ensure_runtime_paths
ensure_docker_config
stop_legacy_container_stack
ensure_agent
ensure_docker_running
migrate_legacy_volumes
remove_legacy_container_stack
trim_guest_services
write_marker
