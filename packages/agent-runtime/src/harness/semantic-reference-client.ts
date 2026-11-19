import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { sha256 } from "./light-identity.js";
import {
  semanticReferenceLimits,
  type ReferenceFootprint,
  type SemanticReferenceReply,
  type SemanticReferenceRequest,
  type DependencyDeclarationRequest,
  type DependencyDeclarationReply,
} from "./semantic-reference-types.js";

export async function querySemanticReferences(
  request: SemanticReferenceRequest,
  signal?: AbortSignal,
  timeoutMs: number = semanticReferenceLimits.timeoutMs,
): Promise<SemanticReferenceReply> {
  return compilerServices.query<SemanticReferenceReply>(request, signal, timeoutMs);
}

export async function queryDependencyDeclaration(
  request: DependencyDeclarationRequest,
  signal?: AbortSignal,
  timeoutMs: number = semanticReferenceLimits.timeoutMs,
): Promise<DependencyDeclarationReply> {
  return compilerServices.query<DependencyDeclarationReply>(request, signal, timeoutMs);
}

type CompilerRequest = SemanticReferenceRequest | DependencyDeclarationRequest;

/**
 * One compiler worker per workspace root, kept while an agent goes on
 * searching it: loading a project's program costs 2-3 s of CPU (measured
 * 2026-11-19: 882 files for packages/agent-runtime), a search in a loaded
 * one tens of milliseconds. A worker holds its parsed files (263 MB of heap
 * there, about 470 MB of footprint, at most `workerHeapMb` of heap), so at
 * most `services` live, one per story, and each stops after
 * `serviceIdleMs` without a request.
 */
export class CompilerServices {
  private readonly services = new Map<string, CompilerService>();
  private readonly idleMs: number;
  private readonly limit: number;

  constructor(options: { idleMs?: number; limit?: number } = {}) {
    this.idleMs = options.idleMs ?? semanticReferenceLimits.serviceIdleMs;
    this.limit = options.limit ?? semanticReferenceLimits.services;
  }

  /** Roots with a service, least recently used first. */
  get roots() {
    return [...this.services.keys()];
  }

  query<T extends { status: string }>(
    request: CompilerRequest,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<T> {
    signal?.throwIfAborted();
    const root = resolve(request.root);
    let service = this.services.get(root);
    if (service) this.services.delete(root);
    else {
      // A new root takes the place of the least recently used service, an
      // idle one first, once it has answered what it holds.
      let ready: Promise<void> | undefined;
      if (this.services.size >= this.limit) {
        const [key, victim] =
          [...this.services].find(([, entry]) => entry.idle) ??
          [...this.services][0]!;
        this.services.delete(key);
        ready = victim.retire();
      }
      const created: CompilerService = new CompilerService(root, this.idleMs, ready, () => {
        if (this.services.get(root) === created) this.services.delete(root);
      });
      service = created;
    }
    this.services.set(root, service);
    return service.run<T>(request, signal, timeoutMs);
  }

  /** Stops every worker. */
  async close() {
    const services = [...this.services.values()];
    this.services.clear();
    await Promise.all(services.map((service) => service.retire()));
  }
}

class CompilerService {
  private worker?: Worker;
  private tail: Promise<void>;
  private pending = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private retired?: Promise<void>;
  // Stops the request the worker is answering.
  private stopCurrent?: () => void;

  private readonly root: string;
  private readonly idleMs: number;
  private readonly onIdle: () => void;

  constructor(
    root: string,
    idleMs: number,
    ready: Promise<void> | undefined,
    onIdle: () => void,
  ) {
    this.root = root;
    this.idleMs = idleMs;
    this.onIdle = onIdle;
    this.tail = ready ?? Promise.resolve();
  }

  get idle() {
    return this.pending === 0;
  }

  // Requests take turns; each one's deadline and cancellation start when it
  // is asked, as with a worker of its own.
  run<T>(request: CompilerRequest, signal: AbortSignal | undefined, timeoutMs: number) {
    this.pending += 1;
    clearTimeout(this.timer);
    this.worker?.ref();
    let settled = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    return new Promise<T>((resolve, reject) => {
      const settle = (done: () => void) => {
        if (settled) return false;
        settled = true;
        done();
        return true;
      };
      // A deadline or a cancellation also stops the worker answering it.
      const stop = (done: () => void) => {
        if (settle(done) && running) this.stopCurrent?.();
      };
      onAbort = () =>
        stop(() => reject(signal?.reason ?? new Error("Reference query cancelled")));
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(
        () => stop(() => resolve(unavailable("query_timeout") as T)),
        timeoutMs,
      );
      const turn = this.tail.then(() => {
        if (settled) return;
        running = true;
        return this.dispatch(request, (reply) => settle(() => resolve(reply as T)));
      });
      this.tail = turn.then(() => undefined, () => undefined);
    }).finally(() => {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      this.pending -= 1;
      if (this.pending || this.retired) return;
      this.worker?.unref();
      this.timer = setTimeout(() => {
        this.onIdle();
        void this.retire();
      }, this.idleMs);
      this.timer.unref();
    });
  }

  /** Stops the worker after the requests it holds. */
  retire() {
    clearTimeout(this.timer);
    this.retired ??= this.tail.then(async () => {
      const worker = this.worker;
      this.worker = undefined;
      await worker?.terminate();
    });
    return this.retired;
  }

  private dispatch(request: CompilerRequest, reply: (value: unknown) => void) {
    const worker = (this.worker ??= this.spawn());
    return new Promise<void>((done) => {
      const finish = (stop: boolean) => {
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
        this.stopCurrent = undefined;
        if (!stop) return done();
        // A worker stopped mid-request holds unknown state: the next
        // request gets a new one, once this one is gone.
        if (this.worker === worker) this.worker = undefined;
        void worker.terminate().then(() => done(), () => done());
      };
      const onMessage = (value: unknown) => {
        reply(value);
        finish(false);
      };
      const onError = () => {
        reply(unavailable("worker_failed"));
        finish(true);
      };
      const onExit = () => {
        reply(unavailable("worker_exited"));
        finish(true);
      };
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
      this.stopCurrent = () => finish(true);
      worker.postMessage(request);
    });
  }

  private spawn() {
    const worker = new Worker(
      new URL("./semantic-reference-worker.js", import.meta.url),
      {
        workerData: { root: this.root },
        resourceLimits: {
          maxOldGenerationSizeMb: semanticReferenceLimits.workerHeapMb,
        },
        // Strip host test/loader arguments; workers execute the packaged JS module.
        execArgv: [],
      },
    );
    // A failure between requests ends the worker; the next request gets another.
    worker.on("error", () => {});
    worker.once("exit", () => {
      if (this.worker === worker) this.worker = undefined;
    });
    return worker;
  }
}

const unavailable = (reason: string) => ({ status: "unavailable", reason });

const compilerServices = new CompilerServices();

export async function referenceFootprintIsCurrent(
  footprint: ReferenceFootprint,
  signal?: AbortSignal,
) {
  // Bounded batches keep file-descriptor pressure independent of project size.
  const checks = [
    ...(footprint.realpaths ?? []).map(({ path, resolved }) => async () => {
      try { return await realpath(path) === resolved; } catch { return false; }
    }),
    ...footprint.reads.map(({ path, hash }) => async () => {
      try {
        return sha256(await readFile(path)) === hash;
      } catch {
        return false;
      }
    }),
    ...footprint.existence.map(({ path, exists }) => async () => {
      try {
        return (await stat(path)).isFile() === exists;
      } catch {
        return !exists;
      }
    }),
  ];
  for (let index = 0; index < checks.length; index += 32) {
    signal?.throwIfAborted();
    if (
      (
        await Promise.all(
          checks.slice(index, index + 32).map((check) => check()),
        )
      ).some((current) => !current)
    )
      return false;
  }
  return true;
}
