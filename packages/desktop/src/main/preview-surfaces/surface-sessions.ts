import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { PreviewService } from "../preview-runtime/preview-service.ts";
import { TerminalSurface, terminalKeys } from "./terminal-surface.ts";
import { surfaceUpstream, type SurfaceScope } from "./surface-upstream.ts";
import { surfaceEnabled } from "./experimental-surfaces.ts";

type Session = { id: string; scope: SurfaceScope; terminal: TerminalSurface };
const sessions = new Map<string, Session>();
let previews: PreviewService;
export function configureSurfaceSessions(service: PreviewService) {
  previews = service;
}
export async function attachSurfaceTerminal(
  scope: SurfaceScope,
  size?: { columns?: number; rows?: number },
) {
  if (!surfaceEnabled("terminal"))
    throw new Error("Terminal previews are not enabled on this computer.");
  const key = `${scope.storyId}:${scope.serviceId}`;
  let session = sessions.get(key);
  if (
    session &&
    (session.scope.sessionId !== scope.sessionId ||
      session.scope.worktree !== scope.worktree)
  ) {
    session.terminal.dispose();
    sessions.delete(key);
    session = undefined;
  }
  if (!session) {
    const terminal = new TerminalSurface(
      () => surfaceUpstream(scope, "terminal", previews, "tty"),
      size?.columns,
      size?.rows,
    );
    const decoder = new StringDecoder("utf8");
    terminal.on("bytes", (data: Buffer) => {
      const text = decoder.write(data);
      if (text) terminal.emit("event", { type: "stdout", data: text });
    });
    session = { id: randomUUID(), scope, terminal };
    sessions.set(key, session);
  }
  if (session.terminal.exitCode === undefined) await session.terminal.connect();
  return {
    session,
    replay: await session.terminal.replay(),
    state: await session.terminal.snapshot(),
  };
}
export function surfaceTerminalById(id: string) {
  return [...sessions.values()].find((s) => s.id === id)?.terminal;
}
export function stopSurfaceTerminals(storyId?: string, worktree?: string) {
  for (const [key, session] of sessions) {
    if (
      (storyId && session.scope.storyId !== storyId) ||
      (worktree && session.scope.worktree !== worktree)
    )
      continue;
    session.terminal.dispose();
    sessions.delete(key);
  }
}
export async function terminalSurfaceAction(
  scope: SurfaceScope,
  input: Record<string, unknown>,
  signal?: AbortSignal,
) {
  try {
    const { session } = await attachSurfaceTerminal(scope);
    const terminal = session.terminal;
    switch (input.action) {
      case "read":
        break;
      case "type": {
        if (typeof input.text !== "string" || input.text.length > 64000)
          throw new Error("Type at most 64000 characters.");
        terminal.write(input.text + (input.submit === true ? "\r" : ""));
        break;
      }
      case "key": {
        const key = terminalKeys[String(input.key)];
        if (!key) throw new Error("This key is not supported.");
        terminal.write(key);
        break;
      }
      case "wait_for":
        return terminal.waitFor(
          String(input.pattern ?? ""),
          Number(input.timeoutMs) || 10000,
          signal,
        );
      case "restart":
        await terminal.restart();
        break;
      default:
        throw new Error("Unknown terminal action.");
    }
    return terminal.snapshot();
  } catch (error) {
    return {
      status: "unavailable",
      message:
        error instanceof Error ? error.message : "The terminal is unavailable.",
    };
  }
}
