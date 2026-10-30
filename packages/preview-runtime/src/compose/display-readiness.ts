import type { PreviewExecutionPlan } from "../domain/execution-plan.js";
import { ComposeEngineError, type CommandResult } from "./docker-host.js";

export async function waitForDisplayWindows(
  plan: PreviewExecutionPlan,
  selected: string[],
  exec: (id: string, args: string[]) => Promise<CommandResult>,
  options: {
    timeoutMs?: number;
    log?: (message: string) => void;
    // Why the app container stopped, or nothing while it runs.
    stopped?: (id: string) => Promise<string | undefined>;
  } = {},
) {
  for (const service of plan.services) {
    if (
      !selected.includes(service.id) ||
      service.surface?.type !== "display" ||
      service.id === service.surface.sidecarServiceId
    )
      continue;
    options.log?.("Waiting for the app window\n");
    const deadline = Date.now() + (options.timeoutMs ?? 90000);
    let ready = false;
    do {
      const result = await exec(service.surface.sidecarServiceId, [
        "blame-display",
        "windows",
      ]);
      try {
        const windows: unknown = JSON.parse(result.stdout);
        ready =
          result.exitCode === 0 && Array.isArray(windows) && windows.length > 0;
      } catch {
        /* Retry while the window manager starts. */
      }
      if (ready) break;
      // An app that already exited will never open a window.
      const stopped = await options.stopped?.(service.id);
      if (stopped)
        throw new ComposeEngineError(
          "DISPLAY_APP_EXITED",
          `The app stopped before opening a window (${stopped}). Open its Run logs, fix the startup error and try again.`,
        );
      if (Date.now() < deadline)
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(1000, deadline - Date.now())),
        );
    } while (Date.now() < deadline);
    if (!ready)
      throw new ComposeEngineError(
        "DISPLAY_WINDOW_TIMEOUT",
        "The app started but opened no window. Open the app logs, fix the startup error and try again.",
      );
  }
}
