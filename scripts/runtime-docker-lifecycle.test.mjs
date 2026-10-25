import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const pythonAvailable = process.platform !== "win32" &&
  spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

const probe = String.raw`
import concurrent.futures, os, signal, subprocess, sys, tempfile
from pathlib import Path

source = Path(sys.argv[1]).read_text()
body = source.split("cat >/usr/local/bin/blame-runtime-agent <<'EOF'\n", 1)[1].split("\nEOF", 1)[0]
with tempfile.TemporaryDirectory(prefix="blame-docker-test-") as directory:
    root = Path(directory)
    body = body.replace("/var/log/blame-runtime", str(root / "logs")).replace("/run/lock", str(root / "locks"))
    worker = root / "agent.py"
    worker.write_text(body)
    tool = '''#!'''+sys.executable+'''
import os, sys, time
from pathlib import Path
root = Path(os.environ["TEST_DOCKER_ROOT"])
command = Path(sys.argv[0]).name
if command == "docker":
    sys.exit(0 if (root / "ready").exists() else 1)
if command == "pgrep":
    sys.exit(0 if (root / "running").exists() else 1)
if command == "dockerd":
    with (root / "launches").open("a") as log: log.write(str(os.getpid()) + "\\n")
    if os.environ.get("TEST_DOCKER_FAIL") == "1": sys.exit(1)
    # Widen the race before the daemon is visible, then model a slow boot.
    time.sleep(0.2)
    (root / "running").touch()
    time.sleep(0.4)
    (root / "ready").touch()
    time.sleep(30)
'''
    for name in ["docker", "dockerd", "pgrep"]:
        executable = root / name
        executable.write_text(tool)
        executable.chmod(0o755)
    env = {**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"], "TEST_DOCKER_ROOT": str(root)}
    def ensure():
        return subprocess.run([sys.executable, str(worker), "docker-ensure"], env=env, capture_output=True, text=True, timeout=10)
    def launches():
        return (root / "launches").read_text().splitlines() if (root / "launches").exists() else []
    try:
        with concurrent.futures.ThreadPoolExecutor(3) as pool:
            results = list(pool.map(lambda _: ensure(), range(3)))
        assert all(r.returncode == 0 for r in results), [r.stderr for r in results]
        assert len(launches()) == 1, "Concurrent callers launched multiple daemons"
        assert ensure().returncode == 0
        assert len(launches()) == 1, "Healthy daemon was restarted"
        # A visible process with a socket is not sufficient: wait for readiness.
        (root / "ready").unlink()
        pending = subprocess.Popen([sys.executable, str(worker), "docker-ensure"], env=env)
        import time
        time.sleep(0.4)
        assert pending.poll() is None, "Accepted a daemon before docker info succeeded"
        (root / "ready").touch()
        assert pending.wait(timeout=5) == 0
        assert len(launches()) == 1
    finally:
        for pid in launches():
            try: os.kill(int(pid), signal.SIGTERM)
            except ProcessLookupError: pass
    (root / "running").unlink()
    (root / "ready").unlink()
    (root / "launches").unlink()
    env["TEST_DOCKER_FAIL"] = "1"
    result = ensure()
    assert result.returncode != 0, "Failed daemon reported success"
    assert "Docker Engine did not start" in result.stderr, result.stderr
    assert len(launches()) == 3, "Startup retries must be bounded"
`;

for (const platform of ["macos", "windows"]) {
  test(`${platform} serializes Docker startup across provisioning and agents`, { skip: !pythonAvailable }, () => {
    const script = resolve(`packages/desktop/resources/runtime/${platform}/scripts/provision-blame-runtime.sh`);
    const result = spawnSync("python3", ["-c", probe, script], { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}
