// The hand-written part of the protocol: the JSON-RPC envelope and the result
// each method is answered with. Everything else comes from Rust (see
// ./generated/protocol.ts); the type checks at the bottom fail the build when
// a method is added there and not handled here.

import type {
  Approval,
  BlobPulled,
  BlobRef,
  ClientRequest,
  Credential,
  EngineNotification,
  EngineRequest,
  Initialized,
  LogPushed,
  MessageAccepted,
  ModelCatalog,
  Records,
  Rewound,
  SessionList,
  SessionOpened,
  Subscribed,
  ToolResult,
} from "./generated/protocol.js";

export * from "./generated/protocol.js";

/** Position of a record in its session, from 1. (A Rust type alias, so not generated.) */
export type Seq = number;

/** JSON-RPC ids are numbers on both sides of this protocol. */
export type RpcId = number;

export interface RpcRequestMessage {
  jsonrpc: "2.0";
  id: RpcId;
  method: string;
  params?: unknown;
}

export interface RpcNotificationMessage {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface RpcResponseMessage {
  jsonrpc: "2.0";
  id: RpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: { kind: string } };
}

/** JSON-RPC 2.0 reserved codes the client answers the engine with. */
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;
/** Application errors, as the Rust side documents it. */
export const RPC_SERVER_ERROR = -32000;

/** The `result` of each request the client sends. */
export interface ClientResults {
  initialize: Initialized;
  "session/create": SessionOpened;
  "session/open": SessionOpened;
  "session/list": SessionList;
  "session/read": Records;
  "session/subscribe": Subscribed;
  "session/unsubscribe": null;
  "session/send": MessageAccepted;
  "session/interrupt": null;
  "session/rewind": Rewound;
  "session/undo_rewind": null;
  "session/fork": SessionOpened;
  "session/compact": null;
  "session/configure": null;
  "session/close": null;
  "blob/put": BlobRef;
  "catalog/list": ModelCatalog;
  shutdown: null;
}

/** What the client says without waiting for an answer. */
export type ClientNotification = "$/cancel" | "tool/progress";

/** Requests that are answered; the `ClientNotification`s are not. */
export type ClientMethod = keyof ClientResults;

/** The parameters of a client request, as generated from Rust. */
export type ParamsOf<M extends ClientMethod> = Extract<
  ClientRequest,
  { method: M }
>["params"];

/** The `result` of each request the engine sends. */
export interface HostResults {
  "host/tool": ToolResult;
  "host/approval": Approval;
  "host/credential": Credential;
  "host/log/push": LogPushed;
  "host/log/pull": Records;
  "host/blob/push": null;
  "host/blob/pull": BlobPulled;
}

export type HostMethod = keyof HostResults;

export type HostParamsOf<M extends HostMethod> = Extract<
  EngineRequest,
  { method: M }
>["params"];

export type EngineNotificationOf<M extends EngineNotification["method"]> =
  Extract<EngineNotification, { method: M }>;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type MustBeTrue<T extends true> = T;

export type _ClientMethodsAreAllHandled = MustBeTrue<
  Same<ClientMethod | ClientNotification, ClientRequest["method"]>
>;
export type _HostMethodsAreAllHandled = MustBeTrue<
  Same<HostMethod | "$/cancel", EngineRequest["method"]>
>;
