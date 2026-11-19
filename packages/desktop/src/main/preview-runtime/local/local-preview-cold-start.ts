import type { PreviewExecutionPlan } from "@blame/preview-runtime";
import type { DockerHost } from "@blame/preview-runtime/compose";
import {
  captureCompileCache,
  type CompileCacheSeed,
  compileCacheDirectories,
  compileCacheRefreshSeconds,
  seedCompileCache,
  type CompileCacheTarget,
} from "./local-preview-compile-cache.ts";
import {
  runtimeHeavyWork,
  type HeavyWorkQueue,
} from "../../runtime-heavy-work.ts";

type CompileStartKind = "cold" | "seeded";

// The start of a preview whose dev server has no compiled cache yet: it is
// seeded from its dependency key's snapshot when one exists, then waits for
// a turn to compile (runtime-heavy-work.ts) right before its
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
  queue?: HeavyWorkQueue;
};

/** How long a cold start keeps its turn after its first page at most. */
const coldTurnLimitMs = 3 * 60_000;

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
  const seeded = await seedFor(input, target);
  if (seeded.state === "warm") return undefined;
  return coldStart(input, target, seeded);
}

async function seedFor(input: ColdStartInput, target: CompileCacheTarget) {
  const startedAt = Date.now();
  const result = await seedCompileCache(input.host, target).catch(
    (error: unknown): CompileCacheSeed => ({
      state: "cold",
      reason: error instanceof Error ? error.message : String(error),
    }),
  );
  input.timing?.("compile-cache.seed", Date.now() - startedAt);
  if (result.state === "seeded")
    input.log?.(
      `Seeded the compile cache from another story's (${Math.round(result.snapshotAgeSeconds / 60)} min old).\n`,
    );
  else if (result.state === "cold")
    input.log?.(`No compile cache to reuse yet (${result.reason}).\n`);
  return result;
}

// A fresh snapshot is kept; a missing or old one is taken from this start.
function needsCapture(seeded: CompileCacheSeed) {
  return (
    seeded.state === "cold" ||
    (seeded.state === "seeded" &&
      seeded.snapshotAgeSeconds > compileCacheRefreshSeconds)
  );
}

function coldStart(
  input: ColdStartInput,
  target: CompileCacheTarget,
  seeded: CompileCacheSeed,
): ColdStart {
  const kind: CompileStartKind = seeded.state === "seeded" ? "seeded" : "cold";
  let capture = needsCapture(seeded);
  const queue = input.queue ?? runtimeHeavyWork;
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
      let waited = false;
      leave = await queue.enter(kind, {
        owner: input.worktree,
        onWait: (reason) => {
          waited = true;
          input.step?.(`Waiting for ${reason}`);
        },
      });
      // Dropped while it waited: give the turn back at once.
      if (ended) return leave();
      enteredAt = Date.now();
      if (!waited) return;
      input.timing?.("compile.wait", enteredAt - askedAt);
      // The start it waited for may have left a snapshot to seed from.
      if (kind === "cold") capture = needsCapture(await seedFor(input, target));
    },
    answered() {
      if (handedOff) return;
      handedOff = true;
      if (!capture) return finish();
      // The compiler writes its cache once idle, the peak of a cold start:
      // the turn lasts until the snapshot, or a while if it never writes.
      const writtenAfter = Math.floor(Date.now() / 1_000);
      const holdLimit = setTimeout(finish, coldTurnLimitMs);
      holdLimit.unref?.();
      void captureCompileCache(input.host, target, {
        writtenAfter,
        writeWaitSeconds: 30,
      })
        .then((captured) => {
          if (captured)
            input.log?.("Saved the compile cache for the next stories.\n");
        })
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(holdLimit);
          finish();
        });
    },
    end() {
      if (!handedOff) finish();
    },
  };
}
