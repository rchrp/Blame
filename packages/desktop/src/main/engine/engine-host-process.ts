// The engine host's utility process (docs/engine-in-the-app.md): it owns the
// app's one engine. The main process forks it, relays the windows' calls
// and serves the desktop services the client tools ask for.

import {
  EngineHost,
  harnessRunnerPath,
  isEngineHostMessage,
  type EngineDesktopMethod,
  type EngineHostMessage,
  type EngineHostMethod,
} from "@blame/agent-runtime/engine";

export type EngineHostProcessConfig = {
  binary: string;
  dataDir: string;
  clientVersion: string;
};

const parentPort = process.parentPort;
if (!parentPort) throw new Error("The engine host needs its parent port");
const config = JSON.parse(
  process.env.BLAME_ENGINE_HOST_CONFIG ?? "{}",
) as EngineHostProcessConfig;

const post = (message: EngineHostMessage) => parentPort.postMessage(message);
const desktopPending = new Map<
  number,
  { resolve(value: unknown): void; reject(error: Error): void }
>();
let nextDesktopId = 1;

function desktop<Result>(
  method: EngineDesktopMethod,
  input: unknown,
  signal?: AbortSignal,
) {
  const id = nextDesktopId++;
  return new Promise<Result>((resolve, reject) => {
    desktopPending.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    signal?.addEventListener("abort", () => {
      desktopPending.delete(id);
      reject(signal.reason);
    });
    post({ kind: "desktop-request", id, method, input });
  });
}

const host = new EngineHost({
  binary: config.binary,
  dataDir: config.dataDir,
  clientVersion: config.clientVersion,
  // Electron runs the harness runner as plain Node.
  harnessCommand: [process.execPath, harnessRunnerPath(), "--serve"],
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    BLAME_ENGINE_HOST_CONFIG: undefined,
  },
  emit: (event) => post({ kind: "event", event }),
  renderWebPage: ({ url, signal }) => desktop("renderWebPage", { url }, signal),
  // Main runs git on this machine, or in the runtime VM for its worktrees.
  git: (cwd, args) => desktop<string>("git", { cwd, args }),
  onLog: ({ source, text }) => {
    if (source === "engine-stderr" || /threw|ignored/.test(text))
      console.error(`[engine] ${text}`);
  },
});

parentPort.on("message", ({ data }) => {
  if (!isEngineHostMessage(data)) return;
  if (data.kind === "desktop-response") {
    const pending = desktopPending.get(data.id);
    desktopPending.delete(data.id);
    if (data.error) pending?.reject(new Error(data.error.message));
    else pending?.resolve(data.result);
    return;
  }
  if (data.kind !== "request") return;
  void host
    .call(data.method as EngineHostMethod, data.input as never)
    .then(
      (result) => post({ kind: "response", id: data.id, result }),
      (error: unknown) =>
        post({
          kind: "response",
          id: data.id,
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        }),
    )
    .finally(() => {
      if (data.method === "shutdown") process.exit(0);
    });
});

post({ kind: "ready" });
