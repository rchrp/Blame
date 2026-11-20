import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionRecord, TaskOutcome } from "@blame/engine-client";
import { runBenchmark } from "./benchmark-run.js";
import { BenchmarkMetricsCollector } from "./benchmark-metrics.js";
import type {
  BenchmarkConfig,
  BenchmarkEngine,
  BenchmarkEventRecorder,
} from "./contracts.js";
import type { BenchmarkEvent } from "./engine-events.js";

class MemoryRecorder implements BenchmarkEventRecorder {
  private readonly collector = new BenchmarkMetricsCollector();
  readonly events: BenchmarkEvent[] = [];
  eventCount = 0;
  toolEventCount = 0;
  closed = false;

  record(event: BenchmarkEvent, at?: number) {
    if (this.closed) throw new Error("recorded after close");
    this.events.push(event);
    this.eventCount += 1;
    if (event.type === "tool") this.toolEventCount += 1;
    this.collector.record(event, at);
  }

  metrics(startedAt: Date, finishedAt: Date) {
    return this.collector.summary(startedAt, finishedAt);
  }

  async close() {
    this.closed = true;
  }
}

type Input = Parameters<BenchmarkEngine["runStoryTask"]>[0];

function fakeEngine(options: {
  outcome?: TaskOutcome | ((input: Input) => Promise<TaskOutcome>);
  records?: () => Promise<SessionRecord[]>;
  shutdown?: () => Promise<void>;
}) {
  const inputs: Input[] = [];
  let shutdown = false;
  const engine: BenchmarkEngine = {
    async runStoryTask(input) {
      inputs.push(input);
      const outcome =
        typeof options.outcome === "function"
          ? await options.outcome(input)
          : (options.outcome ?? { status: "completed", call: "c", result: null });
      return { session: input.session, outcome };
    },
    records: options.records ?? (async () => finishedRecords),
    async shutdown() {
      shutdown = true;
      await options.shutdown?.();
    },
  };
  return { engine, inputs, isShutdown: () => shutdown };
}

const finishedRecords = [
  {
    type: "assistant_message",
    turn: "t",
    request: "r",
    blocks: [],
    stop: "end_turn",
    usage: { input_tokens: 12, output_tokens: 4 },
  },
  { type: "turn_ended", turn: "t", outcome: { status: "completed" } },
].map((record, index) => ({ seq: index + 1, at_ms: index, ...record })) as SessionRecord[];

test("runs a story task and returns its result, usage and events", async () => {
  await withTrace(async (harnessTracePath) => {
    await writeFile(
      harnessTracePath,
      `${JSON.stringify({ at: 1, toolCallId: "c", tool: "finish_task", raw: { status: "ok", data: { notification: { completion: { delivery: "satisfied" }, verified: true, summary: "Done." } } } })}\n`,
    );
    const recorder = new MemoryRecorder();
    const fake = fakeEngine({});
    const requiredChecks = [{ id: "selected", task: "test", args: ["some.test.ts"] }];
    const result = await runBenchmark(
      { ...benchmarkConfig(harnessTracePath), requiredChecks },
      { createRecorder: () => recorder, createEngine: () => fake.engine, now: sequencedClock() },
    );
    assert.equal(result.status, "succeeded");
    assert.equal(result.durationMs, 1_000);
    assert.equal(result.harness, "blame");
    assert.equal(result.verified, true);
    assert.deepEqual(result.completion, { delivery: "satisfied" });
    assert.equal(result.usage?.aggregateUsage.totalInputTokens, 12);
    assert.equal(result.sessionId, fake.inputs[0]?.session);
    const input = fake.inputs[0]!;
    assert.equal(input.instruction, "Fix the task");
    assert.equal(input.settings.workspaceMode, "local-container", "an isolated run");
    assert.equal(input.settings.projectId, "project-1");
    assert.deepEqual(input.limits, { max_requests_per_turn: 64 });
    assert.deepEqual(input.taskContract?.required_checks, requiredChecks);
    assert.deepEqual(input.taskContract?.acceptance_criteria, ["Fix the task"]);
    assert.equal(recorder.events.at(-1)?.type, "done");
    assert.equal(recorder.closed, true);
    assert.equal(fake.isShutdown(), true);
  });
});

test("keeps dataset identifiers outside the model's task text", async () => {
  await withTrace(async (harnessTracePath) => {
    const fake = fakeEngine({});
    const config = {
      ...benchmarkConfig(harnessTracePath),
      taskId: "external-project__component-86420__trial",
    };
    await runBenchmark(config, {
      createRecorder: () => new MemoryRecorder(),
      createEngine: () => fake.engine,
    });
    const { title } = fake.inputs[0]!.settings;
    assert.doesNotMatch(title, /external-project|component|86420|trial/u);
  });
});

test("a run past its deadline is stopped and reported as timed out", async () => {
  await withTrace(async (harnessTracePath) => {
    const fake = fakeEngine({
      outcome: (input) =>
        new Promise((resolve) =>
          input.signal?.addEventListener("abort", () => resolve({ status: "interrupted" })),
        ),
    });
    const result = await runBenchmark(
      { ...benchmarkConfig(harnessTracePath), timeoutMs: 20 },
      { createRecorder: () => new MemoryRecorder(), createEngine: () => fake.engine },
    );
    assert.equal(result.status, "timed_out");
    assert.equal(result.error, "Benchmark timed out.");
  });
});

test("a run the agent did not finish fails with why", async () => {
  await withTrace(async (harnessTracePath) => {
    const fake = fakeEngine({
      outcome: { status: "failed", failure: { kind: "contract_unmet", unmet: [{ kind: "result", tool: "finish_task" }] } },
    });
    const result = await runBenchmark(benchmarkConfig(harnessTracePath), {
      createRecorder: () => new MemoryRecorder(),
      createEngine: () => fake.engine,
    });
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /finish_task/);
  });
});

test("a pre-cancelled benchmark never starts the engine", async () => {
  await withTrace(async (harnessTracePath) => {
    const controller = new AbortController();
    controller.abort();
    let created = false;
    const result = await runBenchmark(benchmarkConfig(harnessTracePath), {
      createRecorder: () => new MemoryRecorder(),
      createEngine: () => {
        created = true;
        return fakeEngine({}).engine;
      },
      signal: controller.signal,
    });
    assert.equal(result.status, "cancelled");
    assert.equal(created, false);
  });
});

test("a stuck record read or shutdown cannot hold the result", async () => {
  await withTrace(async (harnessTracePath) => {
    const recorder = new MemoryRecorder();
    const fake = fakeEngine({
      records: () => new Promise(() => undefined),
      shutdown: () => new Promise(() => undefined),
    });
    const result = await runBenchmark(benchmarkConfig(harnessTracePath), {
      cleanupTimeoutMs: 10,
      createRecorder: () => recorder,
      createEngine: () => fake.engine,
    });
    assert.equal(result.status, "succeeded");
    assert.equal(result.cleanupIncomplete, true);
    assert.equal(result.usage, undefined, "unknown usage is not zero usage");
    assert.equal(recorder.closed, true);
  });
});

function benchmarkConfig(harnessTracePath: string): BenchmarkConfig {
  return {
    isolatedEnvironment: true,
    apiToken: "token",
    apiUrl: "https://api.example.test",
    harnessTracePath,
    instruction: "Fix the task",
    maxIterations: 64,
    modelId: "model",
    providerId: "anthropic",
    projectId: "project-1",
    taskId: "task-1",
    timeoutMs: 1_000,
    workspaceRoot: "/workspace",
  };
}

async function withTrace(run: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "blame-benchmark-run-"));
  try {
    await run(join(directory, "harness-trace.jsonl"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function sequencedClock() {
  const dates = [
    new Date("2026-01-01T00:00:00Z"),
    new Date("2026-01-01T00:00:01Z"),
  ];
  return () => dates.shift() ?? new Date("2026-01-01T00:00:01Z");
}
