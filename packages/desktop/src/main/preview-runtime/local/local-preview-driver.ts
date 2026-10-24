import {
  resolveCapabilities,
  runtimeHandle,
  type EndpointMap,
  type ExecInput,
  type ExecResult,
  type LogRequest,
  type PreviewExecutionPlan,
  type PreviewLogEvent,
  type PreviewRuntimeDriver,
  type ProvisionInput,
  type RuntimeHandle,
  type RuntimeObservation,
  type RuntimeSelection,
} from "@blame/preview-runtime";
import type { ServiceState } from "@blame/preview-runtime/compose";
import type { ProjectPreviewRuntimeState } from "@blame/agent-runtime";
import {
  joinWorkspacePath,
  resolveWorkspacePath,
  run,
} from "../../workspace-runtime.ts";
import {
  localPreviewEndpoints,
  localPreviewLogs,
  localPreviewServices,
} from "./local-preview-runner.ts";

// The Local Container profile behind the provider-neutral driver contract.
// The Blame Runtime is a long-lived host shared by every story, and the
// worktree is attached at /workspace, so provisioning, synchronization and
// exports are immediate; starting, stopping, inspection, endpoints and logs
// go to the story's Compose project on the shared engine.

type LocalHandle = {
  kind: "local-container";
  sessionId: string;
  worktree: string;
};

export type LocalRuntimeAdapter = {
  control(input: {
    action: "start" | "stop" | "restart";
    configurationId?: string;
    worktree: string;
  }): Promise<ProjectPreviewRuntimeState>;
  state(worktree: string): Promise<ProjectPreviewRuntimeState>;
  services(worktree: string): Promise<ServiceState[]>;
  endpoints(worktree: string): ReturnType<typeof localPreviewEndpoints>;
  logs(
    worktree: string,
    serviceId?: string,
  ): Promise<{ stdout: string; stderr: string } | undefined>;
  exec(cwd: string, input: ExecInput): Promise<ExecResult>;
};

const defaultAdapter: LocalRuntimeAdapter = {
  // Start and stop go through the IPC module, which records the lifecycle.
  control: (input) =>
    import("../../workspace-ipc.ts").then(({ controlProjectPreview }) =>
      controlProjectPreview(input),
    ),
  state: (worktree) =>
    import("../../workspace-ipc.ts").then(({ projectPreviewRuntimeState }) =>
      projectPreviewRuntimeState(worktree),
    ),
  services: localPreviewServices,
  endpoints: localPreviewEndpoints,
  logs: (worktree, serviceId) => localPreviewLogs(worktree, serviceId),
  exec: runInWorkspace,
};

export class LocalPreviewDriver implements PreviewRuntimeDriver {
  readonly profile = "local-container" as const;
  private readonly worktreeForStory: (userStoryId: string) => Promise<string>;
  private readonly adapter: LocalRuntimeAdapter;

  constructor(
    worktreeForStory: (userStoryId: string) => Promise<string>,
    adapter: LocalRuntimeAdapter = defaultAdapter,
  ) {
    this.worktreeForStory = worktreeForStory;
    this.adapter = adapter;
  }

  async capabilities(plan: PreviewExecutionPlan) {
    return resolveCapabilities(this.profile, plan);
  }

  async provisionHost(input: ProvisionInput) {
    return {
      handle: await this.connect(
        await this.worktreeForStory(input.userStoryId),
        input.sessionId,
      ),
    };
  }

  async connect(worktree: string, sessionId = worktree) {
    return runtimeHandle({
      kind: "local-container",
      sessionId,
      worktree: resolveWorkspacePath(worktree),
    } satisfies LocalHandle);
  }

  runtimeState(handle: RuntimeHandle) {
    return this.adapter.state(localHandle(handle).worktree);
  }

  async resumeHost(_handle: RuntimeHandle) {}

  async syncIn(
    _handle: RuntimeHandle,
    source: import("@blame/preview-runtime").SourceArtifact,
  ) {
    return { sourceRevision: source.revision, workspaceHash: source.sha256 };
  }

  // A start renders and prepares the project itself.
  async prepareEngine(_handle: RuntimeHandle, _plan: PreviewExecutionPlan) {}

  async startServices(handle: RuntimeHandle, selection: RuntimeSelection) {
    await this.adapter.control({
      action: "start",
      configurationId: selection.configurationId,
      worktree: localHandle(handle).worktree,
    });
  }

  async stopServices(handle: RuntimeHandle) {
    await this.adapter.control({
      action: "stop",
      worktree: localHandle(handle).worktree,
    });
  }

  exec(handle: RuntimeHandle, input: ExecInput) {
    const root = localHandle(handle).worktree;
    const cwd = input.cwd
      ? joinWorkspacePath(root, input.cwd.replace(/^\/workspace\/?/, ""))
      : root;
    if (cwd !== root && !cwd.startsWith(`${root}/`))
      throw new Error("Command escapes the local worktree");
    return this.adapter.exec(cwd, input);
  }

  async inspect(handle: RuntimeHandle): Promise<RuntimeObservation> {
    const services = await this.adapter.services(localHandle(handle).worktree);
    return {
      host: "running",
      engine: services.some(({ running }) => running) ? "running" : "stopped",
      services: services.map(({ id, running, healthy }) => ({
        id,
        running,
        healthy: running && healthy !== false,
      })),
    };
  }

  async endpoints(handle: RuntimeHandle): Promise<EndpointMap> {
    const { sessionId, worktree } = localHandle(handle);
    const { routes, primary } = await this.adapter.endpoints(worktree);
    const mapped = routes.map((route) => ({
      routeId: `${sessionId}:${route.serviceId}:${route.endpointId}`,
      serviceId: route.serviceId,
      endpointId: route.endpointId,
      protocol: route.protocol,
      logicalHost: "localhost" as const,
      logicalPort: route.port,
      targetHost: "127.0.0.1",
      targetPort: route.port,
      sandboxPort: route.port,
      publicUrl: `${route.protocol}://localhost:${route.port}/`,
      basePathMode: "root" as const,
      externallyCompatible: true,
    }));
    const primaryRoute =
      mapped.find(
        ({ serviceId, endpointId }) =>
          serviceId === primary?.serviceId &&
          endpointId === primary?.endpoint.id,
      ) ?? mapped[0];
    return {
      revision: 1,
      primaryRouteId: primaryRoute?.routeId ?? "",
      primaryPublicUrl: primaryRoute?.publicUrl ?? "",
      routes: mapped,
      supportsWebSocket: true,
      integratedPreviewRequired: false,
      incompatibilityReasons: [],
    };
  }

  async *logs(input: LogRequest): AsyncIterable<PreviewLogEvent> {
    const handle = localHandle(input.handle);
    const snapshot = await this.adapter.logs(handle.worktree, input.serviceId);
    if (!snapshot) return;
    yield {
      sessionId: handle.sessionId,
      sequence: 1,
      timestamp: new Date().toISOString(),
      state: {
        host: "running",
        engine: "running",
        preview: "ready",
        agent: "idle",
        sync: "clean",
      },
      serviceId: input.serviceId,
      stream: "stdout",
      message: `${snapshot.stdout}${snapshot.stderr}`,
    };
  }

  // The worktree is the workspace: there is no delta to export.
  async exportDelta(_handle: RuntimeHandle, revision: string) {
    return {
      artifactId: `local:${revision}`,
      baseHash: revision,
      finalHash: revision,
      generation: 0,
      revision,
      durableAt: new Date().toISOString(),
    };
  }

  async suspendHost(handle: RuntimeHandle) {
    await this.stopServices(handle);
    return { suspendedAt: new Date().toISOString() };
  }

  async destroyHost(handle: RuntimeHandle) {
    await this.stopServices(handle);
    return { destroyedAt: new Date().toISOString(), pendingCleanupIds: [] };
  }

  async usage(_handle: RuntimeHandle) {
    return {
      activeCpuSeconds: 0,
      memoryGbSeconds: 0,
      ingressBytes: 0,
      egressBytes: 0,
      snapshotBytes: 0,
      estimatedCostUsd: 0,
      observedAt: new Date().toISOString(),
    };
  }
}

function localHandle(handle: RuntimeHandle) {
  const value = handle as unknown as LocalHandle;
  if (value.kind !== "local-container" || !value.worktree)
    throw new Error("Invalid local runtime handle");
  return value;
}

// Commands run where the worktree lives: in the Blame Runtime, as its user.
async function runInWorkspace(cwd: string, input: ExecInput) {
  try {
    const result = await run(input.command, input.args ?? [], {
      cwd,
      env: { ...process.env, ...(input.environment ?? {}) },
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      message?: string;
    };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
      stderr:
        typeof failure.stderr === "string"
          ? failure.stderr
          : (failure.message ?? ""),
    };
  }
}
