// The desktop services the client tools use: what only the main process has
// (the preview's browser and containers, the screenshot store, the component
// preview server, the session's GitHub token, the project runner). The
// engine host asks for them with `desktop-request` messages; the main
// process answers them in `packages/desktop/src/main/engine/engine-desktop-services.ts`.
// Each service takes one JSON input and the call's signal: an aborted call
// sends `desktop-cancel`, and the main process aborts its work.

import type { EngineCommand } from "@blame/engine-client";
import type { ApplyPreviewInitializationInput } from "../types.js";
import type { RenderWebPage } from "../web-research-types.js";
import type {
  ComponentPreviewHostInput,
  GithubMcpCallInput,
  GithubMcpToolDescriptor,
  PreviewContainerLogsInput,
  PreviewDependencyRefreshResult,
  PreviewDevtoolsCallInput,
  PreviewDevtoolsProviderInput,
  PreviewDevtoolsTarget,
  PreviewDevtoolsTargetInput,
  PreviewDevtoolsToolDescriptor,
  PreviewEnvironmentToolInput,
  PreviewEnvironmentToolResult,
  PreviewRuntimeContext,
  PreviewScreenshotKnownInput,
  PreviewSurfaceCallInput,
  PreviewSurfaceInfo,
  ProjectAppInput,
} from "./tools/preview-types.js";

/** The services, as the tools call them: the signal travels in the input. */
export type DesktopServices = {
  renderWebPage?: RenderWebPage;
  previewDevtools?(
    input: PreviewDevtoolsTargetInput,
  ): Promise<PreviewDevtoolsTarget | undefined>;
  previewDevtoolsTools?(
    input: PreviewDevtoolsProviderInput,
  ): Promise<readonly PreviewDevtoolsToolDescriptor[]>;
  previewDevtoolsCall?(input: PreviewDevtoolsCallInput): Promise<unknown>;
  previewContainerLogs?(input: PreviewContainerLogsInput): Promise<unknown>;
  previewEnvironment?(
    input: PreviewEnvironmentToolInput,
  ): Promise<PreviewEnvironmentToolResult>;
  previewSurfaceInfo?(
    input: PreviewRuntimeContext,
  ): Promise<PreviewSurfaceInfo | undefined>;
  previewSurfaceCall?(input: PreviewSurfaceCallInput): Promise<unknown>;
  // Whether a stored screenshot belongs to this conversation.
  previewScreenshotKnown?(input: PreviewScreenshotKnownInput): Promise<boolean>;
  // The project's own app, run by Blame's shared project runner.
  projectApp?(input: ProjectAppInput): Promise<unknown>;
  // Renders a component preview, or stops the worktree's preview server.
  componentPreview?(input: ComponentPreviewHostInput): Promise<unknown>;
  // Whether the workspace holds a project the component preview renders
  // (Vite, React, Vue 3, Nuxt 3+, Svelte 5, Angular); when it does, Git
  // ignores the temporary preview files from then on.
  prepareComponentPreview?(input: {
    worktree: string;
    signal?: AbortSignal;
  }): Promise<boolean>;
  githubMcpTools?(input: {
    sessionId: string;
  }): Promise<readonly GithubMcpToolDescriptor[]>;
  githubMcpCall?(input: GithubMcpCallInput): Promise<unknown>;
  // Opens a sign-in page in the person's browser: ChatGPT's, or an MCP
  // server's (`mcpAuthorization`).
  openExternal?(input: {
    url: string;
    mcpAuthorization?: boolean;
    signal?: AbortSignal;
  }): Promise<null>;
  // Git on the computer that holds the worktree (the runtime VM's included).
  git?(input: { cwd: string; args: string[] }): Promise<string>;
  // Applies a repaired preview setup to a story's managed preview.
  applyPreviewInitialization?(
    input: ApplyPreviewInitializationInput & {
      workspaceMode?: PreviewRuntimeContext["workspaceMode"];
    },
  ): Promise<{ status: "applied" | "unavailable" }>;
  // The GitHub credentials of a session's next harness command: a cloud
  // session's token, or for a story in the runtime VM the token granted for
  // writing (empty, so no inherited token reaches it); `null` keeps the
  // harness's environment.
  commandCredentials?(input: {
    sessionId: string;
    location: "host" | "vm";
  }): Promise<{ githubToken?: string } | null>;
  // A dependency change reaches the session's preview: the preview runtime
  // installs it (a cloud preview syncs first), then its state.
  refreshPreviewDependencies?(
    input: PreviewRuntimeContext,
  ): Promise<PreviewDependencyRefreshResult>;
  // Starts the runtime VM if needed and installs the engine there when it
  // is missing or not this app's; gives the command that serves it over
  // stdio (`limactl shell`, `wsl.exe`).
  prepareVmEngine?(input: Record<string, never>): Promise<EngineCommand>;
};

export type DesktopServiceName = keyof DesktopServices;

type Service<M extends DesktopServiceName> = NonNullable<DesktopServices[M]>;

/** Each service's JSON input and result on the port, for the main process. */
export type DesktopServiceMethods = {
  [M in DesktopServiceName]: {
    input: Omit<Parameters<Service<M>>[0], "signal">;
    result: Awaited<ReturnType<Service<M>>>;
  };
};

export const desktopServiceNames = [
  "renderWebPage",
  "previewDevtools",
  "previewDevtoolsTools",
  "previewDevtoolsCall",
  "previewContainerLogs",
  "previewEnvironment",
  "previewSurfaceInfo",
  "previewSurfaceCall",
  "previewScreenshotKnown",
  "projectApp",
  "componentPreview",
  "prepareComponentPreview",
  "githubMcpTools",
  "githubMcpCall",
  "git",
  "openExternal",
  "applyPreviewInitialization",
  "prepareVmEngine",
  "commandCredentials",
  "refreshPreviewDependencies",
] as const satisfies readonly DesktopServiceName[];

export type DesktopRequest = (
  method: DesktopServiceName,
  input: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;

/** Every service, each one a request to the main process. */
export function desktopServices(request: DesktopRequest): DesktopServices {
  return Object.fromEntries(
    desktopServiceNames.map((method) => [
      method,
      (input: { signal?: AbortSignal }) => {
        const { signal, ...rest } = input ?? {};
        return request(method, rest, signal);
      },
    ]),
  ) as DesktopServices;
}
