import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { compilePreviewManifest } from "./manifest-compiler.js";
import { resolveCapabilities } from "./capability-resolver.js";
import { renderCompose } from "../compose/compose-renderer.js";

test("terminal compiles safely and uses the same mount on both targets", () => {
  const plan = compilePreviewManifest({
    confidence: "high",
    project: {},
    setup: [],
    caches: [],
    risks: [],
    probes: [],
    services: [
      {
        id: "cli",
        kind: "preview",
        container: { image: "python:3.13-slim" },
        command: "printf '%s' \"it's literal\"; exit 7",
        endpoints: [],
        surface: { type: "terminal" },
        environment: { LANG: "fr_FR.UTF-8" },
      },
    ],
  });
  assert.equal(plan.version, 3);
  assert.deepEqual(plan.tools, { ttyd: true });
  assert.equal(plan.services[0]!.environment.LANG, "fr_FR.UTF-8");
  assert.equal(plan.networking.gatewayListeners[0]!.targetPort, 7681);
  assert.match(plan.services[0]!.command!, /BlameExit/);
  assert.match(plan.services[0]!.command!, /--max-clients 1/);
  assert.equal(resolveCapabilities("local-container", plan).compatible, true);
  assert.equal(
    resolveCapabilities("vercel-compose", plan).incompatibilities[0]?.code,
    "SURFACE_UNSUPPORTED",
  );
  const rendered = renderCompose(plan, {
    kind: "local",
    projectName: "blame-p",
    dependencyKey: "d",
    workspacePath: "/work",
    hostPorts: { "cli:terminal": 50001 },
    projectUser: "1000:1000",
  });
  assert.match(rendered.yaml, /\/opt\/blame\/tools:\/opt\/blame\/tools:ro/);
  const command = plan.services[0]!.command!;
  const child = spawnSync("sh", [
    "-c",
    command.slice(command.indexOf("-- sh -c") + 3),
  ]);
  assert.equal(child.status, 7);
  assert.equal(
    child.stdout.toString(),
    "it's literal\x1b]1337;BlameExit=7\x07",
  );
});
