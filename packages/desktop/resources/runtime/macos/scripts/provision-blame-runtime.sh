set -eu

runtime_version="${1:-9}"
runtime_root="/home/blame/.local/share/blame/runtime"
package_manager_root="/opt/blame/package-managers"
cline_sdk_version="${BLAME_CLINE_SDK_VERSION:-${2:-0.0.95}}"
nerdctl_version="${BLAME_NERDCTL_VERSION:-2.1.6}"
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
  fs.existsSync(sdkEntry) && fs.existsSync(path.join(coreRoot, "dist/image-token-estimation.js"))
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

ensure_container_stack() {
  if nerdctl --version 2>/dev/null | grep -q "nerdctl version ${nerdctl_version}" && command -v buildkitd >/dev/null 2>&1 && [ -x /usr/local/libexec/cni/bridge ]; then
    return
  fi
  arch="$(runtime_architecture)"
  archive="nerdctl-full-${nerdctl_version}-linux-${arch}.tar.gz"
  url="https://github.com/containerd/nerdctl/releases/download/v${nerdctl_version}/${archive}"
  temp_dir="$(mktemp -d)"
  curl -fsSL "$url" -o "$temp_dir/$archive"
  printf '%s  %s\n' "$(nerdctl_archive_sha256 "$arch")" "$temp_dir/$archive" | sha256sum -c - >/dev/null
  tar -C /usr/local -xzf "$temp_dir/$archive" \
    bin/buildctl \
    bin/buildkitd \
    bin/containerd \
    bin/containerd-shim-runc-v2 \
    bin/nerdctl \
    bin/runc \
    bin/tini \
    libexec/cni/bridge \
    libexec/cni/firewall \
    libexec/cni/host-local \
    libexec/cni/loopback \
    libexec/cni/portmap \
    libexec/cni/tuning
  rm -rf "$temp_dir"
}

nerdctl_archive_sha256() {
  case "$nerdctl_version:$1" in
    2.1.6:amd64) printf '%s' "c30545867913696210991fe055761ae2e2d36344da2a351bcd1073fb5c71e232" ;;
    2.1.6:arm64) printf '%s' "2f98346ed3dcaf47cfd6461a5685e582284329a1ece1d952ade881b9fe7491e8" ;;
    *)
      if [ -z "${BLAME_NERDCTL_SHA256:-}" ]; then
        printf '%s\n' "BLAME_NERDCTL_SHA256 is required for nerdctl $nerdctl_version on $1." >&2
        return 1
      fi
      printf '%s' "$BLAME_NERDCTL_SHA256"
      ;;
  esac
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

ensure_containerd_config() {
  mkdir -p /etc/containerd /var/lib/containerd /run/containerd
  if [ ! -s /etc/containerd/config.toml ] && command -v containerd >/dev/null 2>&1; then
    containerd config default >/etc/containerd/config.toml
  fi
}

ensure_containerd_running() {
  if [ "${BLAME_RUNTIME_BAKE:-0}" = "1" ]; then
    return
  fi
  if pgrep -x containerd >/dev/null 2>&1; then
    wait_for_containerd
    return
  fi
  mkdir -p /var/log/blame-runtime
  nohup containerd >/var/log/blame-runtime/containerd.log 2>&1 &
  wait_for_containerd
}

wait_for_containerd() {
  attempt=0
  while [ "$attempt" -lt 30 ]; do
    if [ -S /run/containerd/containerd.sock ]; then
      return
    fi
    attempt=$((attempt + 1))
    sleep 0.1
  done
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
runtime_agent_version = "8"

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

def ensure_containerd():
    if subprocess.run(["pgrep", "-x", "containerd"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        return
    os.makedirs("/run/containerd", exist_ok=True)
    os.makedirs("/var/log/blame-runtime", exist_ok=True)
    log = open("/var/log/blame-runtime/containerd.log", "ab")
    subprocess.Popen(["containerd"], stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)

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
    if command == "nerdctl":
        ensure_containerd()
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

    # Try to reuse an existing healthy hub running inside Lima
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
                        url = f"ws://127.0.0.1:25463/hub?authToken={authToken}"
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

    # Bind on 0.0.0.0 so the hub is reachable on all interfaces, but tell
    # the host to connect via 127.0.0.1 so it uses the fast Lima localhost
    # proxy rather than routing through the virtual switch.
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
const url = result.url ? result.url.replace(/^ws:\\/\\/[^/]+/, "ws://127.0.0.1:25463") : result.url;
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
        "containerd": os.path.exists("/run/containerd/containerd.sock"),
        "git": subprocess.run(["sh", "-lc", "command -v git"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL).returncode == 0,
        "nerdctl": subprocess.run(["sh", "-lc", "command -v nerdctl"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL).returncode == 0,
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
    command = sys.argv[1] if len(sys.argv) > 1 else "status"
    if command == "status":
        print("ready")
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

if __name__ == "__main__":
    main()
EOF
  chmod 755 /usr/local/bin/blame-runtime-agent
}

write_marker() {
  printf '%s\n' "$runtime_version" >/etc/blame-runtime-version
}

cd /
ensure_user
ensure_packages
ensure_node
ensure_package_managers
ensure_semantic_harness
ensure_cline_sdk
remove_external_cli_payloads
ensure_container_stack
ensure_runtime_paths
ensure_containerd_config
ensure_containerd_running
ensure_agent
write_marker
