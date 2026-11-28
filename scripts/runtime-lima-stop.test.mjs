import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const script = resolve("packages/desktop/resources/runtime/macos/scripts/blame-lima-runtime.sh");
const supported = process.platform !== "win32" &&
  spawnSync("sh", ["-c", "command -v pkill"], { stdio: "ignore" }).status === 0;

// Lima's list reports the agent while its PID lives; a graceful stop signals
// it and waits for it to exit, as long as that takes.
const fakeLimactl = String.raw`#!/bin/sh
state="$LIMA_HOME/BlameRuntime"
case "$1" in
  --version) echo "limactl version 2.2.1" ;;
  list)
    pid="$(cat "$state/ha.pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      printf '{"name":"BlameRuntime","status":"Running","hostAgentPID":%s}\n' "$pid"
    else
      printf '{"name":"BlameRuntime","status":"Stopped"}\n'
    fi
    ;;
  stop)
    shift
    printf '%s\n' "stop $*" >>"$LIMA_HOME/calls"
    pid="$(cat "$state/ha.pid")"
    if [ "$1" = "-f" ]; then
      kill -KILL "$pid"
      exit 0
    fi
    kill -INT "$pid"
    while kill -0 "$pid" 2>/dev/null; do sleep 0.1; done
    ;;
esac
`;

// healthy exits on SIGINT. hung forks a child that never returns and exits
// once it dies. wedged never exits, even after that child is gone.
const fakeHostAgent = String.raw`#!/bin/sh
state="$LIMA_HOME/BlameRuntime"
on_interrupt() {
  [ "$1" = healthy ] && exit 0
  sleep 1000 &
  printf '%s\n' "$!" >"$state/child.pid"
  wait "$!"
  [ "$1" = hung ] && exit 0
  trap '' INT
  while :; do sleep 0.2; done
}
trap 'on_interrupt "$1"' INT
printf '%s\n' "$$" >"$state/ha.pid"
while :; do sleep 0.1; done
`;

async function fixture(mode) {
  const root = await mkdtemp(join(tmpdir(), "blame-lima-stop-"));
  const bin = join(root, "bin");
  const lima = join(root, "lima");
  await mkdir(bin);
  await mkdir(join(lima, "BlameRuntime"), { recursive: true });
  for (const [name, body] of [
    ["limactl", fakeLimactl],
    ["host-agent", fakeHostAgent],
    // shlock is macOS-only; the lock itself is not under test.
    ["shlock", "#!/bin/sh\nexit 0\n"],
  ]) {
    await writeFile(join(bin, name), body);
    await chmod(join(bin, name), 0o755);
  }
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    LIMA_HOME: lima,
    BLAME_LIMA_BIN: join(bin, "limactl"),
    BLAME_LIMA_STOP_SECONDS: "1",
    BLAME_LIMA_UNBLOCK_SECONDS: "1",
  };
  const agent = spawn(join(bin, "host-agent"), [mode], { env, stdio: "ignore" });
  const exited = new Promise((done) => agent.once("exit", done));
  const pidFile = join(lima, "BlameRuntime", "ha.pid");
  for (let attempt = 0; !(await readFile(pidFile, "utf8").catch(() => "")); attempt += 1) {
    assert.ok(attempt < 50, "The fake host agent did not start");
    await new Promise((done) => setTimeout(done, 100));
  }
  return { root, lima, env, agent, exited };
}

// Without the fallback, a stop waits for the agent forever: fail instead.
async function stopRuntime({ env }) {
  const child = spawn("sh", [script, "stop"], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const timer = setTimeout(() => {
    stderr += "The stop did not finish within 20 s.";
    child.kill("SIGKILL");
  }, 20_000);
  const status = await new Promise((done) => child.once("exit", done));
  clearTimeout(timer);
  return { status, stderr };
}

async function calls(lima) {
  return (await readFile(join(lima, "calls"), "utf8")).trim().split("\n");
}

async function childAlive(lima) {
  const pid = Number(await readFile(join(lima, "BlameRuntime", "child.pid"), "utf8"));
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cleanUp({ root, agent, lima }) {
  agent.kill("SIGKILL");
  const childPid = await readFile(join(lima, "BlameRuntime", "child.pid"), "utf8").catch(() => "");
  if (childPid) try { process.kill(Number(childPid), "SIGKILL"); } catch {}
  await rm(root, { recursive: true, force: true });
}

test("a host agent that stops on its own needs no forced stop", { skip: !supported }, async () => {
  const runtime = await fixture("healthy");
  try {
    const result = await stopRuntime(runtime);
    assert.equal(result.status, 0, result.stderr);
    await runtime.exited;
    assert.deepEqual(await calls(runtime.lima), ["stop BlameRuntime"]);
  } finally {
    await cleanUp(runtime);
  }
});

test("a child stuck in fork is killed so the host agent finishes stopping", { skip: !supported }, async () => {
  const runtime = await fixture("hung");
  try {
    const result = await stopRuntime(runtime);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await runtime.exited, 0, "The host agent finished its own shutdown");
    assert.equal(await childAlive(runtime.lima), false);
    assert.deepEqual(await calls(runtime.lima), ["stop BlameRuntime"]);
  } finally {
    await cleanUp(runtime);
  }
});

test("a host agent that never exits is force-stopped without orphans", { skip: !supported }, async () => {
  const runtime = await fixture("wedged");
  try {
    const result = await stopRuntime(runtime);
    assert.equal(result.status, 0, result.stderr);
    await runtime.exited;
    assert.equal(await childAlive(runtime.lima), false);
    assert.deepEqual(await calls(runtime.lima), ["stop BlameRuntime", "stop -f BlameRuntime"]);
  } finally {
    await cleanUp(runtime);
  }
});
