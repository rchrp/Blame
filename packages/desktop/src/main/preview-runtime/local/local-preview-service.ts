import type { ProjectPreviewRuntimeState } from "@blame/agent-runtime";
import { LocalPreviewDriver } from "./local-preview-driver";
import { trackLocalPreviewOperation } from "./local-preview-lifecycle.ts";
import { resolveWorkspacePath } from "../../workspace-runtime.ts";

export type LocalPreviewControlInput = {
  action: "start" | "stop" | "restart";
  configurationId?: string;
  worktree: string;
};

export class LocalPreviewService {
  private readonly driver = new LocalPreviewDriver(
    async (worktree) => worktree,
  );

  async control(
    input: LocalPreviewControlInput,
  ): Promise<ProjectPreviewRuntimeState> {
    const handle = await this.driver.connect(input.worktree);
    // A restart is one operation: no reading sees it between stop and
    // start, and the state returned is read once it settled.
    await trackLocalPreviewOperation(resolveWorkspacePath(input.worktree), () =>
      this.controlNow(input, handle),
    );
    return this.driver.runtimeState(handle);
  }

  private async controlNow(
    input: LocalPreviewControlInput,
    handle: Awaited<ReturnType<LocalPreviewDriver["connect"]>>,
  ) {
    const current = await this.driver.runtimeState(handle);
    const configurationId =
      input.configurationId ?? current.selectedConfigurationId;
    if (input.action === "stop" || input.action === "restart") {
      await this.driver.stopServices(handle);
    }
    if (input.action === "start" || input.action === "restart") {
      if (!configurationId)
        throw new Error("Preview run configuration not found");
      await this.driver.startServices(handle, { configurationId });
    }
  }
}
