import { localPreviewPaths } from "./preview-runtime/local/local-preview-files.ts";
import {
  appendFile,
  dirnameWorkspacePath,
  mkdir,
} from "./workspace-runtime.ts";
import type { WorktreeActivity } from "./worktree-activity.ts";

/** Batched runtime logs participate in the worktree's removal barrier. */
export class WorktreeLogs {
  private pending = new Map<string, string>();
  private timer?: NodeJS.Timeout;
  private activity: WorktreeActivity;

  constructor(activity: WorktreeActivity) {
    this.activity = activity;
  }

  discard(worktree: string) {
    this.pending.delete(worktree);
  }

  append = (worktree: string, text: string) => {
    if (this.activity.isClosed(worktree)) return;
    this.pending.set(worktree, `${this.pending.get(worktree) ?? ""}${text}`);
    this.timer ??= setTimeout(() => void this.flush(), 300);
  };

  flush = async () => {
    clearTimeout(this.timer);
    this.timer = undefined;
    const pending = [...this.pending];
    this.pending.clear();
    await Promise.all(
      pending.map(([worktree, text]) =>
        this.activity
          .write(worktree, () =>
            appendFile(localPreviewPaths(worktree).setupLog, text),
          )
          .catch(() => undefined),
      ),
    );
  };

  section = (worktree: string, message: string) =>
    this.activity.write(worktree, async () => {
      const { setupLog } = localPreviewPaths(worktree);
      await mkdir(dirnameWorkspacePath(setupLog));
      await appendFile(setupLog, `\n[${message}]\n`);
    });

  recovery = (worktree: string, message: string) =>
    this.section(worktree, `recovery ${message}`);

  timing = async (worktree: string, label: string, duration: number) => {
    try {
      await this.activity.write(worktree, async () => {
        const { setupLog, timingLog } = localPreviewPaths(worktree);
        await mkdir(dirnameWorkspacePath(setupLog));
        await appendFile(
          setupLog,
          `\n[recovery timing ${label}: ${duration}ms]\n`,
        );
        await appendFile(
          timingLog,
          `${JSON.stringify({
            at: new Date().toISOString(),
            durationMs: duration,
            label,
          })}\n`,
        );
      });
    } catch {}
  };
}
