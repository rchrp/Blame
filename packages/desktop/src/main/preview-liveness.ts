// Whether a running local preview still serves, so Blame restarts it only
// when it is down. A dev server that rebuilds after a dependency change can
// miss a request or answer 500 for a while; restarting it then re-runs the
// setup, which fails while the story's lockfile is behind its package.json.

export type PreviewLivenessChecks = {
  /** Whether the preview answered an HTTP request, whatever its status. */
  answers(): Promise<boolean>;
  /** Whether every service of the selected configuration is running. */
  servicesRunning(): Promise<boolean>;
  probesPass(): Promise<boolean>;
};

export class PreviewLiveness {
  private readonly silentSince = new Map<string, number>();
  private readonly probedAt = new Map<string, number>();
  private readonly graceMs: number;
  private readonly probeReuseMs: number;

  constructor(graceMs = 90_000, probeReuseMs = 120_000) {
    this.graceMs = graceMs;
    this.probeReuseMs = probeReuseMs;
  }

  /** Whether the preview of `worktree` should be left as it is. */
  async serving(
    worktree: string,
    checks: PreviewLivenessChecks,
    now = Date.now(),
  ) {
    if (await checks.answers()) {
      this.silentSince.delete(worktree);
      return this.probesPass(worktree, checks, now);
    }
    this.probedAt.delete(worktree);
    if (!(await checks.servicesRunning())) {
      this.silentSince.delete(worktree);
      return false;
    }
    const since = this.silentSince.get(worktree) ?? now;
    this.silentSince.set(worktree, since);
    return now - since < this.graceMs;
  }

  forget(worktree: string) {
    this.silentSince.delete(worktree);
    this.probedAt.delete(worktree);
  }

  // Functional checks run commands in the containers, every 30 s for each
  // active story. While the preview keeps answering, a check that passed a
  // moment ago still holds.
  private async probesPass(
    worktree: string,
    checks: PreviewLivenessChecks,
    now: number,
  ) {
    const probedAt = this.probedAt.get(worktree);
    if (probedAt !== undefined && now - probedAt < this.probeReuseMs)
      return true;
    const passed = await checks.probesPass();
    if (passed) this.probedAt.set(worktree, now);
    else this.probedAt.delete(worktree);
    return passed;
  }
}
