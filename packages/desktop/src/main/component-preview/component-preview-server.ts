import { randomBytes } from "node:crypto";
import { freeLocalPort } from "../preview-runtime/local/local-preview-ports.ts";
import type {
  ComponentPreviewHost,
  ComponentPreviewProcess,
} from "./component-preview-hosts.ts";
import {
  componentPreviewPagePath,
  componentPreviewServerArguments,
  componentPreviewServerReport,
  type ComponentPreviewServerReport,
  type ComponentPreviewToolkit,
} from "./component-preview-server-script.ts";

// One temporary Vite server: started on a free port of this computer,
// trusted once it answers with its own token, stopped with its process.

export type ComponentPreviewServerStart = {
  cacheName: string;
  host: ComponentPreviewHost;
  // The server stops by itself after this long without a request, in case
  // Blame is gone before it could stop it.
  idleMs: number;
  // Worktree-relative package directory, "" for the worktree root.
  packageDir: string;
  signal?: AbortSignal;
  // Blame's own Vite, for a React package without one.
  toolkit?: Pick<ComponentPreviewToolkit, "framework">;
};

export type ComponentPreviewPageQuery = {
  // Path of the preview file relative to the package directory.
  file: string;
  // Retransform every module before this render.
  fresh: boolean;
  state: string;
  theme: "dark" | "light";
};

const listenTimeoutMs = 120_000;
// Installing Blame's own Vite, once per environment, downloads it first.
const installTimeoutMs = 300_000;
const reachTimeoutMs = 20_000;
const outputTailCharacters = 4_000;
const startAttempts = 2;

export class ComponentPreviewServer {
  readonly origin: string;
  // Set when the server runs Blame's own Vite.
  readonly toolkit?: { directory: string; installed: boolean };
  readonly viteVersion: string;
  private readonly serverProcess: ComponentPreviewProcess;
  private readonly token: string;
  private ended = false;

  private constructor(input: {
    origin: string;
    serverProcess: ComponentPreviewProcess;
    token: string;
    toolkit?: { directory: string; installed: boolean };
    viteVersion: string;
  }) {
    this.origin = input.origin;
    this.serverProcess = input.serverProcess;
    this.token = input.token;
    if (input.toolkit) this.toolkit = input.toolkit;
    this.viteVersion = input.viteVersion;
    void input.serverProcess.exited.then(() => {
      this.ended = true;
    });
  }

  static async start(input: ComponentPreviewServerStart) {
    let failure: Error | undefined;
    for (let attempt = 0; attempt < startAttempts; attempt += 1) {
      input.signal?.throwIfAborted();
      const port = await freeLocalPort(new Set());
      const token = randomBytes(18).toString("base64url");
      const serverProcess = input.host.start(
        componentPreviewServerArguments({
          cacheName: input.cacheName,
          host: input.host.bindHost,
          idleMs: input.idleMs,
          packageDir: input.host.path(input.packageDir),
          port,
          token,
          ...(input.toolkit
            ? {
                toolkit: {
                  framework: input.toolkit.framework,
                  root: input.host.toolkitRoot ?? "",
                },
              }
            : {}),
        }),
        port,
      );
      try {
        const listening = await waitUntilListening(serverProcess, input.signal);
        const origin = `http://127.0.0.1:${port}`;
        await waitUntilReachable(origin, token, serverProcess, input.signal);
        return new ComponentPreviewServer({
          origin,
          serverProcess,
          token,
          ...(listening.toolkit ? { toolkit: listening.toolkit } : {}),
          viteVersion: listening.vite,
        });
      } catch (error) {
        await serverProcess.stop();
        failure = error instanceof Error ? error : new Error(String(error));
        // Another program took the port between the check and the start.
        if (!/already in use|EADDRINUSE/iu.test(failure.message)) break;
      }
    }
    throw failure ?? new Error("The component preview server did not start.");
  }

  get running() {
    return !this.ended;
  }

  pageUrl(query: ComponentPreviewPageQuery) {
    const url = new URL(
      `${componentPreviewPagePath}/${this.token}`,
      this.origin,
    );
    url.searchParams.set("file", query.file);
    url.searchParams.set("state", query.state);
    url.searchParams.set("theme", query.theme);
    if (query.fresh) url.searchParams.set("fresh", "1");
    return url.toString();
  }

  stop() {
    return this.serverProcess.stop();
  }
}

function waitUntilListening(
  serverProcess: ComponentPreviewProcess,
  signal?: AbortSignal,
) {
  return new Promise<
    Extract<ComponentPreviewServerReport, { event: "listening" }>
  >((resolve, reject) => {
    let pending = "";
    let tail = "";
    let settled = false;
    let timeoutMs = listenTimeoutMs;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      action();
    };
    const aborted = () =>
      settle(() => reject(signal?.reason ?? new Error("Cancelled.")));
    const timedOut = () =>
      settle(() =>
        reject(
          new Error(
            `It did not listen within ${timeoutMs / 1_000} s.${outputExcerpt(tail)}`,
          ),
        ),
      );
    let timer = setTimeout(timedOut, timeoutMs);
    signal?.addEventListener("abort", aborted, { once: true });
    serverProcess.onOutput((chunk, stream) => {
      tail = `${tail}${chunk}`.slice(-outputTailCharacters);
      if (stream !== "stdout") return;
      pending += chunk;
      const lines = pending.split(/\r?\n/u);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const report = componentPreviewServerReport(line);
        if (report?.event === "installing" && !settled) {
          clearTimeout(timer);
          timeoutMs = installTimeoutMs;
          timer = setTimeout(timedOut, timeoutMs);
        } else if (report?.event === "listening") settle(() => resolve(report));
        else if (report?.event === "error")
          settle(() => reject(new Error(report.message)));
      }
    });
    void serverProcess.exited.then(() =>
      settle(() =>
        reject(new Error(`It stopped before listening.${outputExcerpt(tail)}`)),
      ),
    );
  });
}

// The port is forwarded to this computer shortly after the server listens;
// the token proves the answer comes from this server, not from another
// program on the same port.
async function waitUntilReachable(
  origin: string,
  token: string,
  serverProcess: ComponentPreviewProcess,
  signal?: AbortSignal,
) {
  let ended = false;
  void serverProcess.exited.then(() => {
    ended = true;
  });
  const deadline = Date.now() + reachTimeoutMs;
  const health = `${origin}${componentPreviewPagePath}/${token}/health`;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (ended) throw new Error("It stopped right after it started.");
    try {
      const response = await fetch(health, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok && (await response.text()) === token) return;
    } catch {
      // Not forwarded yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `It listens, but ${origin} did not answer from this computer within ${reachTimeoutMs / 1_000} s.`,
  );
}

function outputExcerpt(output: string) {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-12)
    .join("\n");
  return lines ? `\n${lines}` : "";
}
