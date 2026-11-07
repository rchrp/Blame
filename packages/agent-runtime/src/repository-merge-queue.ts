import { resolve } from "node:path";

const tails = new Map<string, Promise<unknown>>();

// Merges into one repository run one at a time. Each one reads the target
// branch, merges it into its story and fast-forwards the target: run together,
// the second starts from a stale target and cannot fast-forward, and both use
// the same checkout (or temporary integration worktree) at once.
export function runRepositoryMerge<T>(
  repositoryRoot: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = resolve(repositoryRoot);
  const next = (tails.get(key) ?? Promise.resolve()).then(task, task);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return next;
}
