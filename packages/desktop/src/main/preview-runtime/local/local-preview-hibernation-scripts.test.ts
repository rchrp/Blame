import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseHibernation,
  parsePausedPreviews,
  parseWake,
  wakeRestartReason,
  watchScript,
} from "./local-preview-hibernation-scripts.ts";

const header =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
// Port 3000 (0BB8) listens; 5432 (1538) is a connection to a database.
const listening =
  "   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1";
const outbound =
  "   1: 0200A8C0:9C40 0300A8C0:1538 01 00000000:00000010 00:00000000 00000000  1000        0 2 1";
const idleSocket =
  "   2: 0200A8C0:0BB8 010011AC:D431 01 00000000:00000000 00:00000000 00000000  1000        0 3 1";
const newSocket =
  "   3: 0200A8C0:0BB8 010011AC:D432 01 00000000:00000000 00:00000000 00000000  1000        0 4 1";
const waitingRequest =
  "   2: 0200A8C0:0BB8 010011AC:D431 01 00000000:000001A0 00:00000000 00000000  1000        0 3 1";

async function proc(pid: number, rows: string[]) {
  const root = await mkdtemp(join(tmpdir(), "blame-watch-"));
  await writeNet(root, pid, rows);
  return root;
}

async function writeNet(root: string, pid: number, rows: string[]) {
  await mkdir(join(root, String(pid), "net"), { recursive: true });
  await writeFile(
    join(root, String(pid), "net", "tcp"),
    [header, ...rows].join("\n") + "\n",
  );
}

function watch(root: string, ticks: number, pids: number[]) {
  const child = spawn(
    "sh",
    ["-c", watchScript, "sh", root, String(ticks), ...pids.map(String)],
    { env: { ...process.env, BLAME_WATCH_INTERVAL: "0.5" } },
  );
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  return new Promise<string>((resolve) =>
    child.once("exit", () => resolve(stdout)),
  );
}

test("the watcher ignores connections open when the watch began", async () => {
  const root = await proc(41, [listening, idleSocket, outbound]);
  try {
    assert.equal(await watch(root, 3, [41]), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the watcher wakes on a new connection to a listening port", async () => {
  const root = await proc(41, [listening, idleSocket]);
  try {
    const output = watch(root, 4, [41, 42]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await writeNet(root, 41, [listening, idleSocket, newSocket]);
    assert.equal(await output, "wake 41\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the watcher wakes on a request waiting on a kept-alive connection", async () => {
  const root = await proc(7, [listening, idleSocket]);
  try {
    const output = watch(root, 4, [7]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await writeNet(root, 7, [listening, waitingRequest]);
    assert.equal(await output, "wake 7\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reads what a hibernation and a wake reported", () => {
  assert.deepEqual(
    parseHibernation("container\tabc\t12\t700000000\t13000000\nnoise\n"),
    [{ id: "abc", pid: 12, memoryBefore: 700000000, memoryAfter: 13000000 }],
  );
  assert.deepEqual(
    parseWake(
      "running\t2\nqueue\t16384\nchanged\t3\ndependency\t/w/pnpm-lock.yaml\n",
    ),
    {
      running: 2,
      inotifyQueue: 16384,
      changed: 3,
      dependencyInputs: ["/w/pnpm-lock.yaml"],
    },
  );
});

test("groups paused containers by worktree", () => {
  assert.deepEqual(
    parsePausedPreviews(
      [
        "/w/a/.blame/preview\t10\tblame_aaaaaaaaaaaa",
        "/w/a/.blame/preview\t11\tblame_aaaaaaaaaaaa",
        "/elsewhere\t12\tother",
      ].join("\n"),
    ),
    [
      {
        worktree: "/w/a",
        projectName: "blame_aaaaaaaaaaaa",
        pids: [10, 11],
        containers: 2,
      },
    ],
  );
});

test("restarts a woken preview only when it cannot serve current code", () => {
  const report = { running: 2, inotifyQueue: 16384, dependencyInputs: [] };
  assert.equal(wakeRestartReason({ ...report, changed: 40 }, 2), undefined);
  assert.match(
    wakeRestartReason({ ...report, running: 1 }, 2) ?? "",
    /containers stopped/,
  );
  assert.match(
    wakeRestartReason(
      { ...report, dependencyInputs: ["/w/app/package.json"] },
      2,
    ) ?? "",
    /^package\.json changed/,
  );
  assert.match(
    wakeRestartReason({ ...report, changed: 5000 }, 2) ?? "",
    /5000 files changed/,
  );
});

test("a watcher left behind ends once a newer one starts", async () => {
  const root = await proc(9, [listening, idleSocket]);
  try {
    const started = Date.now();
    const older = watch(root, 40, [9]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const newer = watch(root, 1, [9]);
    assert.equal(await older, "");
    assert.ok(Date.now() - started < 5_000);
    await newer;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
