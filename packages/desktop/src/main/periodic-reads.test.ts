import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:http";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

// What the app's periodic reads cost Blame Runtime, counted on a fixed
// scenario: three stories in progress whose agents wait, the drawer open on
// a story's preview, then on its Diff tab, with the window visible, then
// hidden. Each IPC handler runs as in the app, against a test runtime that
// counts the agent's requests and the programs they start (no VM). The
// rates are those the app polls at; keep them in step with its hooks.

// Story worktrees live in Blame Runtime on macOS and Windows only.
Object.defineProperty(process, "platform", { value: "darwin" });
const scratch = await realpath(await mkdtemp(join(tmpdir(), "blame-reads-")));
// Nothing here may reach a real VM.
process.env.LIMA_HOME = join(scratch, "lima");
const electronStub = pathToFileURL(
  join(import.meta.dirname, "electron-test-stub.ts"),
).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "electron")
      return { url: electronStub, shortCircuit: true };
    try {
      return next(specifier, context);
    } catch (error) {
      // Main process sources import without extensions, as Vite resolves them.
      if (!specifier.startsWith(".")) throw error;
      for (const candidate of [
        `${specifier}.ts`,
        specifier.replace(/\.js$/, ".ts"),
        `${specifier}/index.ts`,
      ])
        try {
          return next(candidate, context);
        } catch {}
      throw error;
    }
  },
});

const { RuntimeAgentTestHost } = await import("./runtime-agent-test-host.ts");
const runtime = await RuntimeAgentTestHost.install(join(scratch, "runtime"));
const { ensureRuntimeGitUserIdentity } = await import("./workspace-runtime.ts");
await ensureRuntimeGitUserIdentity({
  execFileAsync: async () => ({ stdout: "Test", stderr: "" }) as never,
  platform: "darwin",
  run: async () => ({ stdout: "", stderr: "" }),
});
const { ipcHandlers, testWindow } = await import("./electron-test-stub.ts");
const { registerWorkspaceIpcHandlers } = await import("./workspace-ipc.ts");
registerWorkspaceIpcHandlers();

const server = createServer((_request, response) => response.end("ok"));
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = (server.address() as AddressInfo).port;
const stories = await Promise.all([1, 2, 3].map(storyWorktree));
runtime.dockerRows = ["web", "api"]
  .map((service) => `${service}\tFalse\trunning\t0\t`)
  .join("\n");

test.after(async () => {
  server.close();
  await rm(scratch, { recursive: true, force: true });
});

type Call = { channel: string; input: unknown };

const stateRead = (story: Story): Call => ({
  channel: "workspace:project-preview-runtime-state",
  input: { worktree: story.worktree, workspaceMode: "local-container" },
});
const previewRecovery = (story: Story): Call => ({
  channel: "workspace:ensure-project-preview-url",
  input: { worktree: story.worktree, workspaceMode: "local-container" },
});
const diffRead = (story: Story): Call => ({
  channel: "workspace:git-diff-from",
  input: { from: story.base, root: story.worktree },
});

// Calls per minute of each poll, from the app's hooks.
type Poll = {
  name: string;
  perMinute: number;
  call: (story: Story) => Call;
  stories: Story[];
};
const drawerStory = stories[0]!;
const scenarios: Record<string, Poll[]> = {
  "preview tab, visible": [
    // use-preview-runtime-polling: every 10 s once settled.
    {
      name: "preview state",
      perMinute: 6,
      call: stateRead,
      stories: [drawerStory],
    },
    // use-backlog-rotation: every 30 s for each active story.
    { name: "preview recovery", perMinute: 2, call: previewRecovery, stories },
    // user-story-diff-stats: every 15 s for each story whose agent waits.
    { name: "card diff stats", perMinute: 4, call: diffRead, stories },
  ],
  "diff tab, visible": [
    // development-workspace: every 1.5 s.
    { name: "diff", perMinute: 40, call: diffRead, stories: [drawerStory] },
    { name: "preview recovery", perMinute: 2, call: previewRecovery, stories },
    { name: "card diff stats", perMinute: 4, call: diffRead, stories },
  ],
  "preview tab, hidden": [
    {
      name: "preview state",
      perMinute: 1,
      call: stateRead,
      stories: [drawerStory],
    },
    { name: "preview recovery", perMinute: 2, call: previewRecovery, stories },
  ],
  "diff tab, hidden": [
    { name: "preview recovery", perMinute: 2, call: previewRecovery, stories },
  ],
};

test("counts the runtime commands of the app's periodic reads", async () => {
  // The first reads set up Git access and adopt hibernated previews.
  for (const story of stories)
    for (const call of [
      stateRead(story),
      previewRecovery(story),
      diffRead(story),
    ])
      await invoke(call);
  const costs = new Map<string, { requests: number; processes: number }>();
  for (const call of [stateRead, previewRecovery, diffRead]) {
    await runtime.reset();
    const result = await invoke(call(drawerStory));
    const count = await runtime.count();
    console.log(call.name, JSON.stringify(count));
    costs.set(call.name, count);
    if (call === diffRead) assert.match(String(result), /untracked-3/);
  }
  const rows = Object.entries(scenarios).map(([scenario, polls]) => {
    let requests = 0;
    let processes = 0;
    for (const poll of polls) {
      const cost = costs.get(poll.call.name)!;
      requests += cost.requests * poll.perMinute * poll.stories.length;
      processes += cost.processes * poll.perMinute * poll.stories.length;
    }
    return { scenario, requests, processes };
  });
  console.table(rows);
});

async function invoke({ channel, input }: Call) {
  const handler = ipcHandlers.get(channel);
  assert.ok(handler, channel);
  testWindow.visible = true;
  return handler({ sender: {} }, input);
}

type Story = Awaited<ReturnType<typeof storyWorktree>>;

async function storyWorktree(index: number) {
  const worktree = join(
    scratch,
    "Library/Application Support/Blame/runtime/worktrees/project",
    `story-${index}`,
  );
  await mkdir(join(worktree, "src"), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: worktree,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: scratch },
    }).trim();
  git("init", "--quiet");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  await writeFile(join(worktree, ".gitignore"), ".blame/\nnode_modules/\n");
  for (let file = 1; file <= 20; file += 1)
    await writeFile(
      join(worktree, "src", `file-${file}.ts`),
      `export const value = ${file};\n`,
    );
  git("add", "-A");
  git("commit", "--quiet", "-m", "base");
  const base = git("rev-parse", "HEAD");
  await writeFile(
    join(worktree, "src", "file-1.ts"),
    "export const value = 10;\n",
  );
  git("commit", "--quiet", "-am", "story work");
  await writeFile(
    join(worktree, "src", "file-2.ts"),
    "export const value = 20;\n",
  );
  for (let file = 1; file <= 3; file += 1)
    await writeFile(
      join(worktree, "src", `untracked-${file}.ts`),
      `export const extra = ${file};\n`,
    );
  await writeFile(join(worktree, ".env.local"), "SECRET=1\n");
  await writePreviewFiles(worktree);
  return { base, worktree };
}

async function writePreviewFiles(worktree: string) {
  const initialization = join(worktree, ".blame/initialization");
  await mkdir(initialization, { recursive: true });
  const endpoint = (port: number) => ({
    id: "http",
    protocol: "http",
    port,
    healthcheck: { type: "http", path: "/", timeoutMs: 10_000 },
  });
  const service = (id: string, containerPort: number) => ({
    id,
    kind: "preview",
    container: { image: "node:22-bookworm-slim" },
    command: "npm run dev",
    endpoints: [endpoint(containerPort)],
  });
  await writeFile(
    join(initialization, "preview-manifest.json"),
    JSON.stringify({
      confidence: "high",
      project: { detectedStack: ["node"] },
      setup: [],
      services: [service("web", 3000), service("api", 4000)],
      caches: [],
      risks: [],
      probes: [],
    }),
  );
  await writeFile(
    join(initialization, "run-configurations.json"),
    JSON.stringify([
      {
        id: "web",
        name: "Web",
        command: "npm run dev",
        cwd: ".",
        category: "web",
        default: true,
        previewService: "web",
        services: ["web", "api"],
        scopes: ["web"],
      },
    ]),
  );
  await writeFile(
    join(initialization, "preview-runtime-state.json"),
    JSON.stringify({
      desiredStatus: "running",
      selectedConfigurationId: "web",
    }),
  );
  await mkdir(join(worktree, ".blame/preview"), { recursive: true });
  await writeFile(
    join(worktree, ".blame/preview/project.json"),
    JSON.stringify({
      projectName: `blame_${worktree.length}`,
      targets: {
        "web:http": { host: "127.0.0.1", port },
        "api:http": { host: "127.0.0.1", port },
      },
      serviceVolumes: {},
      volumeCreatedAt: {},
    }),
  );
}
