import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  containerComponentPreviewHost,
  workspaceComponentPreviewHost,
} from "./component-preview-hosts.ts";
import {
  hasViteProject,
  locateComponentPreview,
} from "./component-preview-location.ts";

type SpawnCall = { args: string[]; command: string; options: unknown };

// A child process that exits when it is told to.
function fakeSpawn() {
  const calls: SpawnCall[] = [];
  const spawn = ((command: string, args: string[], options: unknown) => {
    calls.push({ args, command, options });
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      kill: () => {
        child.exitCode = 0;
        queueMicrotask(() => child.emit("exit", 0, null));
        return true;
      },
      pid: undefined,
      signalCode: null,
      stderr: new PassThrough(),
      stdout: new PassThrough(),
    });
    if (args[0] === "rm") queueMicrotask(() => child.emit("exit", 0, null));
    return child;
  }) as never;
  return { calls, spawn };
}

test("the container host runs one more container of the preview service, with only the server's port", async () => {
  const { calls, spawn } = fakeSpawn();
  const host = containerComponentPreviewHost(
    {
      composeFile: "/w/.blame/preview/compose.yaml",
      projectName: "blame_abc",
      serviceId: "web",
      worktree: "/w",
    },
    spawn,
  );
  assert.equal(host.bindHost, "0.0.0.0");
  assert.equal(host.path("packages/app"), "/workspace/packages/app");
  assert.equal(host.path(""), "/workspace");
  const server = host.start(["--input-type=module", "-e", "code"], 45123);
  const [run] = calls;
  assert.equal(run!.command, "docker");
  const name = run!.args[run!.args.indexOf("--name") + 1]!;
  assert.match(name, /^blame_abc-component-preview-[0-9a-f]{8}$/u);
  assert.deepEqual(run!.args, [
    "compose",
    "--ansi",
    "never",
    "--project-name",
    "blame_abc",
    "--file",
    "/w/.blame/preview/compose.yaml",
    "run",
    "--rm",
    "--no-deps",
    "-T",
    "--name",
    name,
    "--publish",
    "127.0.0.1:45123:45123",
    "--entrypoint",
    "node",
    "web",
    "--input-type=module",
    "-e",
    "code",
  ]);
  assert.deepEqual(run!.options, { execution: "virtualized", user: "root" });
  await server.stop();
  // The container goes with the process, even if Docker kept it.
  assert.deepEqual(calls[1]!.args, ["rm", "-f", name]);
});

test("the workspace host runs Node in the worktree, where run_task runs", async () => {
  const { calls, spawn } = fakeSpawn();
  const host = workspaceComponentPreviewHost("/w", spawn);
  assert.equal(host.bindHost, "127.0.0.1");
  assert.equal(host.path(""), "/w");
  assert.equal(host.path("packages/app"), join("/w", "packages", "app"));
  const server = host.start(["-e", "code"], 45123);
  assert.deepEqual(calls[0], {
    args: ["-e", "code"],
    command: "node",
    options: { cwd: "/w" },
  });
  await server.stop();
  await server.exited;
});

test("a preview file is located in its Vite package, with Vite installed in the workspace", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "blame-preview-locate-"));
  try {
    const app = join(worktree, "packages/app");
    await mkdir(join(app, "src"), { recursive: true });
    await mkdir(join(worktree, "packages/web/src"), { recursive: true });
    await writeFile(join(worktree, "package.json"), "{}");
    await writeFile(join(app, "package.json"), "{}");
    await writeFile(join(worktree, "packages/web/package.json"), "{}");
    await writeFile(join(app, "src/card.blame-preview.tsx"), "");
    await writeFile(join(worktree, "packages/web/src/x.blame-preview.tsx"), "");
    const locate = (
      file: string,
      workspaceMode: "direct" | "local-container" = "direct",
    ) => locateComponentPreview({ workspaceMode, worktree }, file);

    assert.match(
      (
        (await locate("packages/app/src/missing.blame-preview.tsx")) as {
          message: string;
        }
      ).message,
      /does not exist/u,
    );
    assert.match(
      (
        (await locate("packages/web/src/x.blame-preview.tsx")) as {
          message: string;
        }
      ).message,
      /^packages\/web has no vite\.config\.\* file/u,
    );
    await writeFile(join(app, "vite.config.ts"), "export default {}");
    assert.match(
      (
        (await locate("packages/app/src/card.blame-preview.tsx")) as {
          message: string;
        }
      ).message,
      /^Vite is not installed for packages\/app in the story's workspace\. open_component_preview never installs dependencies/u,
    );
    // Hoisted to the root, as npm and pnpm workspaces may do.
    await mkdir(join(worktree, "node_modules/vite"), { recursive: true });
    await writeFile(join(worktree, "node_modules/vite/package.json"), "{}");
    const located = await locate("packages/app/src/card.blame-preview.tsx");
    assert.ok("host" in located);
    assert.equal(located.packageDir, "packages/app");
    assert.equal(located.host.key, `workspace:${worktree}`);
  } finally {
    await rm(worktree, { force: true, recursive: true });
  }
});

test("only a project with a Vite config gets the tool", async () => {
  const worktree = await mkdtemp(join(tmpdir(), "blame-preview-vite-"));
  try {
    await mkdir(join(worktree, "node_modules/pkg"), { recursive: true });
    await writeFile(join(worktree, "node_modules/pkg/vite.config.js"), "");
    await writeFile(join(worktree, "next.config.mjs"), "");
    assert.equal(await hasViteProject(worktree), false);
    await mkdir(join(worktree, "packages/app"), { recursive: true });
    await writeFile(join(worktree, "packages/app/vite.config.ts"), "");
    assert.equal(await hasViteProject(worktree), true);
  } finally {
    await rm(worktree, { force: true, recursive: true });
  }
});
