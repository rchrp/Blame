// A dev server compiles at its first request, and a cold compile is the
// memory peak of a preview: measured on Next.js 16.4 Turbopack in a 4 GiB
// Blame Runtime (2026-11-15), one cold start peaks at 3.1 GiB while it
// writes its cache, a seeded one at 1.6 GiB, and three cold starts at once
// pushed 3 GiB into swap and cost half as much CPU again. Starts that
// compile take turns: one runs whenever none does, and another joins only
// while the Runtime's available memory covers every running estimate plus
// its own. Warm restarts never wait here.

export type CompileStartKind = "cold" | "seeded";

const gib = 1024 * 1024 * 1024;

/** Expected memory peak of a compiling start, from the measurements above. */
export const compileStartEstimates: Record<CompileStartKind, number> = {
  cold: 3 * gib,
  seeded: 1.5 * gib,
};

export type CompileQueueOptions = {
  /** Available memory of the Docker host in bytes, when it can be read. */
  availableMemory: () => Promise<number | undefined>;
  estimates?: Record<CompileStartKind, number>;
  /** How often waiting starts check memory again while others compile. */
  recheckMs?: number;
};

type Slot = { kind: CompileStartKind; estimate: number };
type Waiter = Slot & { admit: () => void };

export type CompileQueue = ReturnType<typeof createCompileQueue>;

export function createCompileQueue(options: CompileQueueOptions) {
  const estimates = options.estimates ?? compileStartEstimates;
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

  // Admits waiting starts in order; the first one that does not fit makes
  // the others wait too, so a cold start is not passed by seeded ones.
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

  /**
   * Waits for a turn to compile. Returns the function that ends the turn;
   * calling it again does nothing.
   */
  async function enter(kind: CompileStartKind, onWait?: () => void) {
    const slot: Slot = { kind, estimate: estimates[kind] };
    // Alone, a start never reads memory nor waits.
    if (!running.size && !waiting.length) {
      running.add(slot);
      return leave(slot);
    }
    let waiter!: Waiter;
    const admitted = new Promise<void>((admit) => {
      waiter = Object.assign(slot, { admit });
      waiting.push(waiter);
    });
    // Says so only when the memory check keeps it waiting.
    void check().then(() => {
      if (waiting.includes(waiter)) onWait?.();
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
    /** Running and waiting starts, for tests and the timing log. */
    get state() {
      return { running: running.size, waiting: waiting.length };
    },
  };
}
