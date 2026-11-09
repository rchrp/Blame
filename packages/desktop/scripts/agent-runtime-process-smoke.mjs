import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { app, utilityProcess } from "electron";

const timeoutMs = 15_000;
const workerCount = 2;
const modulePath = join(
  import.meta.dirname,
  "..",
  "out",
  "main",
  "agent-runtime-process.js",
);

console.log("Starting agent worker smoke test");
void app.whenReady().then(runSmokeTest);

function runSmokeTest() {
  const workers = Array.from({ length: workerCount }, createWorkerState);
  const timeout = setTimeout(
    () => finish(new Error("Agent worker smoke test timed out")),
    timeoutMs,
  );
  let finished = false;

  workers.forEach((worker) => registerWorker(worker, completeWorker));

  function finish(error) {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    workers.forEach(({ child }) => child.kill());
    if (error) {
      console.error(error.message);
      app.exit(1);
      return;
    }
    console.log(`${workerCount} agent worker smoke tests passed`);
    app.exit(0);
  }

  function completeWorker(worker, error) {
    if (error) {
      finish(error);
      return;
    }
    worker.completed = true;
    if (workers.every(({ completed }) => completed)) finish();
  }
}

function createWorkerState() {
  return {
    child: createAgentWorker(),
    completed: false,
    requestId: randomUUID(),
  };
}

function registerWorker(worker, completeWorker) {
  worker.child.on("message", (message) => {
    if (message?.kind === "ready") {
      worker.child.postMessage(pingRequest(worker.requestId));
      return;
    }
    if (!runtimeResponse(message, worker.requestId)) return;
    const error = message.error
      ? new Error(message.error.message)
      : undefined;
    completeWorker(worker, error);
  });
  worker.child.on("exit", (code) => {
    if (!worker.completed && code !== 0) {
      completeWorker(worker, new Error(`Agent worker exited with code ${code}`));
    }
  });
}

function createAgentWorker() {
  return utilityProcess.fork(modulePath, [], {
    env: {
      ...process.env,
      BLAME_AGENT_PACKAGED: "false",
    },
    serviceName: "Blame Agent Worker Smoke Test",
    stdio: "inherit",
  });
}

// Resolving an approval nobody asked for is a no-op round trip.
function pingRequest(requestId) {
  return {
    id: requestId,
    input: { decision: "deny", requestId },
    kind: "request",
    method: "approvals.resolve",
    target: "runtime",
  };
}

function runtimeResponse(message, requestId) {
  return (
    message?.kind === "response" &&
    message.target === "runtime" &&
    message.id === requestId
  );
}
