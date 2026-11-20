import type {
  Approval,
  BlobPulled,
  Credential,
  HostParamsOf,
  LogPushed,
  Records,
  ToolResult,
} from "./protocol.js";

/** Passed to every handler: the request it answers and whether the engine gave up on it. */
export interface HostContext {
  /** Aborted when the engine sends `$/cancel` for this request or the connection ends. */
  signal: AbortSignal;
  /** The JSON-RPC id of the engine's request. */
  id: number;
}

/** What a `host/tool` handler is also given: a way to say how the call is going. */
export interface ToolHostContext extends HostContext {
  /** Sent to the engine as `tool/progress`; viewers see it as a `tool_progress` delta. */
  progress(text: string): void;
}

type Handler<Params, Result> = (
  params: Params,
  context: HostContext,
) => Promise<Result> | Result;

/**
 * What only the client has. The engine asks; a method with no handler is
 * answered with "method not found", which the engine reports to the model or
 * the user as a missing capability.
 *
 * The four log and blob handlers go together: they let the engine copy
 * sessions to Blame's database through the client, so supplying some but not
 * all is a mistake and is rejected when the client starts.
 */
export interface HostHandlers {
  /** Runs one of the session's `client_tools`. */
  tool?: (
    params: HostParamsOf<"host/tool">,
    context: ToolHostContext,
  ) => Promise<ToolResult> | ToolResult;
  /** Asks the user to allow a tool call. */
  approval?: Handler<HostParamsOf<"host/approval">, Approval>;
  /** Returns the secret for a provider, or `{ type: "missing" }`. Held in memory only by the engine. */
  credential?: Handler<HostParamsOf<"host/credential">, Credential>;
  /** Copies records into Blame's database; returns the highest seq held without a gap. */
  logPush?: Handler<HostParamsOf<"host/log/push">, LogPushed>;
  /** Reads records the engine does not have back from Blame's database. */
  logPull?: Handler<HostParamsOf<"host/log/pull">, Records>;
  blobPush?: Handler<HostParamsOf<"host/blob/push">, null | undefined | void>;
  blobPull?: Handler<HostParamsOf<"host/blob/pull">, BlobPulled>;
}

/** Whether the handlers carry session logs to Blame's database (`remote_log` of `initialize`). */
export function carriesRemoteLog(handlers: HostHandlers): boolean {
  const transfer = [
    handlers.logPush,
    handlers.logPull,
    handlers.blobPush,
    handlers.blobPull,
  ];
  const supplied = transfer.filter((handler) => handler !== undefined).length;
  if (supplied !== 0 && supplied !== transfer.length) {
    throw new Error(
      "logPush, logPull, blobPush and blobPull must be supplied together or not at all",
    );
  }
  return supplied === transfer.length;
}
