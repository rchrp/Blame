import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  CommandResult,
  DockerHost,
  HostCommandOptions,
} from "@blame/preview-runtime/compose";
import {
  configureLocalPreviewHibernation,
  ensureLocalPreviewAwake,
  hibernateLocalPreview,
  localPreviewHibernated,
  releaseLocalPreviewHibernation,
} from "./local-preview-hibernation.ts";
import {
  hibernateScript,
  unpauseScript,
  wakeScript,
  watchScript,
} from "./local-preview-hibernation-scripts.ts";
import { useLocalDockerHost } from "./local-preview-runner.ts";

type Call = { script: string; args: string[] };

function fakeHost(wakeOutput = "running\t2\nqueue\t16384\nchanged\t3\n") {
  const calls: Call[] = [];
  const watchers: Array<{ args: string[]; output: (chunk: string) => void }> =
    [];
  let hibernating: (() => void) | undefined;
  const host: DockerHost = {
    async run(_command, args, options: HostCommandOptions = {}) {
      const [, script = "", , ...rest] = args;
      const name =
        script === hibernateScript
          ? "hibernate"
          : script === wakeScript
            ? "wake"
            : script === unpauseScript
              ? "unpause"
              : script === watchScript
                ? "watch"
                : "other";
      calls.push({ script: name, args: rest });
      if (name === "watch") {
        watchers.push({ args: rest, output: options.onOutput! });
        return new Promise<CommandResult>((resolve) =>
          options.signal?.addEventListener("abort", () =>
            resolve({ exitCode: 130, stdout: "", stderr: "" }),
          ),
        );
      }
      if (name === "hibernate") {
        await new Promise<void>((resolve) => {
          hibernating = resolve;
          setTimeout(resolve, 20);
        });
        return {
          exitCode: 0,
          stdout:
            "container\tdb\t101\t300000000\t5000000\ncontainer\tweb\t102\t700000000\t13000000\n",
          stderr: "",
        };
      }
      if (name === "wake")
        return { exitCode: 0, stdout: wakeOutput, stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async readFile(path) {
      return path.endsWith("project.json")
        ? JSON.stringify({ projectName: "blame_0123456789ab", targets: {} })
        : undefined;
    },
    async writeFile() {},
  };
  return { host, calls, watchers, finishHibernation: () => hibernating?.() };
}

async function worktree() {
  return mkdtemp(join(tmpdir(), "blame-hibernation-"));
}

function setup(wakeOutput?: string) {
  const fake = fakeHost(wakeOutput);
  const logs: string[] = [];
  const restarts: string[] = [];
  useLocalDockerHost(fake.host);
  configureLocalPreviewHibernation({
    log: (_worktree, line) => logs.push(line),
    restart: async (worktree) => {
      restarts.push(worktree);
    },
  });
  return { ...fake, logs, restarts };
}

test("hibernates a preview and wakes it on its next use", async () => {
  const { calls, logs, watchers } = setup();
  const root = await worktree();
  await ensureLocalPreviewAwake(root, "nothing to wake");
  // Only the one-time look for previews an earlier Blame left paused.
  assert.deepEqual(
    calls.map(({ script }) => script),
    ["other"],
  );
  assert.deepEqual(await hibernateLocalPreview(root), {
    before: 1_000_000_000,
    after: 18_000_000,
  });
  assert.equal(localPreviewHibernated(root), true);
  assert.match(logs[0]!, /hibernated .*: 954 → 17 MiB in 2 containers/);
  assert.deepEqual(watchers[0]?.args.slice(2), ["101", "102"]);
  await ensureLocalPreviewAwake(root, "a screenshot");
  assert.equal(localPreviewHibernated(root), false);
  assert.deepEqual(calls.filter(({ script }) => script === "wake")[0]?.args, [
    "blame_0123456789ab",
    "/tmp/blame-hibernation-blame_0123456789ab",
    root,
  ]);
  assert.match(logs[1]!, /woken for a screenshot .*3 files changed/);
});

test("a use during the hibernation wakes the preview right after it", async () => {
  const { calls } = setup();
  const root = await worktree();
  const hibernation = hibernateLocalPreview(root);
  const awake = ensureLocalPreviewAwake(root, "the agent");
  await Promise.all([hibernation, awake]);
  assert.deepEqual(
    calls
      .map(({ script }) => script)
      .filter((script) => script === "hibernate" || script === "wake"),
    ["hibernate", "wake"],
  );
  assert.equal(localPreviewHibernated(root), false);
});

test("a client connecting to its port wakes it", async () => {
  const { calls, watchers } = setup();
  const root = await worktree();
  await hibernateLocalPreview(root);
  watchers.at(-1)!.output("wake 1");
  watchers.at(-1)!.output("02\n");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.filter(({ script }) => script === "wake").length, 1);
  assert.equal(localPreviewHibernated(root), false);
});

test("restarts a preview whose dependencies changed while it slept", async () => {
  const { restarts, logs } = setup(
    "running\t2\nqueue\t16384\nchanged\t1\ndependency\t/w/pnpm-lock.yaml\n",
  );
  const root = await worktree();
  await hibernateLocalPreview(root);
  await ensureLocalPreviewAwake(root, "the app");
  assert.deepEqual(restarts, [root]);
  assert.match(logs.at(-1)!, /restarting it because pnpm-lock\.yaml changed/);
});

test("a stop unpauses the preview without waking it", async () => {
  const { calls } = setup();
  const root = await worktree();
  await hibernateLocalPreview(root);
  await releaseLocalPreviewHibernation(root);
  assert.equal(localPreviewHibernated(root), false);
  assert.deepEqual(calls.at(-1), {
    script: "unpause",
    args: ["blame_0123456789ab"],
  });
  await ensureLocalPreviewAwake(root, "the app");
  assert.equal(calls.filter(({ script }) => script === "wake").length, 0);
});
