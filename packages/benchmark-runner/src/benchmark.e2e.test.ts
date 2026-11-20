// A benchmark run on the real `blame-engine`, with the harness runner and a
// scripted model: it reads, edits, finishes, and its result and events say
// so from the engine's records and the harness trace. Skipped when the
// engine is not built (`cargo build -p blame-engine`).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FakeApi, MockModel, testModel, tools } from "@blame/agent-runtime/engine-testing";
import { benchmarkEngine } from "./benchmark-engine.js";
import { runBenchmark } from "./benchmark-run.js";
import { JsonlEventRecorder } from "./event-recorder.js";

const binary = fileURLToPath(new URL("../../../target/debug/blame-engine", import.meta.url));

test("a benchmark task runs end to end on the engine", { skip: !existsSync(binary) && !process.env.BLAME_ENGINE_BIN && "no engine binary" }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "blame-benchmark-e2e-"));
  const workspace = join(directory, "workspace");
  const model = await MockModel.start([]);
  const api = await FakeApi.start();
  api.modelBase = model.base;
  try {
    execFileSync("mkdir", ["-p", workspace]);
    writeFileSync(join(workspace, "label.js"), "export const label = 'a'\n");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace });
    git("init", "-q");
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    model.script(
      tools({ name: "read_code", input: { target: "label.js" } }),
      tools({
        name: "edit_code",
        input: { operations: [{ kind: "patch", path: "label.js", patch: "@@\n-export const label = 'a'\n+export const label = 'b'\n" }] },
      }),
      tools({ name: "finish_task", input: { summary: "Changed the label." } }),
    );
    const connection = api.connection();
    const config = {
      apiUrl: connection.url,
      apiToken: connection.token,
      harnessTracePath: join(directory, "harness-trace.jsonl"),
      instruction: "Change the label to b.",
      maxIterations: 8,
      modelId: testModel,
      providerId: "anthropic",
      taskId: "label",
      timeoutMs: 60_000,
      workspaceRoot: workspace,
    };
    const eventsPath = join(directory, "events.jsonl");
    const result = await runBenchmark(config, {
      createEngine: benchmarkEngine,
      createRecorder: () => new JsonlEventRecorder(eventsPath),
    });
    assert.equal(result.status, "succeeded", result.error);
    assert.equal(result.metrics.navigation.readCalls, 1);
    assert.equal(result.metrics.editing.attempts, 1);
    assert.equal(result.metrics.context.modelRequests, 3);
    assert.equal(result.usage?.aggregateUsage.totalInputTokens, 30);
    assert.ok(result.completion, "finish_task's completion is in the result");
    const events = readFileSync(eventsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.at(-1).event.type, "done");
    const finished = events.filter((row) => row.event.type === "tool" && row.event.payload.phase === "finished");
    assert.deepEqual(finished.map((row) => row.event.payload.toolName), ["read_code", "edit_code", "finish_task"]);
    assert.equal(finished[0].event.payload.output.status, "ok", "the harness's raw result");
  } finally {
    await model.close();
    await api.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
