// Runs in Electron: forks the built engine host (out/main/engine-host-process.js)
// as the app does, and drives one quick chat turn through it against a
// scripted model server and a stand-in for Blame's API. It proves the
// utility process starts blame-engine, that the engine starts the harness
// with Electron as Node, and that records and activity come back over the
// port. Needs `electron-vite build` and `cargo build -p blame-engine`.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, utilityProcess } from "electron";

const modulePath = join(
  import.meta.dirname,
  "..",
  "out",
  "main",
  "engine-host-process.js",
);
const repository = join(import.meta.dirname, "..", "..", "..");
const binary =
  process.env.BLAME_ENGINE_BIN ??
  join(repository, "target", "debug", "blame-engine");
const engineEntry = fileURLToPath(
  import.meta.resolve("@blame/agent-runtime/engine"),
);
const { FakeApi, MockModel, testModel, text, tools } = await import(
  join(engineEntry, "..", "testing.js")
);

const session = "smoke-0193f5d2-7a1b-7c3e-9f00-000000000001";
const timeoutMs = 60_000;

void app.whenReady().then(async () => {
  const workspace = mkdtempSync(join(tmpdir(), "blame-engine-host-smoke-"));
  const dataDir = mkdtempSync(join(tmpdir(), "blame-engine-host-smoke-data-"));
  const model = await MockModel.start([
    tools({ name: "search_web", input: { query: "blame engine" } }),
    text("Found ", "it."),
  ]);
  const api = await FakeApi.start();
  api.modelBase = model.base;
  const child = utilityProcess.fork(modulePath, [], {
    env: {
      ...process.env,
      BLAME_ENGINE_HOST_CONFIG: JSON.stringify({
        binary,
        dataDir,
        clientVersion: "smoke",
      }),
    },
    serviceName: "Blame Engine Host smoke test",
    stdio: "inherit",
  });
  const pending = new Map();
  const events = [];
  let nextId = 1;
  const call = (method, input) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.postMessage({ kind: "request", id, method, input });
    });
  let ready;
  const started = new Promise((resolve) => (ready = resolve));
  child.on("message", (message) => {
    if (message?.kind === "ready") return ready();
    if (message?.kind === "event") return events.push(message.event);
    // The host asks main for the conversation's desktop tools; this session
    // has no GitHub access, and nothing else is served here.
    if (message?.kind === "desktop-request")
      return child.postMessage(
        message.method === "githubMcpTools"
          ? { kind: "desktop-response", id: message.id, result: [] }
          : {
              kind: "desktop-response",
              id: message.id,
              error: { message: `No ${message.method} in the smoke test` },
            },
      );
    if (message?.kind !== "response") return;
    const waiting = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiting?.reject(new Error(message.error.message));
    else waiting?.resolve(message.result);
  });
  let stopping = false;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  void exited.then((code) => {
    if (!stopping) void finish(new Error(`The engine host exited (${code})`));
  });

  let finished = false;
  const finish = async (error) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    child.kill();
    await model.close();
    await api.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    if (error) {
      console.error(error instanceof Error ? error.message : String(error));
      app.exit(1);
    } else {
      console.log("Engine host smoke test passed");
      app.exit(0);
    }
  };
  const timer = setTimeout(
    () => void finish(new Error("Engine host smoke test timed out")),
    timeoutMs,
  );

  try {
    if (!existsSync(binary)) throw new Error(`No engine binary at ${binary}`);
    await started;
    await call("connect", { api: api.connection() });
    await call("createSession", {
      session,
      purpose: "quick-chat",
      settings: {
        workspaceRoot: workspace,
        model: { providerId: "anthropic", modelId: testModel },
      },
    });
    await call("follow", { session, subscription: "smoke" });
    await call("send", {
      session,
      message: { text: "find the engine" },
      delivery: "turn",
    });
    while (
      !events.some(
        (event) => event.type === "activity" && !event.running && event.outcome,
      )
    )
      await new Promise((resolve) => setTimeout(resolve, 50));
    const records = events
      .filter(
        (event) => event.type === "follow" && event.event.type === "records",
      )
      .flatMap((event) => event.event.records);
    const kinds = records.map((record) => record.type);
    for (const kind of [
      "session_created",
      "user_message",
      "tool_call_finished",
      "turn_ended",
    ])
      if (!kinds.includes(kind))
        throw new Error(`No ${kind} record: ${kinds.join(", ")}`);
    const offered = model.requests[0].body.tools.map((tool) => tool.name);
    if (!offered.includes("read_code"))
      throw new Error(
        `The harness tools were not offered: ${offered.join(", ")}`,
      );
    if (api.searches[0] !== "blame engine")
      throw new Error("search_web did not reach the API");
    stopping = true;
    await call("shutdown", undefined);
    await exited;
    await finish();
  } catch (error) {
    await finish(error);
  }
});
