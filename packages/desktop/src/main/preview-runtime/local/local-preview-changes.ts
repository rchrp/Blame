// The changes the desktop makes to a local preview, its state written or
// an operation settled, so the app reads the state again right away
// instead of polling for them.

type Listener = (worktree: string) => void;

const listeners = new Set<Listener>();

export function onLocalPreviewChange(listener: Listener) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function localPreviewChanged(worktree: string) {
  for (const listener of listeners) listener(worktree);
}
