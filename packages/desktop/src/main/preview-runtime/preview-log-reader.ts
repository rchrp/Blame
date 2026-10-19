import type { PreviewHarnessState } from "./preview-harness-state.ts";

type PreviewLogInput = {
  service?: string;
  tailLines?: number;
  timeoutMs?: number;
  workspaceMode?: "local-container" | "cloud-mirror" | "direct";
  worktree: string;
};

type ReadPreviewLogs = (
  input: PreviewLogInput,
) => Promise<Record<string, unknown>>;

export class PreviewLogService {
  private readonly readLogs: ReadPreviewLogs;

  constructor(readLogs: ReadPreviewLogs) {
    this.readLogs = readLogs;
  }

  async read(input: PreviewLogInput, preview: PreviewHarnessState) {
    if (preview.status === "stopped") {
      return {
        available: false,
        message: preview.message,
        preview,
        reason: preview.reason,
        services: [],
      };
    }
    if (input.workspaceMode === "cloud-mirror") {
      return {
        available: false,
        message:
          "Managed preview logs are available through the preview log stream.",
        preview,
        reason: "MANAGED_PREVIEW_LOG_STREAM_REQUIRED",
        services: [],
      };
    }
    const logs = await this.readLogs({ ...input, timeoutMs: 3_000 });
    return { ...logs, preview };
  }
}
