// The project tasks: their purpose, contract, tools and result, without an
// engine.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { SessionConfig } from "@blame/engine-client";
import { InitializationBlockedError } from "../../initialization-session.js";
import { codePracticesTask } from "./code-practices.js";
import { initializationImpactTask } from "./initialization-impact.js";
import { newProjectGenerationTask } from "./new-project-generation.js";
import { projectInitializationRepairTask } from "./project-initialization-repair.js";
import { projectInitializationTask } from "./project-initialization.js";
import { VM_SCAN_UNSUPPORTED } from "../tasks/runner.js";
import type { ClientTool, ToolCallContext } from "../tool.js";

const model = { providerId: "anthropic", modelId: "claude-sonnet-4-6" };
let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "blame-project-tasks-"));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "app", scripts: { dev: "vite" } }),
  );
});
after(() => rm(root, { recursive: true, force: true }));

// The keywords the engine checks (crates/blame-engine-core/src/contract/schema.rs).
const checked = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "enum",
  "const",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "description",
  "title",
  "default",
  "examples",
  "format",
]);

function unsupported(schema: unknown, at = ""): string[] {
  if (!schema || typeof schema !== "object") return [];
  return Object.entries(schema).flatMap(([key, value]) => {
    if (!checked.has(key)) return [`${at}/${key}`];
    if (key === "properties")
      return Object.entries(value as object).flatMap(([name, child]) =>
        unsupported(child, `${at}/properties/${name}`),
      );
    if (key === "items" || key === "not" || key === "additionalProperties")
      return unsupported(value, `${at}/${key}`);
    if (key === "anyOf" || key === "oneOf" || key === "allOf")
      return (value as unknown[]).flatMap((child, index) =>
        unsupported(child, `${at}/${key}/${index}`),
      );
    return [];
  });
}

function resultSchema(config: SessionConfig, tools: ClientTool<never>[] = []) {
  const result = config.contract!.result;
  if (result.source === "submit") return result.input_schema;
  return tools.find((tool) => tool.name === result.name)!.inputSchema;
}

const call = (tool: ClientTool<never>, input: unknown) =>
  tool.run(input as never, {} as ToolCallContext);

test("an initialization reads the code, with read-only tools, and ends through the host's check", async () => {
  const task = await projectInitializationTask({
    model,
    workspace: { root },
    preferences: { database: { mode: "compose" } },
  });
  const { config } = task;
  assert.equal(config.purpose, "project-initialization");
  assert.deepEqual(config.kind, { kind: "task", replicate: false });
  assert.equal(config.workspace_root, root);
  assert.deepEqual(config.engine_tools, ["harness"]);
  assert.deepEqual(config.contract?.result, {
    source: "tool",
    name: "submit_project_initialization",
  });
  assert.deepEqual(config.contract?.required, ["read_code"]);
  assert.deepEqual(config.contract?.allowed, ["search_code", "read_code"]);
  assert.deepEqual(
    config.client_tools.map(({ name }) => name),
    ["submit_project_initialization"],
  );
  assert.deepEqual(unsupported(resultSchema(config, task.tools)), []);
  assert.match(task.instruction, /Project evidence: \{/);
  assert.match(task.instruction, /isolated Compose database/);
  assert.match(config.system_prompt, /read_code/);
  assert.doesNotMatch(config.system_prompt, /read_files|report_project/);
});

test("a rejected setup goes back to the agent; a block is the same tool's other answer", async () => {
  const task = await projectInitializationTask({ model, workspace: { root } });
  const submit = task.tools![0]!;
  await assert.rejects(
    async () => call(submit, { previewManifest: {} }),
    /Submission 1 of 10 was rejected[\s\S]*missing cloudPreviewIgnore, runConfigurations/,
  );
  await assert.rejects(
    async () =>
      call(submit, {
        previewManifest: {},
        blocked: { category: "missing_secret", summary: "a", userAction: "b" },
      }),
    /either the complete setup or only `blocked`/,
  );
  const block = {
    category: "missing_secret",
    summary: "The app needs a Stripe key to start.",
    userAction: "Add STRIPE_SECRET_KEY to .env.example.",
  };
  // A block right after a fixable rejection is challenged once.
  await assert.rejects(
    async () => call(submit, { blocked: block }),
    /rejected for a problem in the setup itself/,
  );
  assert.match(String(await call(submit, { blocked: block })), /Recorded/);
  assert.throws(
    () => task.result({ blocked: block }),
    (error) =>
      error instanceof InitializationBlockedError &&
      /^Initialization blocked \[missing_secret\]/.test(error.message),
  );
});

test("an initialization of a workspace in the VM fails before it is scanned", async () => {
  await assert.rejects(
    projectInitializationTask({
      model,
      workspace: { root: "/does/not/exist", inVm: true },
    }),
    new RegExp(VM_SCAN_UNSUPPORTED.slice(0, 40)),
  );
});

test("a repair may read the code and refuses a setup Blame's checks reject", async () => {
  const task = await projectInitializationRepairTask({
    model,
    workspace: { root },
    previewManifest: {
      confidence: "high",
      project: { root: "." },
      setup: [],
      services: [],
      caches: [],
      risks: [],
      probes: [],
    },
    runConfigurations: [],
    diagnostics: {
      setupLog: "",
      launchError: "Preview failed",
      composeConfig: "",
      composePs: "",
      serviceLogs: {},
    },
  });
  const { config } = task;
  assert.equal(config.purpose, "project-initialization-repair");
  assert.equal(
    config.contract?.result.name,
    "submit_project_initialization_repair",
  );
  assert.deepEqual(config.contract?.required, undefined);
  assert.deepEqual(config.contract?.allowed, ["search_code", "read_code"]);
  assert.deepEqual(unsupported(resultSchema(config, task.tools)), []);
  const submit = task.tools![0]!;
  await assert.rejects(
    async () =>
      call(submit, {
        classification: "repairable_initialization",
        reason: "The command changed.",
        runConfigurations: [],
      }),
    /canonical previewManifest/,
  );
  assert.equal(
    await call(submit, { classification: "unknown", reason: "Unclear." }),
    "Accepted.",
  );
  assert.deepEqual(
    task.result({ classification: "unknown", reason: "Unclear." }),
    {
      classification: "unknown",
      reason: "Unclear.",
    },
  );
});

test("an impact assessment reads only the diff summary: no tool", () => {
  const task = initializationImpactTask(
    {
      model,
      workspace: { root },
      baseCommit: "a",
      mergeCommit: "b",
      previewManifest: {} as never,
      runConfigurations: [],
    },
    {
      baseCommit: "a",
      mergeCommit: "b",
      changedFiles: ["package.json"],
      diffSummary: "1 file changed",
      relevantDiffs: { "package.json": "+x" },
      currentPreviewManifest: {} as never,
      currentRunConfigurations: [],
      strategicFilesBefore: {},
      strategicFilesAfter: {},
    },
  );
  const { config } = task;
  assert.deepEqual(config.engine_tools, []);
  assert.deepEqual(config.contract?.allowed, []);
  assert.equal(config.contract?.result.name, "submit_initialization_impact");
  assert.deepEqual(unsupported(resultSchema(config)), []);
  assert.match(task.instruction, /Changed files \(1\): \["package.json"\]/);
  assert.doesNotMatch(config.system_prompt, /strict JSON/);
  assert.deepEqual(
    task.result({
      classification: "initialization_update_required",
      reason: "A service was added.",
      repairInstruction: "Add the API service.",
    }),
    {
      classification: "initialization_update_required",
      reason: "A service was added.",
      repairInstruction: "Add the API service.",
    },
  );
});

test("a code practice analysis may answer from its evidence, with reading tools to confirm", async () => {
  const task = await codePracticesTask({ model, workspace: { root } });
  const { config } = task;
  assert.equal(config.purpose, "code-practices");
  assert.equal(config.contract?.result.source, "submit");
  assert.equal(config.contract?.result.name, "submit_project_code_practices");
  assert.equal(config.contract?.required, undefined);
  assert.deepEqual(config.contract?.allowed, ["search_code", "read_code"]);
  assert.deepEqual(unsupported(resultSchema(config)), []);
  assert.match(task.instruction, /Project evidence: \{/);
  const comment = { detected: true, comment: "Starter default." };
  assert.equal(
    task.result({
      projectState: "starter",
      practices: {
        coding_style: comment,
        unit_tests: comment,
        layered_architecture: comment,
        commit_message_convention: comment,
      },
    }).length,
    4,
  );
});

test("a new project is scaffolded with the harness and the web tools, without finish_task", () => {
  const task = newProjectGenerationTask(
    {
      model,
      workspace: { root },
      projectName: "portfolio",
      configuration: {
        advancedOptions: ["auth"],
        backend: "next-api",
        codeQuality: "eslint",
        database: "none",
        frontend: "next",
        orm: "none",
        packageManager: "pnpm",
        platform: "web",
        styling: "tailwind",
        uiLibrary: "none",
      },
    },
    (names) =>
      names.map((name) => ({
        name,
        description: name,
        input_schema: {},
        effect: "read_only",
        ends_turn: false,
        needs_approval: false,
      })),
  );
  const { config } = task;
  assert.equal(config.purpose, "new-project-generation");
  assert.deepEqual(config.engine_tools, ["harness"]);
  assert.deepEqual(
    config.client_tools.map(({ name }) => name),
    ["search_web", "read_web_page"],
  );
  assert.equal(config.contract?.result.name, "submit_new_project");
  assert.ok(!config.contract?.allowed?.includes("finish_task"));
  assert.ok(config.contract?.allowed?.includes("run_task"));
  assert.ok(config.contract?.allowed?.includes("edit_code"));
  assert.match(task.instruction, /Auth is requested/);
  assert.match(task.instruction, /submit_new_project/);
  assert.deepEqual(task.result({ summary: " Done. " }), { summary: "Done." });
});
