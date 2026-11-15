import type { PreviewExecutionPlan } from "@blame/preview-runtime";
import type { DockerHost } from "@blame/preview-runtime/compose";
import {
  captureCompileCache,
  compileCacheDirectories,
  compileCacheRefreshSeconds,
  seedCompileCache,
  type CompileCacheTarget,
} from "./local-preview-compile-cache.ts";
import {
  createCompileQueue,
  type CompileQueue,
  type CompileStartKind,
} from "./local-preview-compile-queue.ts";

// The start of a preview whose dev server has no compiled cache yet: it is
// seeded from its dependency key's snapshot when one exists, then waits for
// a turn to compile (local-preview-compile-queue.ts) right before its
// services start. The turn ends once the first page answered; a cold start
// keeps it until its compiler has written the cache, its memory peak, and
// that cache became the snapshot of the next stories. Starts that find
// their own cache, or whose services already run, take neither path.

export type ColdStart = {
  kind: CompileStartKind;
  /** Waits for a turn to compile; called right before the services start. */
  enter(): Promise<void>;
  /** The first page answered: the turn ends now or after the snapshot. */
  answered(): void;
  /** The start failed or was dropped: ends the turn if it still holds it. */
  end(): void;
};

export type ColdStartInput = {
  host: DockerHost;
  worktree: string;
  plan: Pick<PreviewExecutionPlan, "services">;
  serviceIds: string[];
  dependencyKey: string;
  owner: { uid: number; gid: number };
  /** Whether a selected service already runs. */
  running: boolean;
  log?: (chunk: string) => void;
  step?: (step: string) => void;
  timing?: (label: string, durationMs: number) => void;
  queue?: CompileQueue;
};

let queueHost: DockerHost | undefined;
const sharedQueue = createCompileQueue({
  availableMemory: () =>
    queueHost ? availableMemory(queueHost) : Promise.resolve(undefined),
});

export async function prepareColdStart(
  input: ColdStartInput,
): Promise<ColdStart | undefined> {
  if (input.running || !input.serviceIds.length) return undefined;
  const directories = await compileCacheDirectories(
    input.host,
    input.worktree,
    input.plan,
    input.serviceIds,
  ).catch(() => []);
  if (!directories.length) return undefined;
  const target: CompileCacheTarget = {
    worktree: input.worktree,
    dependencyKey: input.dependencyKey,
    directories,
    owner: input.owner,
  };
  const startedAt = Date.now();
  const seed = await seedCompileCache(input.host, target).catch(
    (error: unknown) => ({
      state: "cold" as const,
      reason: error instanceof Error ? error.message : String(error),
    }),
  );
  input.timing?.("compile-cache.seed", Date.now() - startedAt);
  if (seed.state === "warm") return undefined;
  if (seed.state === "seeded")
    input.log?.(
      `Seeded the compile cache from another story's (${Math.round(seed.snapshotAgeSeconds / 60)} min old).\n`,
    );
  else
    input.log?.(
      `No compile cache to reuse (${seed.reason}): the first pages compile everything.\n`,
    );
  const kind: CompileStartKind = seed.state === "seeded" ? "seeded" : "cold";
  const capture =
    seed.state === "cold" ||
    seed.snapshotAgeSeconds > compileCacheRefreshSeconds;
  if (!input.queue) queueHost = input.host;
  return coldStart(input, target, kind, capture);
}

function coldStart(
  input: ColdStartInput,
  target: CompileCacheTarget,
  kind: CompileStartKind,
  capture: boolean,
): ColdStart {
  const queue = input.queue ?? sharedQueue;
  let leave: (() => void) | undefined;
  let handedOff = false;
  let enteredAt = 0;
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    if (enteredAt) input.timing?.("compile.turn", Date.now() - enteredAt);
    leave?.();
  };
  return {
    kind,
    async enter() {
      if (leave || ended) return;
      const askedAt = Date.now();
      leave = await queue.enter(kind, () =>
        input.step?.("Waiting for another preview to compile"),
      );
      // Dropped while it waited: give the turn back at once.
      if (ended) return leave();
      enteredAt = Date.now();
      if (enteredAt - askedAt > 1_000)
        input.timing?.("compile.wait", enteredAt - askedAt);
    },
    answered() {
      if (handedOff) return;
      handedOff = true;
      if (!capture) return finish();
      void captureCompileCache(input.host, target)
        .then((captured) => {
          if (captured)
            input.log?.("Saved the compile cache for the next stories.\n");
        })
        .catch(() => undefined)
        .finally(finish);
    },
    end() {
      if (!handedOff) finish();
    },
  };
}

/** MemAvailable of the Docker host, in bytes. */
export async function availableMemory(host: DockerHost) {
  const result = await host.run(
    "sh",
    ["-c", "awk '/^MemAvailable:/ { print $2 * 1024 }' /proc/meminfo"],
    { timeoutMs: 10_000 },
  );
  const bytes = Number(result.stdout.trim());
  return result.exitCode === 0 && bytes > 0 ? bytes : undefined;
}
