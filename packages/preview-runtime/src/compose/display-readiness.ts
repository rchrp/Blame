import type { PreviewExecutionPlan } from "../domain/execution-plan.js";
import { ComposeEngineError, type CommandResult } from "./docker-host.js";

export async function waitForDisplayWindows(
  plan: PreviewExecutionPlan,
  selected: string[],
  exec: (id: string, args: string[]) => Promise<CommandResult>,
  options: { timeoutMs?: number; log?: (message: string) => void } = {},
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
