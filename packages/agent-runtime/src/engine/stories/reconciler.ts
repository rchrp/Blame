// When each story's reconcile runs: at most one pending per story (asked
// again while it runs, it runs once more after), and after a failure (the
// API or the engine did not answer) again later, each time later, up to ten
// minutes. A success starts the count over.

const firstRetryMs = 15_000;
const lastRetryMs = 10 * 60_000;

type Pending = {
  running: boolean;
  again: boolean;
  failures: number;
  timer?: ReturnType<typeof setTimeout>;
};

export class ReconcileScheduler {
  private readonly pending = new Map<string, Pending>();
  private readonly run: (storyId: string) => Promise<void>;
  private readonly retryMs: (failures: number) => number;
  private stopped = false;

  constructor(
    run: (storyId: string) => Promise<void>,
    retryMs = (failures: number) =>
      Math.min(lastRetryMs, firstRetryMs * 2 ** (failures - 1)),
  ) {
    this.run = run;
    this.retryMs = retryMs;
  }

  /** Reconciles the story soon: now, or when the one running ends, or at its retry. */
  ask(storyId: string) {
    if (this.stopped) return;
    const pending = this.pending.get(storyId);
    if (pending?.running) {
      pending.again = true;
      return;
    }
    // Waiting for its retry after a failure: the retry is the next look.
    if (pending?.timer) return;
    void this.start(storyId, pending?.failures ?? 0);
  }

  private async start(storyId: string, failures: number) {
    const pending: Pending = { running: true, again: false, failures };
    this.pending.set(storyId, pending);
    let failed = false;
    try {
      await this.run(storyId);
    } catch (error) {
      failed = true;
      console.error(
        "Story service: a story could not be settled now:",
        error instanceof Error ? error.message : String(error),
      );
    }
    pending.running = false;
    if (this.stopped) return;
    if (failed) {
      pending.failures += 1;
      pending.timer = setTimeout(() => {
        pending.timer = undefined;
        void this.start(storyId, pending.failures);
      }, this.retryMs(pending.failures));
      pending.timer.unref?.();
      return;
    }
    if (pending.again) {
      void this.start(storyId, 0);
      return;
    }
    this.pending.delete(storyId);
  }

  stop() {
    this.stopped = true;
    for (const pending of this.pending.values())
      if (pending.timer) clearTimeout(pending.timer);
    this.pending.clear();
  }
}
