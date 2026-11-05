#!/usr/bin/env node
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import {
  cachedLightWorkspaceExecutor,
  executeLightWorkspaceRequest,
  type LightWorkspaceExecutionRequest,
} from "./light-executor.js";

// `--serve` keeps one harness for many requests (one JSON line each, answered
// by id), so a session's managed runs and caches live between tool calls.
// Without it, one request is read from stdin and answered once.
if (process.argv.includes("--serve")) await serve();
else await runOnce();

async function runOnce() {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));

  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("Semantic workspace operation cancelled."));
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);

  try {
    const request = JSON.parse(
      Buffer.concat(chunks).toString("utf8"),
    ) as LightWorkspaceExecutionRequest;
    const result = await executeLightWorkspaceRequest(request, controller.signal);
    controller.signal.throwIfAborted();
    stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGINT", cancel);
  }
}

type ServeMessage = { id?: unknown; cancel?: boolean; request?: LightWorkspaceExecutionRequest };

async function serve() {
  const execute = cachedLightWorkspaceExecutor();
  const inFlight = new Map<string, AbortController>();
  // The signals of requests that left a managed run going: the run still
  // listens to its request's signal, and must stop with the harness.
  const started = new Set<AbortController>();
  const stopAll = () => {
    for (const controller of started) controller.abort(new Error("Semantic harness stopped."));
  };
  process.once("SIGTERM", () => { stopAll(); process.exit(1); });
  process.once("SIGINT", () => { stopAll(); process.exit(1); });
  const write = (value: unknown) => stdout.write(`${JSON.stringify(value)}\n`);
  write({ ready: true, protocol: 1 });
  for await (const line of createInterface({ input: stdin, crlfDelay: Infinity })) {
    let message: ServeMessage;
    try {
      message = JSON.parse(line) as ServeMessage;
    } catch {
      continue;
    }
    const id = String(message.id ?? "");
    if (!id) continue;
    if (message.cancel) {
      inFlight.get(id)?.abort(new Error("Semantic workspace operation cancelled."));
      continue;
    }
    if (!message.request) {
      write({ id, error: "A request is required." });
      continue;
    }
    const controller = new AbortController();
    inFlight.set(id, controller);
    started.add(controller);
    void execute(message.request, controller.signal)
      .then((result) => {
        controller.signal.throwIfAborted();
        if (!startedRun(result)) started.delete(controller);
        write({ id, result });
      })
      .catch((error: unknown) => {
        started.delete(controller);
        write({ id, error: errorMessage(error) });
      })
      .finally(() => inFlight.delete(id));
  }
  // The agent closed the pipe: nothing can read results any more.
  stopAll();
}

function startedRun(result: unknown) {
  const data = (result as { data?: { process?: unknown; run?: unknown } } | undefined)?.data;
  return typeof data?.run === "string" && data.process === "running";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
