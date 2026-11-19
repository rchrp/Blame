import assert from "node:assert/strict";
import test from "node:test";
import type { LightWorkspaceExecutionRequest } from "@blame/agent-runtime";
import { createAgentHeavyChecks, heavyCheck } from "./agent-heavy-checks.ts";
import { createHeavyWorkQueue } from "./runtime-heavy-work.ts";

test("takes turns for builds, type checks, tests and lints only", () => {
  const command = (text: string) => request("a", { command: text });
  for (const text of [
    "npm run build",
    "pnpm test -- --run",
    "pnpm --filter @blame/app typecheck",
    "yarn lint",
    "npx tsc --noEmit",
    "./node_modules/.bin/vitest run src",
    "cd web && next build",
    "cargo test",
    "go test ./...",
    "node --test dist/a.test.js",
  ])
    assert.equal(heavyCheck(command(text)), true, text);
  for (const text of [
    "git status",
    "ls src",
    "npm install zod",
    "cat package.json",
    "node -e 1",
  ])
    assert.equal(heavyCheck(command(text)), false, text);
  assert.equal(
    heavyCheck(request("a", { kind: "project", task: "test" })),
    true,
  );
  assert.equal(heavyCheck(request("a", { kind: "inspect", run: "r1" })), false);
  assert.equal(heavyCheck({ ...request("a", {}), tool: "finish_task" }), true);
  assert.equal(heavyCheck({ ...request("a", {}), tool: "read_code" }), false);
});

test("a running check keeps its turn until an inspect sees it end", async () => {
  const checks = createAgentHeavyChecks(
    createHeavyWorkQueue({ availableMemory: async () => 0 }),
  );
  const signal = new AbortController().signal;
  const first = await checks.run(
    request("a", { command: "npm test" }),
    signal,
    async () => ok({ run: "r1", process: "running" }),
  );
  assert.deepEqual(first, ok({ run: "r1", process: "running" }));

  let secondStarted = false;
  const second = checks.run(
    request("b", { command: "npm run build" }),
    signal,
    async () => {
      secondStarted = true;
      return ok({ exitCode: 0 });
    },
  );
  await turns();
  assert.equal(secondStarted, false);

  await checks.run(
    request("a", { kind: "inspect", run: "r1" }),
    signal,
    async () => ok({ run: "r1", process: "running" }),
  );
  await turns();
  assert.equal(secondStarted, false);
  await checks.run(
    request("a", { kind: "inspect", run: "r1" }),
    signal,
    async () => ok({ run: "r1", process: "exited" }),
  );
  const result = (await second) as {
    data: { waitedForTurn?: { behind: string } };
  };
  assert.equal(secondStarted, true);
  assert.equal(
    result.data.waitedForTurn?.behind,
    "another agent's build or tests",
  );
});

test("an ended session gives back the turns of the checks it left running", async () => {
  const checks = createAgentHeavyChecks(
    createHeavyWorkQueue({ availableMemory: async () => 0 }),
  );
  const signal = new AbortController().signal;
  await checks.run(
    request("a", { kind: "project", task: "build" }),
    signal,
    async () => ok({ run: "r1", process: "running" }),
  );
  const second = checks.run(
    request("b", { command: "npm test" }),
    signal,
    async () => ok({ exitCode: 0 }),
  );
  await turns();
  checks.endSession("a");
  assert.deepEqual(await second, {
    status: "ok",
    data: {
      exitCode: 0,
      waitedForTurn: {
        behind: "another agent's build or tests",
        seconds: 0,
        why: "Heavy work in the Blame Runtime takes turns.",
      },
    },
  });
});

test("a session's next check does not wait for its own running one", async () => {
  const checks = createAgentHeavyChecks(
    createHeavyWorkQueue({ availableMemory: async () => 0 }),
  );
  const signal = new AbortController().signal;
  await checks.run(request("a", { command: "npm test" }), signal, async () =>
    ok({ run: "r1", process: "running" }),
  );
  const next = await checks.run(
    request("a", { command: "npm run build" }),
    signal,
    async () => ok({ exitCode: 0 }),
  );
  assert.deepEqual(next, ok({ exitCode: 0 }));
});

function request(
  sessionId: string,
  input: unknown,
): LightWorkspaceExecutionRequest {
  return {
    input,
    taskContract: { session_id: sessionId },
    tool: "run_task",
    toolContext: { sessionId },
    workspaceRoot: `/worktrees/${sessionId}`,
  };
}

function ok(data: Record<string, unknown>) {
  return { status: "ok", data };
}

async function turns() {
  for (let index = 0; index < 5; index += 1)
    await new Promise((resolve) => setImmediate(resolve));
}
