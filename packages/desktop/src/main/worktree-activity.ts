/** Prevents background preparation and delayed writes from resurrecting a
 * worktree after removal. Only an explicit workspace creation reopens it. */
export class WorktreeActivity {
  private closed = new Set<string>();
  private active = new Map<string, Set<Promise<unknown>>>();

  isClosed(worktree: string) {
    return this.closed.has(worktree);
  }

  open(worktree: string) {
    if (this.active.get(worktree)?.size)
      throw new Error("Workspace operations are still finishing.");
    this.closed.delete(worktree);
  }

  async run<T>(worktree: string, action: () => Promise<T>): Promise<T> {
    if (this.isClosed(worktree))
      throw new Error("The workspace is being removed or has been removed.");
    const pending = Promise.resolve().then(action);
    const active = this.active.get(worktree) ?? new Set<Promise<unknown>>();
    this.active.set(worktree, active);
    active.add(pending);
    try {
      return await pending;
    } finally {
      active.delete(pending);
      if (!active.size) this.active.delete(worktree);
    }
  }

  async write(worktree: string, action: () => Promise<void>) {
    if (this.isClosed(worktree)) return;
    await this.run(worktree, action);
  }

  async close(worktree: string) {
    this.closed.add(worktree);
    await Promise.allSettled([...(this.active.get(worktree) ?? [])]);
  }
}
