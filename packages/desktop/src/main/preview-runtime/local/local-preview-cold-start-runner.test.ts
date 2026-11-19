import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProjectRunConfiguration } from "@blame/agent-runtime";
import { parsePreviewManifest } from "@blame/agent-runtime/preview-manifest";
import { compilePreviewManifest } from "@blame/preview-runtime";
import type { CommandResult, DockerHost } from "@blame/preview-runtime/compose";
import { previewComposeProjectName } from "../../preview-readiness.ts";
import { allocatePreviewHostPorts } from "./local-preview-ports.ts";
import {
  startLocalPreview,
  useLocalDockerHost,
} from "./local-preview-runner.ts";

// Two new stories of a Next.js project start together: the second one
// waits for the first to compile and to save its cache, then starts.

const manifest = {
  confidence: "high",
  project: { detectedStack: ["node"] },
  setup: [],
  services: [
    {
      id: "web",
      kind: "preview",
      container: { image: "node:22-bookworm-slim" },
      command: "npm run dev",
      endpoints: [
        {
          id: "http",
          protocol: "http",
          port: 3000,
          healthcheck: { type: "http", path: "/", timeoutMs: 10_000 },
        },
      ],
    },
  ],
  caches: [],
  risks: [],
  probes: [],
};

const runConfigurations: ProjectRunConfiguration[] = [
  {
    id: "web",
    name: "Web",
    command: "npm run dev",
    cwd: ".",
    category: "web",
    default: true,
    previewService: "web",
    services: ["web"],
    scopes: ["web"],
  },
];

function ok(stdout = ""): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

class ColdHost implements DockerHost {
  readonly events: string[] = [];
  readonly ports = new Map<string, number>();
  readonly servers: Server[] = [];
  private readonly up = new Set<string>();
  releaseCapture!: () => void;
  private readonly captured = new Promise<void>(
    (resolve) => (this.releaseCapture = resolve),
  );

  async run(command: string, args: string[]): Promise<CommandResult> {
    const script = args.find((arg) => arg.includes("\n")) ?? args[1] ?? "";
    if (command === "docker" && args[0] === "compose") {
      const project = args[args.indexOf("--project-name") + 1]!;
      if (args.includes("up")) {
        this.events.push(`up ${project}`);
        this.up.add(project);
        const port = this.ports.get(project);
        if (port) {
          const server = createServer((_request, response) =>
            response.end("ok"),
          );
          server.listen(port, "127.0.0.1");
          await once(server, "listening");
          this.servers.push(server);
        }
      }
      return ok();
    }
    if (command === "docker" && script.includes("echo captured")) {
      this.events.push("capture");
      await this.captured;
      return ok("captured\n");
    }
    if (command === "sh" && script.includes("docker inspect")) {
      const project = args.at(-1)!;
      return ok(this.up.has(project) ? "web\tFalse\trunning\t0\thealthy" : "");
    }
    if (command === "sh" && script.includes("ls -A")) return ok("none\n");
    if (command === "sh" && script.includes("MemAvailable")) return ok("0\n");
    return ok();
  }

  async readFile(path: string) {
    return readFile(path, "utf8").catch(() => undefined);
  }

  async writeFile(path: string, content: string) {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
}

async function story(
  host: ColdHost,
  t: { after: (fn: () => Promise<void>) => void },
) {
  const worktree = await mkdtemp(join(tmpdir(), "blame-cold-start-"));
  t.after(() => rm(worktree, { recursive: true, force: true }));
  await writeFile(
    join(worktree, "package.json"),
    JSON.stringify({ dependencies: { next: "16.4.6" } }),
  );
  const directory = join(worktree, ".blame/initialization");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "preview-manifest.json"),
    JSON.stringify(parsePreviewManifest(manifest)),
  );
  await writeFile(
    join(directory, "run-configurations.json"),
    JSON.stringify(runConfigurations),
  );
  await writeFile(
    join(directory, "preview-runtime-state.json"),
    JSON.stringify({
      desiredStatus: "running",
      selectedConfigurationId: "web",
    }),
  );
  const plan = compilePreviewManifest(parsePreviewManifest(manifest));
  const port = (await allocatePreviewHostPorts(worktree, plan))["web:http"]!;
  // The app answers once Compose started it.
  host.ports.set(previewComposeProjectName(worktree), port);
  return worktree;
}

test("a second cold start waits for the first to compile and save its cache", async (t) => {
  const host = new ColdHost();
  useLocalDockerHost(host);
  t.after(() => host.servers.forEach((server) => server.close()));
  const first = await story(host, t);
  const second = await story(host, t);
  const steps: Record<string, string[]> = { first: [], second: [] };
  const logs: string[] = [];
  const firstStart = startLocalPreview(first, {
    step: (step) => steps.first!.push(step),
    log: (line) => logs.push(line),
  });
  const firstUrl = await firstStart;
  assert.ok(firstUrl);
  assert.match(logs.join(""), /No compile cache to reuse/);

  const secondStart = startLocalPreview(second, {
    step: (step) => steps.second!.push(step),
  });
  for (
    let i = 0;
    i < 50 && !steps.second!.includes("Waiting for another preview to compile");
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(
    host.events.filter((event) => event.startsWith("up")).length,
    1,
  );
  assert.ok(host.events.includes("capture"));

  host.releaseCapture();
  assert.ok(await secondStart);
  assert.equal(host.events.filter((event) => event.startsWith("up")).length, 2);
  const waited = steps.second!.indexOf(
    "Waiting for another preview to compile",
  );
  assert.ok(waited >= 0);
  assert.equal(steps.second![waited + 1], "Starting the app services");
  assert.ok(!steps.first!.includes("Waiting for another preview to compile"));
});
