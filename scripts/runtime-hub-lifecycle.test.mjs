import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const pythonAvailable =
  process.platform !== "win32" &&
  spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const probe = String.raw`
import concurrent.futures, json, os, signal, socket, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path

source = Path(sys.argv[1]).read_text()
body = source.split("cat >/usr/local/bin/blame-runtime-agent <<'EOF'\n", 1)[1].split("\nEOF", 1)[0]
with tempfile.TemporaryDirectory(prefix="blame-hub-test-") as directory:
    root = Path(directory)
    home = root / "home"
    discovery = home / ".cline/data/locks/hub/production.json"
    discovery.parent.mkdir(parents=True)
    log = root / "logs"
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    sdk = root / "sdk.mjs"
    sdk.write_text('''import fs from "node:fs";
import http from "node:http";
export function resolveHubBuildId() { return "same-sdk-version"; }
export function createLocalHubScheduleRuntimeHandlers() { return {}; }
export async function ensureHubServer({port}) {
  console.log("startup log before readiness");
  process.stdout.on("error", () => process.exit(71));
  if (process.env.TEST_HUB_TIMEOUT === "1") {
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  await new Promise(resolve => setTimeout(resolve, 750));
  const server = http.createServer((req, res) => {
    process.stdout.write("runtime log ".repeat(25000) + "\\n");
    res.end(JSON.stringify({ok:true}));
  });
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  fs.writeFileSync(process.env.TEST_DISCOVERY, JSON.stringify({pid:process.pid,authToken:"test",buildId:resolveHubBuildId()}));
  return {action:"started",authToken:"test",url:"ws://127.0.0.1:" + port + "/hub"};
}
''')
    body = body.replace('"/var/log/blame-runtime', json.dumps(str(log))[:-1])
    body = body.replace('25463', str(port))
    worker = root / "worker.py"
    footer = '''
from types import SimpleNamespace
pwd = SimpleNamespace(getpwnam=lambda _: SimpleNamespace(pw_dir=os.environ["TEST_HOME"]))
target_user = lambda _: None
demote = lambda _: None
clean_env = lambda *_: dict(os.environ)
cline_hub_module_path = lambda: os.environ["TEST_SDK"]
real_run = subprocess.run
def safe_run(args, **kwargs):
    if args[0] == "hostname":
        return SimpleNamespace(stdout="127.0.0.1")
    if args[0] == "fuser":
        try:
            pid = json.loads(open(os.environ["TEST_DISCOVERY"]).read())["pid"]
            os.kill(pid, signal.SIGTERM)
            for _ in range(50):
                with socket.socket() as probe:
                    if probe.connect_ex(("127.0.0.1", int(os.environ["TEST_PORT"]))) != 0: break
                time.sleep(0.01)
        except (FileNotFoundError, ProcessLookupError): pass
        return SimpleNamespace(returncode=0)
    return real_run(args, **kwargs)
import socket, time
subprocess.run = safe_run
# Scale the startup clock: 750 ms exceeds the former 10 s budget / 20,
# while leaving headroom in the new budget for slower CI machines.
real_read_line = read_line_with_timeout
read_line_with_timeout = lambda pipe, timeout: real_read_line(pipe, timeout / 20)
try:
    result = run_cline_hub_ensure({})
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
print(json.dumps({"action":result["action"],"status":result["status"]}), flush=True)
'''
    worker.write_text(body.replace('if __name__ == "__main__":', 'if False:') + footer)
    env = {**os.environ, "TEST_HOME": str(home), "TEST_DISCOVERY": str(discovery), "TEST_SDK": str(sdk), "TEST_PORT": str(port)}
    def ensure():
        result = subprocess.run([sys.executable, str(worker)], capture_output=True, text=True, env=env, timeout=15)
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)
    def pid():
        return json.loads(discovery.read_text())["pid"]
    def health():
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as response:
            assert response.status == 200
    try:
        assert ensure()["action"] == "started"
        first = pid()
        # The launcher has exited. Large logs must not block or kill the hub.
        for _ in range(3):
            health()
            time.sleep(0.05)
        assert "runtime log" in (log / "cline-hub.log").read_text()
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda _: ensure(), range(2)))
        assert all(r["action"] == "connected" for r in results), results
        assert pid() == first, "Concurrent agents replaced a healthy hub"
        # Same declared SDK version but different contents must replace it.
        sdk.write_text(sdk.read_text() + "\n// updated payload\n")
        assert ensure()["action"] == "started"
        second = pid()
        assert second != first
        health()
        os.kill(second, signal.SIGTERM)
        time.sleep(0.15)
        # Concurrent cold starts must launch exactly one replacement.
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda _: ensure(), range(2)))
        assert sorted(r["action"] for r in results) == ["connected", "started"], results
        health()
        os.kill(pid(), signal.SIGTERM)
        time.sleep(0.15)
        env["TEST_HUB_TIMEOUT"] = "1"
        failed = subprocess.run([sys.executable, str(worker)], capture_output=True, text=True, env=env, timeout=15)
        assert failed.returncode != 0, "A hub that never becomes ready must time out"
        assert "Cline hub startup timed out after 60 seconds" in failed.stderr, failed.stderr
        assert "exit=-9" not in failed.stderr, failed.stderr
    finally:
        try: os.kill(pid(), signal.SIGTERM)
        except (FileNotFoundError, ProcessLookupError): pass
`;

for (const platform of ["macos", "windows"]) {
  test(
    `${platform} hub handles delayed readiness, concurrent starts, SDK replacement, and startup timeouts`,
    { skip: !pythonAvailable },
    () => {
      const path = resolve(
        import.meta.dirname,
        `../packages/desktop/resources/runtime/${platform}/scripts/provision-blame-runtime.sh`,
      );
      const result = spawnSync("python3", ["-c", probe, path], {
        encoding: "utf8",
        timeout: 60_000,
      });
      assert.equal(result.status, 0, result.stderr || String(result.error));
    },
  );
}
