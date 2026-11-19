import type {
  ProjectPreviewRuntimeState,
  ProjectRunConfiguration,
} from "@blame/agent-runtime";
import type { PreviewManifest } from "@blame/preview-contract";
import type { ServiceState } from "@blame/preview-runtime/compose";
import {
  previewRunConfigurationServiceIds,
  previewRunConfigurationStatus,
  selectedPreviewRunConfiguration,
  type PreviewRuntimeSelectionState,
} from "../../preview-run-state.ts";
import { isGitRepository } from "../../workspace-git.ts";
import { runtimeManagedPath } from "../../workspace-runtime.ts";
import { runRuntimeGit } from "../../workspace-runtime-git.ts";
import {
  LocalPreviewError,
  readLocalPreviewFiles,
  readLocalPreviewManifest,
  type LocalPreviewFiles,
} from "./local-preview-files.ts";
import {
  idleLocalPreviewLifecycle,
  localPreviewLifecycle,
  selectsBrowserPreview,
} from "./local-preview-lifecycle.ts";
import {
  inspectLocalPreview,
  localPreviewUrl,
} from "./local-preview-runner.ts";

// What the app shows of a story's local preview, polled while it is on
// screen: the run configurations with their status and the preview URL.
// One state read asks the runtime for the preview files, the engine's
// project and the containers, three requests in all.

const repositories = new Set<string>();

/** Whether the worktree is a Git repository; it stays one until removed. */
export async function previewWorktreeIsRepository(worktree: string) {
  if (repositories.has(worktree)) return true;
  let repository = false;
  if (!runtimeManagedPath(worktree))
    repository = await isGitRepository(worktree);
  else
    repository = await runRuntimeGit(worktree, [
      "rev-parse",
      "--show-toplevel",
    ]).then(
      () => true,
      () => false,
    );
  if (repository) repositories.add(worktree);
  return repository;
}

export function forgetPreviewWorktree(worktree: string) {
  repositories.delete(worktree);
}

/** The preview URL while the preview should run and its service does. */
export async function localPreviewCurrentUrl(
  worktree: string,
  files?: LocalPreviewFiles,
) {
  if (!(await previewWorktreeIsRepository(worktree))) return undefined;
  const read = files ?? (await readLocalPreviewFiles(worktree));
  if (read.state.desiredStatus === "stopped") return undefined;
  return localPreviewUrl(worktree, await inspectLocalPreview(worktree, read));
}

export async function localPreviewRuntimeState(
  worktree: string,
  input: {
    /** An operation was in flight before the files were read. */
    inFlight: boolean;
    /** Whether the worktree may still serve a preview. */
    served: boolean;
    /** A wake was under way before the files were read. */
    waking: boolean;
  },
): Promise<ProjectPreviewRuntimeState> {
  const files = await readLocalPreviewFiles(worktree);
  const inspection = await inspectLocalPreview(worktree, files);
  const { configurations, state } = files;
  const manifest =
    files.manifest instanceof LocalPreviewError ? undefined : files.manifest;
  const selected = selectedPreviewRunConfiguration(configurations, state);
  const statuses = previewConfigurationStatuses(
    configurations,
    inspection.services.map(previewRuntimeContainerState),
    state,
    manifest,
  );
  const browserPreview = selectsBrowserPreview(
    selected?.previewService,
    manifest,
  );
  const previewUrl =
    input.served &&
    state.desiredStatus === "running" &&
    browserPreview &&
    (await previewWorktreeIsRepository(worktree))
      ? await localPreviewUrl(worktree, inspection)
      : undefined;
  // Woken after the runtime stopped: its containers exited with it, and
  // the wake is starting it again (a paused container counts as running).
  const restarting =
    input.waking && !inspection.services.some(({ running }) => running);
  const lifecycle = localPreviewLifecycle(
    state,
    selected ? statuses[selected.id] : undefined,
    browserPreview,
    previewUrl,
    input.inFlight || restarting,
  );
  return {
    configurations,
    desiredStatus: state.desiredStatus,
    lifecycle,
    ...(previewUrl ? { previewUrl } : {}),
    ...(selected ? { selectedConfigurationId: selected.id } : {}),
    statuses,
  };
}

/** A cloud mirror or Direct story: no managed preview runs for it. */
export async function unmanagedPreviewRuntimeState(
  worktree: string,
): Promise<ProjectPreviewRuntimeState> {
  const { configurations, state } = await readLocalPreviewFiles(worktree);
  const selected = selectedPreviewRunConfiguration(configurations, state);
  return {
    configurations,
    desiredStatus: "stopped",
    lifecycle: idleLocalPreviewLifecycle(state.lifecycle?.since),
    ...(selected ? { selectedConfigurationId: selected.id } : {}),
    statuses: Object.fromEntries(
      configurations.map(({ id }) => [id, "stopped"]),
    ),
  };
}

export async function listLocalPreviewServices(worktree: string) {
  const manifest = await readLocalPreviewManifest(worktree).catch(
    () => undefined,
  );
  return (manifest?.services.map(({ id }) => id) ?? []).sort(serviceSort);
}

function serviceSort(left: string, right: string) {
  return (
    servicePriority(left) - servicePriority(right) || left.localeCompare(right)
  );
}

function servicePriority(service: string) {
  if (/front|web|app/i.test(service)) return 0;
  if (/back|api|server/i.test(service)) return 1;
  if (/migrat/i.test(service)) return 2;
  if (/db|postgres|mysql|mongo|redis/i.test(service)) return 3;
  if (/install|deps|depend|init|volume/i.test(service)) return 4;
  return 5;
}

function previewRuntimeContainerState(service: ServiceState) {
  return {
    exitCode: service.exitCode,
    health: service.health,
    service: service.id,
    status: service.state,
  };
}

function previewConfigurationStatuses(
  configurations: ProjectRunConfiguration[],
  containers: ReturnType<typeof previewRuntimeContainerState>[],
  runtimeState: PreviewRuntimeSelectionState,
  manifest: PreviewManifest | undefined,
) {
  return Object.fromEntries(
    configurations.map((configuration) => [
      configuration.id,
      previewRunConfigurationStatus(
        previewStatusConfiguration(configuration, manifest),
        containers,
        runtimeState,
      ),
    ]),
  );
}

function previewStatusConfiguration(
  configuration: ProjectRunConfiguration,
  manifest: PreviewManifest | undefined,
) {
  if (!manifest) return configuration;
  return {
    ...configuration,
    services: previewRunConfigurationServiceIds(configuration, manifest),
  };
}
