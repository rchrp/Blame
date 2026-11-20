// The project tasks through the engine host, against the real `blame-engine`
// with the harness and a mock Anthropic server: an initialization that must
// read the code, whose result tool the host checks and which ends with a
// block; a code practice analysis; an impact assessment, by the diff alone
// and by the agent. Skipped when the binary is not built.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { FollowEvent, SessionRecord } from "@blame/engine-client";
import { EngineHost } from "./host.js";
import type { EngineHostEvent } from "./protocol.js";
import { FakeApi, MockModel, testModel, tools } from "./testing.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const binary =
  process.env.BLAME_ENGINE_BIN ?? join(root, "target/debug/blame-engine");
const runner = fileURLToPath(
  new URL("../harness/semantic-harness-runner.js", import.meta.url),
);
const model = { providerId: "anthropic", modelId: testModel };

describe(
  "project tasks",
  { skip: !existsSync(binary) && "no engine binary" },
  () => {
    let mock: MockModel;
    let api: FakeApi;
    let host: EngineHost;
    let workspace: string;
    let dataDir: string;
    const events: EngineHostEvent[] = [];
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();

    before(async () => {
      mock = await MockModel.start([]);
      api = await FakeApi.start();
      api.modelBase = mock.base;
      workspace = mkdtempSync(join(tmpdir(), "blame-project-tasks-"));
      dataDir = mkdtempSync(join(tmpdir(), "blame-project-tasks-data-"));
      writeFileSync(
        join(workspace, "package.json"),
        JSON.stringify({ name: "app", scripts: { dev: "vite" } }),
      );
      git("init", "-q");
      git("-c", "user.email=t@example.com", "-c", "user.name=T", "add", ".");
      git(
        "-c",
        "user.email=t@example.com",
        "-c",
        "user.name=T",
        "commit",
        "-qm",
        "init",
      );
      host = new EngineHost({
        binary,
        dataDir,
        harnessCommand: [process.execPath, runner, "--serve"],
        clientVersion: "test",
        env: { ...process.env, BLAME_ENGINE_LOG: "warn" },
        emit: (event) => events.push(event),
      });
      await host.call("connect", { api: api.connection() });
    });

    after(async () => {
      await host.shutdown();
      await mock.close();
      await api.close();
      rmSync(workspace, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    });

    async function followed(session: string, subscription: string) {
      await host.call("follow", { session, subscription });
      const records = () =>
        events.flatMap((event) =>
          event.type === "follow" &&
          event.subscription === subscription &&
          event.event.type === "records"
            ? (event.event as Extract<FollowEvent, { type: "records" }>).records
            : [],
        );
      const deadline = Date.now() + 10_000;
      while (!records().some((r) => r.type === "turn_ended")) {
        if (Date.now() > deadline) throw new Error("no records");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await host.call("unfollow", { subscription });
      return records();
    }

    it("reads the code, has its setup checked by the host, and reports a block", async () => {
      const block = {
        category: "missing_secret",
        summary: "The app needs a Stripe key to start.",
        userAction: "Add STRIPE_SECRET_KEY to .env.example.",
      };
      mock.script(
        // Refused by the engine: nothing was read yet.
        tools({
          name: "submit_project_initialization",
          input: { blocked: block },
        }),
        tools({ name: "read_code", input: { target: "package.json" } }),
        // Refused by the host's check, with every problem.
        tools({
          name: "submit_project_initialization",
          input: { cloudPreviewIgnore: [] },
        }),
        // Challenged once after a fixable rejection, then recorded.
        tools({
          name: "submit_project_initialization",
          input: { blocked: block },
        }),
        tools({
          name: "submit_project_initialization",
          input: { blocked: block },
        }),
      );
      const task = "task-init-1";
      await assert.rejects(
        host.call("initializeProject", {
          task,
          model,
          workspace: { root: workspace },
        }),
        /Initialization blocked \[missing_secret\]: The app needs a Stripe key/,
      );
      const sent = JSON.stringify(mock.requests.map((r) => r.body.messages));
      assert.match(
        sent,
        /call `read_code`/,
        "the engine asked for a read first",
      );
      assert.match(sent, /Submission 1 of 10 was rejected/);
      assert.match(sent, /rejected for a problem in the setup itself/);
      const offered = (
        mock.requests.at(-1)!.body as { tools: Array<{ name: string }> }
      ).tools
        .map((tool) => tool.name)
        .sort();
      assert.deepEqual(offered, [
        "read_code",
        "search_code",
        "submit_project_initialization",
      ]);
      // What the progress shows comes from the task's records.
      const records: SessionRecord[] = await followed(task, "init-follow");
      const started = records.flatMap((r) =>
        r.type === "tool_call_started" ? [r.name] : [],
      );
      assert.deepEqual(started, [
        "read_code",
        "submit_project_initialization",
        "submit_project_initialization",
        "submit_project_initialization",
      ]);
      assert.ok(records.some((r) => r.type === "result_rejected"));
      assert.ok(records.some((r) => r.type === "result_accepted"));
    });

    it("analyzes the code practices from the engine-checked answer", async () => {
      const comment = { detected: true, comment: "Starter default." };
      mock.script(
        tools({ name: "read_code", input: { target: "package.json" } }),
        tools({
          name: "submit_project_code_practices",
          input: {
            projectState: "starter",
            practices: {
              coding_style: comment,
              unit_tests: { detected: false, comment: "None yet." },
              layered_architecture: comment,
              commit_message_convention: comment,
            },
          },
        }),
        tools({
          name: "submit_project_code_practices",
          input: {
            projectState: "starter",
            practices: {
              coding_style: comment,
              unit_tests: comment,
              layered_architecture: comment,
              commit_message_convention: comment,
            },
          },
        }),
      );
      const result = await host.call("analyzeCodePractices", {
        model,
        workspace: { root: workspace },
      });
      assert.deepEqual(
        result.practices.map(({ practice, detected }) => [practice, detected]),
        [
          ["coding_style", true],
          ["unit_tests", true],
          ["layered_architecture", true],
          ["commit_message_convention", true],
        ],
      );
      assert.match(
        JSON.stringify(mock.requests.at(-1)!.body.messages),
        /Not accepted/,
        "a starter that kept a practice off was refused by the schema",
      );
    });

    it("assesses the impact of commits, by the diff alone or by the agent", async () => {
      const base = git("rev-parse", "HEAD");
      writeFileSync(join(workspace, "README.md"), "# App\n");
      git("-c", "user.email=t@example.com", "-c", "user.name=T", "add", ".");
      git(
        "-c",
        "user.email=t@example.com",
        "-c",
        "user.name=T",
        "commit",
        "-qm",
        "docs",
      );
      const docs = git("rev-parse", "HEAD");
      const setup = {
        previewManifest: {
          confidence: "high" as const,
          project: { root: "." },
          setup: [],
          services: [],
          caches: [],
          risks: [],
          probes: [],
        },
        runConfigurations: [],
      };
      const requests = mock.requests.length;
      const decided = await host.call("assessInitializationImpact", {
        model,
        workspace: { root: workspace },
        baseCommit: base,
        mergeCommit: docs,
        ...setup,
      });
      assert.equal(decided.classification, "initialization_still_valid");
      assert.equal(decided.session, undefined);
      assert.equal(mock.requests.length, requests, "no agent ran");

      writeFileSync(
        join(workspace, "package.json"),
        JSON.stringify({ name: "app", scripts: { dev: "vite --port 4000" } }),
      );
      git(
        "-c",
        "user.email=t@example.com",
        "-c",
        "user.name=T",
        "commit",
        "-qam",
        "port",
      );
      mock.script(
        tools({
          name: "submit_initialization_impact",
          input: {
            classification: "initialization_update_required",
            reason: "The dev port changed.",
            repairInstruction: "Use port 4000.",
          },
        }),
      );
      const assessed = await host.call("assessInitializationImpact", {
        model,
        workspace: { root: workspace },
        baseCommit: docs,
        mergeCommit: git("rev-parse", "HEAD"),
        ...setup,
      });
      assert.equal(assessed.classification, "initialization_update_required");
      assert.equal(assessed.repairInstruction, "Use port 4000.");
      assert.ok(assessed.session);
      assert.deepEqual(assessed.diagnostics.changedFiles, ["package.json"]);
      const sent = mock.requests.at(-1)!.body as {
        tools: Array<{ name: string }>;
      };
      assert.deepEqual(
        sent.tools.map((tool) => tool.name),
        ["submit_initialization_impact"],
      );
    });
  },
);
