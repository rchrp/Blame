import type { ErrorKind } from "./protocol.js"

/** What became of the engine process (or connection). */
export interface EngineExit {
  /** True when the client asked for the engine to stop. */
  expected: boolean
  code: number | null
  signal: string | null
  /** The failure that ended the connection when it was not an exit code. */
  error?: Error
  /** The last lines the engine wrote to stderr: usually the reason it died. */
  stderrTail: readonly string[]
}

/** The engine answered a request with a JSON-RPC error. */
export class EngineRpcError extends Error {
  readonly code: number
  /** The engine's error classification, when it gave one. */
  readonly kind?: ErrorKind

  constructor(code: number, message: string, kind?: ErrorKind) {
    super(message)
    this.name = "EngineRpcError"
    this.code = code
    this.kind = kind
  }
}

/** The engine ended while a request was waiting for its answer, or before one could be sent. */
export class EngineExitedError extends Error {
  readonly exit: EngineExit

  constructor(exit: EngineExit) {
    super(describeExit(exit))
    this.name = "EngineExitedError"
    this.exit = exit
  }
}

/** The client was shut down on purpose and cannot be used any more. */
export class EngineClosedError extends Error {
  constructor(message = "The engine client is closed") {
    super(message)
    this.name = "EngineClosedError"
  }
}

/** The engine speaks another protocol version than this client. */
export class EngineProtocolVersionError extends Error {
  readonly expected: number
  readonly actual: number
  readonly engineVersion: string

  constructor(expected: number, actual: number, engineVersion: string) {
    super(
      `The engine (${engineVersion}) speaks protocol version ${actual}, this client speaks ${expected}`,
    )
    this.name = "EngineProtocolVersionError"
    this.expected = expected
    this.actual = actual
    this.engineVersion = engineVersion
  }
}

/** A request waited longer than its timeout. */
export class EngineTimeoutError extends Error {
  constructor(what: string, timeoutMs: number) {
    super(`${what} timed out after ${timeoutMs} ms`)
    this.name = "EngineTimeoutError"
  }
}

export function describeExit(exit: EngineExit): string {
  const how = exit.error
    ? exit.error.message
    : exit.signal
      ? `was killed by ${exit.signal}`
      : `exited with code ${exit.code}`
  const tail = exit.stderrTail.length > 0 ? `\n${exit.stderrTail.join("\n")}` : ""
  return `The engine ${exit.error ? "failed: " : ""}${how}${tail}`
}
