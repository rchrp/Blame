import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const pythonAvailable =
  process.platform !== "win32" &&
  spawnSync("python3", ["--version"], { stdio: "ignore", timeout: 3_000 }).status === 0;

// Runs the runtime agent's semantic relay against a fake harness on PATH: a
// serving one answers by id from one process; one that never says it is
// ready gets one process per request.
const probe = String.raw`
import json, os, stat, subprocess, sys, tempfile
from pathlib import Path

source = Path(sys.argv[1]).read_text()
body = source.split("cat >/usr/local/bin/blame-runtime-agent <<'EOF'\n", 1)[1].split("\nEOF", 1)[0]
with tempfile.TemporaryDirectory(prefix="blame-semantic-test-") as directory:
    root = Path(directory)
    harness = root / "blame-semantic-harness"
    harness.write_text('''#!/usr/bin/env node
const serve = process.argv.includes("--serve");
const readline = require("node:readline");
if (!serve) {
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => process.stdout.write(JSON.stringify({ pid: process.pid, once: true, tool: JSON.parse(input).tool }) + "\\n"));
} else {
  if (process.env.TEST_NO_READY !== "1") process.stdout.write(JSON.stringify({ ready: true, protocol: 1 }) + "\\n");
  let served = 0;
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.cancel) return process.stdout.write(JSON.stringify({ id: message.id, error: "Semantic workspace operation cancelled." }) + "\\n");
    if (message.request.tool === "hang") return;
    served += 1;
    process.stdout.write(JSON.stringify({ id: message.id, result: { pid: process.pid, served, tool: message.request.tool } }) + "\\n");
  });
}
''')
    harness.chmod(harness.stat().st_mode | stat.S_IEXEC)
    footer = '''
import threading as _threading, time as _time
target_user = lambda _: None
demote = lambda _: None
clean_env = lambda *_: dict(os.environ)
semantic_server_ready_timeout = 2
call = lambda tool, operation: run_semantic_workspace({"operationId": operation, "tool": tool, "workspaceRoot": "/w"})
first = call("read_code", "a")
second = call("search_code", "b")
assert first["pid"] == second["pid"], "Requests went to different harness processes"
assert (first["served"], second["served"]) == (1, 2), (first, second)
assert second["tool"] == "search_code"
# Cancelling an operation in flight goes to the serving harness.
hanging = {}
worker = _threading.Thread(target=lambda: hanging.update(error=_catch(lambda: call("hang", "c"))))
def _catch(run):
    try:
        run()
        return None
    except CommandError as error:
        return error.result["stderr"]
worker.start()
for _ in range(100):
    if "c" in semantic_pending: break
    _time.sleep(0.01)
assert run_semantic_workspace_cancel({"operationId": "c"}) == {"stopped": True}
worker.join(5)
assert "cancelled" in (hanging.get("error") or ""), hanging
# A harness that stops is started again on the next request.
terminate_process(semantic_server)
restarted = call("read_code", "d")
assert restarted["pid"] != first["pid"] and restarted["served"] == 1, restarted
cleanup_processes()
print("ok")
'''
    worker = root / "worker.py"
    worker.write_text(body.replace('if __name__ == "__main__":', 'if False:') + footer)
    env = {**os.environ, "PATH": f"{root}{os.pathsep}{os.environ['PATH']}"}
    result = subprocess.run([sys.executable, str(worker)], capture_output=True, text=True, env=env, timeout=30)
    assert result.returncode == 0 and "ok" in result.stdout, result.stderr
    fallback = '''
target_user = lambda _: None
demote = lambda _: None
clean_env = lambda *_: dict(os.environ)
semantic_server_ready_timeout = 1
result = run_semantic_workspace({"operationId": "a", "tool": "read_code", "workspaceRoot": "/w"})
assert result.get("once") is True and result["tool"] == "read_code", result
print("ok")
'''
    worker.write_text(body.replace('if __name__ == "__main__":', 'if False:') + fallback)
    result = subprocess.run([sys.executable, str(worker)], capture_output=True, text=True, env={**env, "TEST_NO_READY": "1"}, timeout=30)
    assert result.returncode == 0 and "ok" in result.stdout, result.stderr
`;

for (const platform of ["macos", "windows"]) {
  test(`${platform} runtime agent serves semantic requests from one harness, and falls back without one`, { skip: !pythonAvailable }, () => {
    const path = resolve(import.meta.dirname, `../packages/desktop/resources/runtime/${platform}/scripts/provision-blame-runtime.sh`);
    const result = spawnSync("python3", ["-c", probe, path], { encoding: "utf8", timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr || String(result.error));
  });
}
