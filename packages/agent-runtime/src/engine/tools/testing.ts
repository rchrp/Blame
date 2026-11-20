// For the client tools' tests: a call context, and a tool set that answers
// one call the way the engine host does.

import type {
  JsonValue,
  ToolHostContext,
  ToolResult,
} from "@blame/engine-client";
import { ToolSet, type ClientTool, type ToolCallContext } from "../tool.js";
import { clientToolGuards } from "./guards.js";
import { clientToolPolicy } from "./policy.js";

export function toolContext(
  overrides: Partial<ToolCallContext> = {},
): ToolCallContext & { progressed: string[] } {
  const progressed: string[] = [];
  return {
    session: "session-1",
    turn: "turn-1",
    call: "call-1",
    signal: new AbortController().signal,
    progress: (text) => progressed.push(text),
    progressed,
    ...overrides,
  };
}

/** Runs one call through a tool set with the host's policy and guards. */
export async function callThroughToolSet(
  tools: ClientTool<never>[],
  name: string,
  input: Record<string, unknown>,
  session = "session-1",
): Promise<
  ToolResult & { blobs: Array<{ media_type: string; data: string }> }
> {
  const blobs: Array<{ media_type: string; data: string }> = [];
  const set = new ToolSet([], {
    policy: clientToolPolicy,
    guards: clientToolGuards,
    putBlob: async (params) => {
      blobs.push(params);
      return {
        sha256: String(blobs.length).padStart(64, "0"),
        media_type: params.media_type,
        bytes: Buffer.from(params.data, "base64").length,
      };
    },
  });
  set.setSessionTools(session, tools);
  const host: ToolHostContext = {
    signal: new AbortController().signal,
    id: 1,
    progress: () => undefined,
  };
  const result = await set.handle(
    {
      session,
      turn: "turn-1",
      call: "call-1",
      name,
      input: input as JsonValue,
    },
    host,
  );
  return { ...result, blobs };
}
