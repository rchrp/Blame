import assert from "node:assert/strict";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parsePreviewManifest } from "@blame/agent-runtime";
import { compilePreviewManifest } from "@blame/preview-runtime";
import type { CommandResult, DockerHost } from "@blame/preview-runtime/compose";
import { parse as parseYaml } from "yaml";
import { allocatePreviewHostPorts } from "./local-preview-ports.ts";
import { renderLocalPreview } from "./local-preview-render.ts";
import {
  localPreviewUrl,
  startLocalPreview,
  useLocalDockerHost,
} from "./local-preview-runner.ts";

const manifest = {
  confidence: "high",
  project: { detectedStack: ["node"] },
  setup: [
    {
      id: "install",
      container: { image: "node:22-bookworm-slim" },
      command: "npm install",
    },
  ],
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
      bindings: [
        {
          target: { type: "environment", key: "PUBLIC_API_URL" },
          source: { service: "api", endpoint: "http" },
          exposure: "browser",
        },
      ],
    },
    {
      id: "api",
      kind: "preview",
      container: { image: "node:22-bookworm-slim" },
      workingDir: "/workspace/apps/api",
      command: "npm start",
      endpoints: [
        {
          id: "http",
          protocol: "http",
          port: 4000,
          healthcheck: { type: "http", path: "/", timeoutMs: 10_000 },
        },
      ],
    },
  ],
  caches: [],
  risks: [],
  probes: [],
};

test("keeps the ports of the previous start while they are free or ours", async (t) => {
  const worktree = await worktreeFixture(t);
  const plan = compilePreviewManifest(parsePreviewManifest(manifest));
  const first = await allocatePreviewHostPorts(worktree, plan);
  assert.deepEqual(Object.keys(first).sort(), ["api:http", "web:http"]);
  assert.deepEqual(await allocatePreviewHostPorts(worktree, plan), first);
  const busy = await listen(first["web:http"]!, t);
  void busy;
  const moved = await allocatePreviewHostPorts(worktree, plan);
  assert.notEqual(moved["web:http"], first["web:http"]);
  await writeFile(
    join(worktree, ".blame/initialization/preview-ports.json"),
    JSON.stringify({ "web:3000": first["web:http"] }),
  );
  const kept = await allocatePreviewHostPorts(
    worktree,
    plan,
    new Set([first["web:http"]!]),
  );
  assert.equal(kept["web:http"], first["web:http"], "legacy key, own port");
});

test("renders the worktree with its env files bound to the published ports", async (t) => {
  const worktree = await worktreeFixture(t);
  await writeFile(
    join(worktree, ".env"),
    "NEXTAUTH_URL=http://localhost:3000\nPUBLIC_API_URL=http://localhost:4000\n",
  );
  const plan = compilePreviewManifest(parsePreviewManifest(manifest));
  const local = await renderLocalPreview({ worktree, plan });
  const compose = parseYaml(local.rendered.yaml) as {
    services: Record<string, { volumes?: string[]; user?: string }>;
  };
  const webPort = local.hostPorts["web:http"];
  const apiPort = local.hostPorts["api:http"];
  const override = join(worktree, ".blame/env-overrides/.env");
  assert.equal(
    await readFile(override, "utf8"),
    `NEXTAUTH_URL=http://localhost:${webPort}\nPUBLIC_API_URL=http://localhost:${apiPort}\nNEXT_PUBLIC_APP_URL=http://localhost:${webPort}\n`,
  );
  assert.ok(
    compose.services.web!.volumes!.includes(`${override}:/workspace/.env:ro`),
  );
  const owner = await stat(worktree);
  assert.equal(compose.services.web!.user, `${owner.uid}:${owner.gid}`);
  assert.equal(local.previewOrigin, `http://localhost:${webPort}`);
  assert.ok((await stat(join(worktree, "node_modules"))).isDirectory());
  assert.ok(
    (await stat(join(worktree, "apps/api/node_modules"))).isDirectory(),
  );
});

test("worktrees with the same dependency manifests share their installs", async (t) => {
  const plan = compilePreviewManifest(parsePreviewManifest(manifest));
  const first = await renderLocalPreview({
    worktree: await worktreeFixture(t),
    plan,
  });
  const second = await renderLocalPreview({
    worktree: await worktreeFixture(t),
    plan,
  });
  assert.equal(first.dependencyKey, second.dependencyKey);
  const changed = await worktreeFixture(t);
  await writeFile(
    join(changed, "package.json"),
    JSON.stringify({ name: "fixture", dependencies: { ms: "2.1.3" } }),
  );
  const third = await renderLocalPreview({ worktree: changed, plan });
  assert.notEqual(third.dependencyKey, first.dependencyKey);
});

test("restarts the selected run configuration and returns its preview URL", async (t) => {
  const worktree = await worktreeFixture(t);
  const plan = compilePreviewManifest(parsePreviewManifest(manifest));
  const ports = await allocatePreviewHostPorts(worktree, plan);
  const host = new FakeDockerHost();
  useLocalDockerHost(host);
  await listen(ports["web:http"]!, t);
  await listen(ports["api:http"]!, t);
  await writeLocalFiles(worktree, {
    desiredStatus: "running",
    selectedConfigurationId: "web",
  });
  // A restart: the running containers already publish these ports.
  await mkdir(join(worktree, ".blame/preview"), { recursive: true });
  await writeFile(
    join(worktree, ".blame/preview/project.json"),
    JSON.stringify({
      projectName: "blame_000000000000",
      targets: Object.fromEntries(
        Object.entries(ports).map(([key, port]) => [
          key,
          { host: "127.0.0.1", port },
        ]),
      ),
      serviceVolumes: {},
      volumeCreatedAt: {},
    }),
  );
  const steps: string[] = [];
  const url = await startLocalPreview(worktree, {
    step: (step) => steps.push(step),
  });
  assert.equal(url, `http://localhost:${ports["web:http"]}/`);
  const up = host.commands.find((command) => command.includes("up"))!;
  assert.deepEqual(up.slice(-2), ["web", "api"]);
  assert.ok(
    host.commands.some((command) => command.at(-1) === "setup-install"),
  );
  assert.deepEqual(steps, [
    "Downloading container images",
    "Running setup task install",
    "Downloading container images",
    "Starting the app services",
    "Waiting for the app to answer",
  ]);
  assert.equal(await localPreviewUrl(worktree), url);
});

class FakeDockerHost implements DockerHost {
  readonly commands: string[][] = [];

  async run(command: string, args: string[]): Promise<CommandResult> {
    this.commands.push([command, ...args]);
    if (command === "sh") {
      const names = [
        ...args[1]!.matchAll(/docker volume create .* '([^']+)'/g),
      ].map((match) => match[1]!);
      return ok(names.map((name) => `${name}\tcreated\n`).join(""));
    }
    if (args.includes("ps") && args.includes("--format")) {
      return ok(
        ["web", "api"]
          .map((service) =>
            JSON.stringify({
              Service: service,
              State: "running",
              Health: "healthy",
            }),
          )
          .join("\n"),
      );
    }
    return ok("");
  }

  async readFile(path: string) {
    return readFile(path, "utf8").catch(() => undefined);
  }

  async writeFile(path: string, content: string) {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
}

async function writeLocalFiles(
  worktree: string,
  state: Record<string, unknown>,
) {
  const directory = join(worktree, ".blame/initialization");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "preview-manifest.json"),
    JSON.stringify(parsePreviewManifest(manifest)),
  );
  await writeFile(
    join(directory, "run-configurations.json"),
    JSON.stringify([
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
    ]),
  );
  await writeFile(
    join(directory, "preview-runtime-state.json"),
    JSON.stringify(state),
  );
}

async function worktreeFixture(t: {
  after: (fn: () => Promise<void>) => void;
}) {
  const worktree = await mkdtemp(join(tmpdir(), "blame-local-preview-"));
  t.after(() => rm(worktree, { recursive: true, force: true }));
  await mkdir(join(worktree, "apps/api"), { recursive: true });
  await writeFile(
    join(worktree, "package.json"),
    JSON.stringify({ name: "fixture" }),
  );
  return worktree;
}

async function listen(port: number, t: { after: (fn: () => void) => void }) {
  const server: Server = createServer((_request, response) =>
    response.end("ok"),
  );
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return server;
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}
