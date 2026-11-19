import type { DockerHost } from "@blame/preview-runtime/compose";
import { localDockerHost } from "./preview-runtime/local/local-preview-runner.ts";

// Heavy work in the Blame Runtime takes turns: preview starts that compile,
// review builds and the checks agents run (builds, type checks, tests).
// Measured in a 4 GiB Runtime (6 vCPU, 4 GiB swapfile): one cold Next.js
// 16.4 Turbopack start peaks at 3.1 GiB while it writes its cache, a seeded
// one at 1.6 GiB, and three cold starts at once pushed 3 GiB into swap
// (2026-11-15). Three agent checks (tsc --noEmit then next build) at once
// took 468-630 s and 1,153-1,545 CPU-s against 204 s and 384 CPU-s one
// after the other, wrote up to 1.5 GiB to swap, and the kernel killed one
// build (2026-11-19). One piece of work runs whenever none does, and
// another joins only while the Runtime's available memory covers every
// running estimate plus its own, so a 4 GiB Runtime runs one at a time and
// a larger one several. An agent's check never waits for anything but
// another agent's check: an agent working alone is never held up.

export type HeavyWorkKind = "cold" | "seeded" | "build" | "check";

const gib = 1024 * 1024 * 1024;

/** Memory peak of each kind: the measured peaks, plus a margin. */
export const heavyWorkEstimates: Record<HeavyWorkKind, number> = {
  cold: 3.25 * gib,
  seeded: 1.75 * gib,
  // One `next build` or `tsc` plus `next build` used ~1.9 GiB.
  build: 2 * gib,
  check: 2 * gib,
};

export type HeavyWorkQueueOptions = {
  /** Available memory of the Blame Runtime in bytes, when it can be read. */
  availableMemory: () => Promise<number | undefined>;
  estimates?: Record<HeavyWorkKind, number>;
  /** How often waiting work checks memory again while other work runs. */
  recheckMs?: number;
};

export type HeavyWorkTurn = {
  /** Whose work it is: an agent session, a worktree. */
  owner?: string;
  /** Called once if the work has to wait for a turn, with what it waits for. */
  onWait?: (reason: string) => void;
  /** Gives up waiting. */
  signal?: AbortSignal;
};

type Slot = { kind: HeavyWorkKind; estimate: number; owner?: string };
type Waiter = Slot & { admit: () => void };

export type HeavyWorkQueue = ReturnType<typeof createHeavyWorkQueue>;

export function createHeavyWorkQueue(options: HeavyWorkQueueOptions) {
  const estimates = options.estimates ?? heavyWorkEstimates;
  const running = new Set<Slot>();
  const waiting: Waiter[] = [];
  let timer: NodeJS.Timeout | undefined;
  let checking: Promise<void> | undefined;
  let again = false;

  async function admissible(slot: Slot) {
    if (!running.size) return true;
    const available = await options.availableMemory().catch(() => undefined);
    if (available === undefined) return false;
    let reserved = slot.estimate;
    for (const other of running) reserved += other.estimate;
    return available >= reserved;
  }

  // Admits waiting work in order; the first that does not fit makes the
  // rest wait too, so a cold start is not passed by seeded ones.
  function check() {
    if (checking) {
      again = true;
      return checking;
    }
    checking = (async () => {
      do {
        again = false;
        while (waiting.length && (await admissible(waiting[0]!))) {
          const next = waiting.shift()!;
          running.add(next);
          next.admit();
        }
      } while (again);
    })().finally(() => {
      checking = undefined;
      schedule();
    });
    return checking;
  }

  function schedule() {
    if (timer || !waiting.length || !running.size) return;
    timer = setTimeout(() => {
      timer = undefined;
      void check();
    }, options.recheckMs ?? 5_000);
    timer.unref?.();
  }

  // No other agent's check runs or waits: the session's own checks already
  // take turns in the harness.
  function agentAlone(slot: Slot) {
    return ![...running, ...waiting].some(
      (other) => other.kind === "check" && other.owner !== slot.owner,
    );
  }

  /**
   * Waits for a turn. Returns the function that ends the turn; calling it
   * again does nothing.
   */
  async function enter(kind: HeavyWorkKind, turn: HeavyWorkTurn = {}) {
    turn.signal?.throwIfAborted();
    const slot: Slot = { kind, estimate: estimates[kind], owner: turn.owner };
    // Alone, work never reads memory nor waits.
    if (
      (!running.size && !waiting.length) ||
      (kind === "check" && agentAlone(slot))
    ) {
      running.add(slot);
      return leave(slot);
    }
    let waiter!: Waiter;
    const admitted = new Promise<void>((admit, reject) => {
      waiter = Object.assign(slot, { admit });
      waiting.push(waiter);
      turn.signal?.addEventListener(
        "abort",
        () => {
          const index = waiting.indexOf(waiter);
          if (index < 0) return;
          waiting.splice(index, 1);
          reject(turn.signal!.reason);
          void check();
        },
        { once: true },
      );
    });
    // Says so only when the memory check keeps it waiting.
    void check().then(() => {
      if (waiting.includes(waiter)) turn.onWait?.(waitReason(running));
    });
    await admitted;
    return leave(slot);
  }

  function leave(slot: Slot) {
    let left = false;
    return () => {
      if (left) return;
      left = true;
      running.delete(slot);
      void check();
    };
  }

  return {
    enter,
    /** Running and waiting work, for tests and the timing log. */
    get state() {
      return { running: running.size, waiting: waiting.length };
    },
  };
}

const kindReasons: Record<HeavyWorkKind, string> = {
  cold: "another preview to compile",
  seeded: "another preview to compile",
  build: "a review build",
  check: "another agent's build or tests",
};

/** What the running work is, in words: "another preview to compile". */
function waitReason(running: Iterable<Slot>) {
  const reasons = new Set([...running].map((slot) => kindReasons[slot.kind]));
  return [...reasons].join(" and ") || "other work in the Blame Runtime";
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

/** The turns of everything that runs in the Blame Runtime. */
export const runtimeHeavyWork = createHeavyWorkQueue({
  availableMemory: () => availableMemory(localDockerHost()),
});
