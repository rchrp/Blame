import { posix } from "node:path";
import {
  componentPreviewSandbox,
  type ComponentPreviewSandboxCursor,
  type ComponentPreviewSandboxOutput,
  type ComponentPreviewSandboxStart,
  type PreviewSessionView,
} from "@blame/preview-runtime";
import type { DesktopBridgeGrant } from "../preview-browser/preview-bridge-grant.ts";
import type {
  ComponentPreviewHost,
  ComponentPreviewProcess,
} from "./component-preview-hosts.ts";
import {
  ComponentPreviewRelay,
  type ComponentPreviewRelayTransport,
} from "./component-preview-relay.ts";
import { componentPreviewServerReport } from "./component-preview-server-script.ts";
import type { ComponentPreviewTarget } from "./component-preview-service.ts";

// The host of a cloud preview's component preview server: its sandbox, where
// the story's dependencies are installed. The cloud API starts the server in
// a one-off container of the preview and returns its own capability route;
// a relay on this computer gives it a local origin, and the server's output
// is read from the sandbox while it starts. The server, its page and its
// lifecycle are those of any other host.

export type CloudComponentPreviewSandbox = {
  output(
    cursor: ComponentPreviewSandboxCursor,
  ): Promise<ComponentPreviewSandboxOutput>;
  // A fresh capability for the running server.
  refresh(port: number): Promise<DesktopBridgeGrant>;
  start(input: ComponentPreviewSandboxStart): Promise<DesktopBridgeGrant>;
  stop(): Promise<unknown>;
};

// What the desktop's cloud preview service offers for it.
export type CloudComponentPreviews = {
  componentPreviewOutput(
    sessionId: string,
    cursor: ComponentPreviewSandboxCursor,
  ): Promise<ComponentPreviewSandboxOutput>;
  findForUserStory(
    userStoryId: string,
    profile: "vercel-compose",
  ): Promise<{ session: Pick<PreviewSessionView, "id" | "state"> | null }>;
  refreshComponentPreview(
    sessionId: string,
    port: number,
  ): Promise<DesktopBridgeGrant>;
  startComponentPreview(
    sessionId: string,
    input: ComponentPreviewSandboxStart,
  ): Promise<DesktopBridgeGrant>;
  stopComponentPreview(sessionId: string): Promise<unknown>;
  // Sends this computer's pending edits to the sandbox.
  syncBarrier(worktree: string): Promise<unknown>;
};

export type CloudComponentPreviewOptions = {
  // Output polling while the server starts, then while it runs.
  pollMs?: { running: number; starting: number };
  transport?: ComponentPreviewRelayTransport;
};

const defaultPollMs = { running: 10_000, starting: 750 };
// Consecutive failed polls, such as a runner busy with a source import,
// before the server is considered lost.
const maximumPollFailures = 40;

// The cloud host for this story, once its preview is ready and the sandbox
// has this computer's version of the files.
export async function cloudComponentPreviewHostFor(
  previews: CloudComponentPreviews,
  target: ComponentPreviewTarget,
  options: CloudComponentPreviewOptions = {},
): Promise<ComponentPreviewHost | { message: string }> {
  if (!target.storyId)
    return {
      message:
        "open_component_preview runs in the story's cloud preview, and this session has no story.",
    };
  try {
    const { session } = await previews.findForUserStory(
      target.storyId,
      "vercel-compose",
    );
    if (
      !session ||
      session.state.host !== "running" ||
      session.state.preview !== "ready"
    )
      return {
        message:
          "Start the story's cloud preview first: open_component_preview runs its temporary server in the preview's sandbox, where the dependencies are installed.",
      };
    await previews.syncBarrier(target.worktree);
    const sessionId = session.id;
    return cloudComponentPreviewHost({
      ...options,
      sandbox: {
        output: (cursor) => previews.componentPreviewOutput(sessionId, cursor),
        refresh: (port) => previews.refreshComponentPreview(sessionId, port),
        start: (input) => previews.startComponentPreview(sessionId, input),
        stop: () => previews.stopComponentPreview(sessionId),
      },
      sessionId,
    });
  } catch (error) {
    return {
      message: `Blame could not reach the story's cloud preview: ${errorMessage(error)}`,
    };
  }
}

export function cloudComponentPreviewHost(
  input: CloudComponentPreviewOptions & {
    sandbox: CloudComponentPreviewSandbox;
    sessionId: string;
  },
): ComponentPreviewHost {
  return {
    bindHost: "0.0.0.0",
    description: "the cloud preview's sandbox",
    key: `cloud:${input.sessionId}`,
    path: (relativePath) => posix.join("/workspace", relativePath),
    start: (nodeArguments, port) =>
      startInSandbox(input, { nodeArguments, port }),
    toolkitRoot: componentPreviewSandbox.toolkitRoot,
  };
}

type Listener = (chunk: string, stream: "stderr" | "stdout") => void;

// The server listens on the same port in its container as the relay here.
function startInSandbox(
  input: CloudComponentPreviewOptions & {
    sandbox: CloudComponentPreviewSandbox;
  },
  start: ComponentPreviewSandboxStart,
): ComponentPreviewProcess {
  const { sandbox } = input;
  const listeners = new Set<Listener>();
  const emit: Listener = (chunk, stream) =>
    listeners.forEach((listener) => listener(chunk, stream));
  const relay = new ComponentPreviewRelay(
    () => sandbox.refresh(start.port),
    input.transport,
  );
  const wake = new AbortController();
  let resolveExited = () => {};
  const exited = new Promise<void>((resolve) => (resolveExited = resolve));
  let stopping: Promise<void> | undefined;
  void (async () => {
    try {
      await relay.listen(start.port);
      relay.use(await sandbox.start(start));
      // Stopped while the sandbox started it: it stops now.
      if (wake.signal.aborted) await sandbox.stop().catch(() => undefined);
      else
        await followOutput(
          sandbox,
          emit,
          wake.signal,
          input.pollMs ?? defaultPollMs,
        );
    } catch (error) {
      if (!wake.signal.aborted) emit(`${errorMessage(error)}\n`, "stderr");
    } finally {
      await relay.close();
      resolveExited();
    }
  })();
  return {
    exited,
    onOutput: (listener) => void listeners.add(listener),
    stop() {
      stopping ??= (async () => {
        wake.abort();
        await sandbox.stop().catch(() => undefined);
        await relay.close();
        resolveExited();
      })();
      return stopping;
    },
  };
}

async function followOutput(
  sandbox: CloudComponentPreviewSandbox,
  emit: Listener,
  signal: AbortSignal,
  pollMs: { running: number; starting: number },
) {
  let cursor: ComponentPreviewSandboxCursor = { stderr: 0, stdout: 0 };
  let failures = 0;
  let listening = false;
  while (!signal.aborted) {
    let output: ComponentPreviewSandboxOutput;
    try {
      output = await sandbox.output(cursor);
      failures = 0;
    } catch (error) {
      failures += 1;
      if (failures >= maximumPollFailures)
        throw new Error(
          `Blame lost the component preview server in the sandbox: ${errorMessage(error)}`,
        );
      await delay(listening ? pollMs.running : pollMs.starting, signal);
      continue;
    }
    cursor = output.cursor;
    if (output.stdout) emit(output.stdout, "stdout");
    if (output.stderr) emit(output.stderr, "stderr");
    listening ||= output.stdout
      .split(/\r?\n/u)
      .some(
        (line) => componentPreviewServerReport(line)?.event === "listening",
      );
    if (!output.running) return;
    await delay(listening ? pollMs.running : pollMs.starting, signal);
  }
}

function delay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    timer.unref?.();
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

// A cloud API failure says why in its own message, without the response.
function errorMessage(error: unknown) {
  const failure = (error as { failure?: { message?: unknown } } | undefined)
    ?.failure;
  if (typeof failure?.message === "string" && failure.message)
    return failure.message;
  return error instanceof Error ? error.message : String(error);
}
