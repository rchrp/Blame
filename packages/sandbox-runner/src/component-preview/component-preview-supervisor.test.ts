import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  componentPreviewSandbox,
  type PreviewExecutionPlan,
} from "@blame/preview-runtime";
import type { GatewayRoute } from "../gateway/http-forwarder.js";
import type { RunnerRuntimeState } from "../runtime-state.js";
import {
  ComponentPreviewSupervisor,
  componentPreviewContainerName,
  componentPreviewExcludeContent,
  componentPreviewServiceId,
  excludeComponentPreviewFiles,
} from "./component-preview-supervisor.js";

type Result = { exitCode: number; stderr: string; stdout: string };

const routeId = "a".repeat(40);
const nodeArguments = [
  "--input-type=module",
  "-e",
  "script",
  "--",
  "/workspace/web",
];

function plan(services: Array<{ id: string; kind: string }>) {
  return {
    services,
    networking: {
      gatewayListeners: [{ sandboxPort: 43_000, serviceId: "web" }],
    },
  } as unknown as PreviewExecutionPlan;
}

function runningState(overrides: Partial<RunnerRuntimeState> = {}) {
  return {
    browserBindingUrls: {},
    endpointRevision: 1,
    generation: 4,
    plan: plan([
      { id: "db", kind: "dependency" },
      { id: "web", kind: "preview" },
    ]),
    prepared: true,
    routeIds: {},
    running: true,
    sessionId: "preview_1",
    ...overrides,
  } satisfies RunnerRuntimeState;
}

// The sandbox's Docker engine and the component preview gateway, simulated.
function simulatedSandbox(
  run: Result = { exitCode: 0, stderr: "", stdout: "" },
) {
  const commands: string[][] = [];
  const gatewayStarts: GatewayRoute[][] = [];
  let gatewayRunning = false;
  let logs = { stderr: "", stdout: "" };
  let container: "none" | "running" | "exited" = "none";
  const ok = (stdout = ""): Result => ({ exitCode: 0, stderr: "", stdout });
  const supervisor = new ComponentPreviewSupervisor({
    compose: {
      composeCommand: async (args) => {
        commands.push(["compose", ...args]);
        if (run.exitCode === 0) container = "running";
        return run;
      },
      docker: async (args) => {
        commands.push(["docker", ...args]);
        if (args[0] === "rm") container = "none";
        if (args[0] === "logs")
          return container === "none"
            ? { exitCode: 1, stderr: "No such container", stdout: "" }
            : { exitCode: 0, ...logs };
        if (args[0] === "inspect")
          return container === "none"
            ? { exitCode: 1, stderr: "No such object", stdout: "" }
            : ok(container === "running" ? "true\n" : "false\n");
        return ok();
      },
    },
    gateway: {
      start: async (input) => {
        gatewayStarts.push(input.routes);
        gatewayRunning = true;
      },
      stop: async () => {
        gatewayRunning = false;
      },
    },
    prepareSandbox: async () => undefined,
    publicKey: async () => "-----BEGIN PUBLIC KEY-----",
  });
  return {
    commands,
    exit: () => (container = "exited"),
    gatewayRunning: () => gatewayRunning,
    gatewayStarts,
    supervisor,
    write: (stdout: string, stderr = "") =>
      (logs = { stderr: logs.stderr + stderr, stdout: logs.stdout + stdout }),
  };
}

test("the server runs in a one-off container of the preview service, behind its own gateway", async () => {
  const sandbox = simulatedSandbox();
  const result = await sandbox.supervisor.start(runningState(), {
    nodeArguments,
    port: 51_234,
    routeId,
  });
  assert.deepEqual(result, {
    generation: 4,
    sandboxPort: componentPreviewSandbox.gatewayPort,
    serviceId: "web",
    sessionId: "preview_1",
  });
  const run = sandbox.commands.find(([kind]) => kind === "compose")!;
  assert.deepEqual(run, [
    "compose",
    "run",
    "--detach",
    "--no-deps",
    "-T",
    "--name",
    componentPreviewContainerName,
    "--publish",
    "127.0.0.1:51234:51234",
    "--volume",
    `${componentPreviewSandbox.toolkitRoot}:${componentPreviewSandbox.toolkitRoot}`,
    "--entrypoint",
    "node",
    "web",
    ...nodeArguments,
  ]);
  assert.deepEqual(sandbox.gatewayStarts, [
    [
      {
        sessionId: "preview_1",
        routeId,
        serviceId: componentPreviewSandbox.serviceId,
        endpointId: componentPreviewSandbox.endpointId,
        generation: 4,
        logicalPort: 51_234,
        sandboxPort: componentPreviewSandbox.gatewayPort,
        targetHost: "127.0.0.1",
        targetPort: 51_234,
      },
    ],
  ]);
  // A previous server is removed before the new one starts.
  assert.deepEqual(sandbox.commands[0], [
    "docker",
    "rm",
    "--force",
    componentPreviewContainerName,
  ]);
});

test("output is read from the cursor on, and tells when the server stopped", async () => {
  const sandbox = simulatedSandbox();
  await sandbox.supervisor.start(runningState(), {
    nodeArguments,
    port: 51_234,
    routeId,
  });
  sandbox.write("vite starting\n", "warn\n");
  const first = await sandbox.supervisor.output(undefined);
  assert.deepEqual(first, {
    cursor: { stderr: 5, stdout: 14 },
    running: true,
    stderr: "warn\n",
    stdout: "vite starting\n",
  });
  sandbox.write('BLAME_COMPONENT_PREVIEW {"event":"listening"}\n');
  sandbox.exit();
  const second = await sandbox.supervisor.output(first.cursor);
  assert.equal(second.running, false);
  assert.equal(
    second.stdout,
    'BLAME_COMPONENT_PREVIEW {"event":"listening"}\n',
  );
  assert.equal(second.stderr, "");
  await assert.rejects(sandbox.supervisor.output({ stdout: -1 }), /cursor/u);
  await sandbox.supervisor.stop();
  assert.equal(sandbox.gatewayRunning(), false);
  assert.deepEqual(await sandbox.supervisor.output(second.cursor), {
    cursor: second.cursor,
    running: false,
    stderr: "",
    stdout: "",
  });
});

test("a start is refused before the preview runs, on a busy port, or with bad input", async () => {
  const sandbox = simulatedSandbox();
  const request = { nodeArguments, port: 51_234, routeId };
  await assert.rejects(
    sandbox.supervisor.start(runningState({ running: false }), request),
    /Start the cloud preview/u,
  );
  await assert.rejects(
    sandbox.supervisor.start(runningState(), { ...request, port: 43_000 }),
    /already in use/u,
  );
  await assert.rejects(
    sandbox.supervisor.start(runningState(), { ...request, routeId: "x" }),
    /route is invalid/u,
  );
  await assert.rejects(
    sandbox.supervisor.start(runningState(), { ...request, nodeArguments: [] }),
    /arguments are invalid/u,
  );
  assert.deepEqual(sandbox.commands, []);
  const busy = simulatedSandbox({
    exitCode: 1,
    stderr: "Error: Bind for 127.0.0.1:51234 failed: port is already allocated",
    stdout: "",
  });
  await assert.rejects(busy.supervisor.start(runningState(), request), {
    message: "Port 51234 is already in use in the sandbox.",
  });
  assert.deepEqual(busy.gatewayStarts, []);
});

test("the server runs in the browser preview's service, else a preview or worker service", () => {
  const services = [
    { id: "db", kind: "dependency" },
    { id: "jobs", kind: "worker" },
    { id: "api", kind: "preview" },
    { id: "web", kind: "preview" },
  ];
  assert.equal(
    componentPreviewServiceId({
      plan: plan(services),
      selection: {
        configurationId: "default",
        primaryRoute: { serviceId: "web", endpointId: "http" },
      },
    }),
    "web",
  );
  assert.equal(componentPreviewServiceId({ plan: plan(services) }), "api");
  assert.equal(
    componentPreviewServiceId({ plan: plan(services.slice(0, 2)) }),
    "jobs",
  );
  assert.equal(
    componentPreviewServiceId({ plan: plan(services.slice(0, 1)) }),
    undefined,
  );
});

test("the sandbox's checkout ignores the preview files once", async () => {
  assert.equal(
    componentPreviewExcludeContent("# existing"),
    "# existing\n# Temporary component previews (Blame)\n*.blame-preview.*\n",
  );
  assert.equal(
    componentPreviewExcludeContent("*.blame-preview.*\n"),
    undefined,
  );
  const workspace = await mkdtemp(join(tmpdir(), "component-preview-exclude-"));
  try {
    assert.equal(await excludeComponentPreviewFiles(workspace), false);
    await mkdir(join(workspace, ".git", "info"), { recursive: true });
    await writeFile(join(workspace, ".git", "info", "exclude"), "# git\n");
    assert.equal(await excludeComponentPreviewFiles(workspace), true);
    assert.equal(await excludeComponentPreviewFiles(workspace), false);
    assert.equal(
      await readFile(join(workspace, ".git", "info", "exclude"), "utf8"),
      "# git\n# Temporary component previews (Blame)\n*.blame-preview.*\n",
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
