// What the desktop's live sync of a cloud preview is doing, for the preview
// toolbar. `sequence` grows with each synchronization that changed files, so
// a viewer can react to new content (for example reload a page without hot
// reload).
export type LiveSyncState =
  | "idle"
  | "syncing"
  | "synced"
  | "waiting"
  | "restarting"
  | "error";

export type LiveSyncStatus = {
  state: LiveSyncState;
  /** When the state last changed. */
  updatedAt: string;
  /** When files last reached the cloud preview. */
  syncedAt?: string;
  changedFiles?: number;
  reason?: string;
  sequence: number;
};
