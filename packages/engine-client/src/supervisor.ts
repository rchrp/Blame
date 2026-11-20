import type { EngineClient } from "./client.js"
import { EngineClosedError, type EngineExit } from "./errors.js"

/** Hands out a connected engine client, whichever one that is right now. */
export interface ClientSource {
  /** Resolves to a client that is ready; a source may start an engine to do so. */
  client(signal?: AbortSignal): Promise<EngineClient>
}

/** A source that only ever has this one client: when it ends, nothing replaces it. */
export function fixedClient(client: EngineClient): ClientSource {
  return { client: async () => client }
}

/**
 * Keeps one engine running for the app: starts it on first use and again,
 * on the next use, after it exits or crashes. It never restarts on its own, so
 * a crash loop cannot spin: whoever needs the engine asks for it (a
 * `SessionFollower` does, with a delay between attempts).
 */
export class EngineSupervisor implements ClientSource {
  private currentClient: EngineClient | undefined
  private starting: Promise<EngineClient> | undefined
  private stopped = false
  private readonly started = new Set<(client: EngineClient) => void>()

  constructor(private readonly start: () => Promise<EngineClient>) {}

  /** The running client, if there is one. */
  get current(): EngineClient | undefined {
    return this.currentClient && !this.currentClient.isClosed ? this.currentClient : undefined
  }

  /** Called with each engine this supervisor starts, before anyone is handed it. */
  onStarted(listener: (client: EngineClient) => void): () => void {
    this.started.add(listener)
    return () => this.started.delete(listener)
  }

  async client(signal?: AbortSignal): Promise<EngineClient> {
    if (this.stopped) throw new EngineClosedError("The engine supervisor is stopped")
    const running = this.current
    if (running) return running
    this.starting ??= this.launch()
    const pending = this.starting
    if (!signal) return pending
    // The caller may stop waiting; the start itself goes on for the others.
    return new Promise<EngineClient>((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
      if (signal.aborted) return onAbort()
      signal.addEventListener("abort", onAbort, { once: true })
      pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
    })
  }

  /** Shuts the engine down gracefully and refuses further use. */
  async stop(): Promise<EngineExit | undefined> {
    this.stopped = true
    const client = this.currentClient ?? (await this.starting?.catch(() => undefined))
    return client?.shutdown()
  }

  private async launch(): Promise<EngineClient> {
    try {
      const client = await this.start()
      if (this.stopped) {
        await client.shutdown()
        throw new EngineClosedError("The engine supervisor is stopped")
      }
      this.currentClient = client
      for (const listener of this.started) listener(client)
      return client
    } finally {
      this.starting = undefined
    }
  }
}
