import type { LightWorkspaceExecutionRequest } from "@blame/agent-runtime";
import { runtimeHeavyWork, type HeavyWorkQueue } from "./runtime-heavy-work.ts";

// The checks agents run in the Blame Runtime (builds, type checks, tests,
// lints, and finish_task's final validation) take a turn of the Runtime's
// heavy work (runtime-heavy-work.ts) before they reach the harness. A check
// that outlives its request (the harness answers "running" after 15 s)
// keeps its turn until an inspect of that run sees it end, the session
// ends, or the harness's own command limit (120 s) has long passed. A check
// that waited says so in its result (data.waitedForTurn), for the agent and
// the tool call card.

type Forward = () => Promise<unknown>;

const heldRunLimitMs = 5 * 60_000;

// Package scripts and tools that build, type check, test or lint.
const heavyScript =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:(?:run|exec|-w|--workspace(?:=\S+)?|--filter(?:=\S+)?|-F|-C|--dir)\s+(?:\S+\s+)?)*(?:build|test|tests|typecheck|type-check|check|lint|e2e|verify|validate|ci)\b/u;
const heavyTool =
  /(?:^|[\s;&|(/])(?:tsc|vue-tsc|vitest|jest|mocha|playwright|cypress|eslint|svelte-check|next\s+(?:build|lint)|nuxi?\s+(?:build|generate|typecheck)|vite\s+build|ng\s+(?:build|test)|webpack|rollup|turbo|nx|node\s+--test|deno\s+(?:test|check)|cargo\s+(?:build|test|check|clippy)|go\s+(?:build|test|vet)|pytest|mypy|pyright|dotnet\s+(?:build|test)|gradlew?|mvnw?|swift\s+(?:build|test)|xcodebuild|make)\b/u;

type HeldRun = { leave: () => void; sessionId: string; timer: NodeJS.Timeout };

export function createAgentHeavyChecks(
  queue: HeavyWorkQueue = runtimeHeavyWork,
) {
  const held = new Map<string, HeldRun>();

  function release(key: string) {
    const run = held.get(key);
    if (!run) return;
    held.delete(key);
    clearTimeout(run.timer);
    run.leave();
  }

  function hold(key: string, sessionId: string, leave: () => void) {
    release(key);
    const timer = setTimeout(() => release(key), heldRunLimitMs);
    timer.unref?.();
    held.set(key, { leave, sessionId, timer });
  }

  return {
    /** Forwards a harness request, in a turn when it is a heavy check. */
    async run(
      request: LightWorkspaceExecutionRequest,
      signal: AbortSignal,
      forward: Forward,
    ) {
      const sessionId =
        request.toolContext?.sessionId ?? request.taskContract?.session_id;
      const inspected = inspectedRun(request);
      if (inspected) {
        const result = await forward();
        if (!stillRunning(result)) release(runKey(request, inspected));
        return result;
      }
      if (!sessionId || !heavyCheck(request)) return forward();
      const askedAt = Date.now();
      let waitedFor: string | undefined;
      const leave = await queue.enter("check", {
        owner: sessionId,
        signal,
        onWait: (reason) => {
          waitedFor = reason;
        },
      });
      let result: unknown;
      try {
        result = await forward();
      } catch (error) {
        leave();
        throw error;
      }
      const run = runningRun(result);
      if (run) hold(runKey(request, run), sessionId, leave);
      else leave();
      if (!waitedFor) return result;
      return withWait(result, {
        seconds: Math.round((Date.now() - askedAt) / 1_000),
        behind: waitedFor,
        why: "Heavy work in the Blame Runtime takes turns.",
      });
    },

    /** The session ended: the checks it left running give their turns back. */
    endSession(sessionId: string) {
      for (const [key, run] of held)
        if (run.sessionId === sessionId) release(key);
    },
  };
}

export function heavyCheck(request: LightWorkspaceExecutionRequest) {
  if (request.tool === "finish_task") return true;
  if (request.tool !== "run_task") return false;
  const input = record(request.input);
  if (input.kind === "project") return true;
  if (input.kind !== undefined && input.kind !== "command") return false;
  const command = typeof input.command === "string" ? input.command : "";
  return heavyScript.test(command) || heavyTool.test(command);
}

function inspectedRun(request: LightWorkspaceExecutionRequest) {
  if (request.tool !== "run_task") return undefined;
  const input = record(request.input);
  return input.kind === "inspect" && typeof input.run === "string"
    ? input.run
    : undefined;
}

function runKey(request: LightWorkspaceExecutionRequest, run: string) {
  return JSON.stringify([
    request.workspaceRoot,
    request.taskContract?.session_id ?? null,
    run,
  ]);
}

function runningRun(result: unknown) {
  const data = record(record(result).data);
  return data.process === "running" && typeof data.run === "string"
    ? data.run
    : undefined;
}

function stillRunning(result: unknown) {
  return record(result).status === "ok" && runningRun(result) !== undefined;
}

function withWait(result: unknown, waitedForTurn: Record<string, unknown>) {
  const value = record(result);
  if (value.status !== "ok") return result;
  return { ...value, data: { ...record(value.data), waitedForTurn } };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export const agentHeavyChecks = createAgentHeavyChecks();
