import {
  parsePreviewManifest,
  parseRunConfigurations,
  type PreviewManifest,
  type ProjectInitializationDatabaseMode,
  type ProjectRunConfiguration,
} from "@blame/agent-runtime";
import {
  compilePreviewManifest,
  type PreviewExecutionPlan,
  type PreviewServing,
} from "@blame/preview-runtime";
import {
  initialPreviewRuntimeSelection,
  type PreviewRuntimeSelectionState,
} from "../../preview-run-state.ts";
import {
  dirnameWorkspacePath,
  joinWorkspacePath,
  mkdir,
  readExistingFiles,
  rm,
  writeFile,
  writeFileAtomic,
} from "../../workspace-runtime.ts";
import { parseLocalPreviewRuntimeSelectionState } from "./local-preview-lifecycle.ts";

// The files a story worktree keeps for its local preview, under `.blame`:
// the manifest and run configurations Blame initialized, the selected run
// configuration with its lifecycle, and the engine's own state.

export type LocalPreviewErrorCode =
  | "preview_configuration_host_only"
  | "preview_container_stopped"
  | "preview_dependency_timeout"
  | "preview_environment_missing"
  | "preview_manifest_invalid"
  | "preview_probe_failed"
  | "preview_response_timeout"
  | "preview_setup_stale"
  | "preview_url_timeout";

export class LocalPreviewError extends Error {
  readonly code: LocalPreviewErrorCode;

  constructor(code: LocalPreviewErrorCode, message: string) {
    super(message);
    this.name = "PreviewRuntimeError";
    this.code = code;
  }
}

export function localPreviewPaths(worktree: string) {
  const initialization = joinWorkspacePath(
    worktree,
    ".blame",
    "initialization",
  );
  return {
    manifest: joinWorkspacePath(initialization, "preview-manifest.json"),
    runConfigurations: joinWorkspacePath(
      initialization,
      "run-configurations.json",
    ),
    runtimeState: joinWorkspacePath(
      initialization,
      "preview-runtime-state.json",
    ),
    environment: joinWorkspacePath(initialization, "preview-environment.json"),
    engineState: joinWorkspacePath(worktree, ".blame", "preview"),
    setupLog: joinWorkspacePath(worktree, ".blame", "logs", "setup.log"),
    timingLog: joinWorkspacePath(worktree, ".blame", "logs", "timing.jsonl"),
  };
}

export async function writeLocalPreviewInitialization(
  worktree: string,
  manifest: PreviewManifest,
  runConfigurations: ProjectRunConfiguration[],
  runConfigurationId?: string | null,
  databaseMode?: ProjectInitializationDatabaseMode | null,
) {
  const paths = localPreviewPaths(worktree);
  const initialization = dirnameWorkspacePath(paths.manifest);
  // Native/cloud worktrees start without .blame; native writes need their parent.
  await mkdir(initialization);
  await mkdir(dirnameWorkspacePath(paths.setupLog));
  await writeFile(paths.setupLog, "");
  await writeFileAtomic(
    paths.manifest,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFileAtomic(
    paths.runConfigurations,
    `${JSON.stringify(runConfigurations, null, 2)}\n`,
  );
  await writeLocalRuntimeState(
    worktree,
    initialPreviewRuntimeSelection(runConfigurations, runConfigurationId),
  );
  // The database mode chosen for the project; without it, the env layer
  // reads it from the manifest.
  if (databaseMode)
    await writeFileAtomic(
      paths.environment,
      `${JSON.stringify({ databaseMode })}\n`,
    );
  // Files of the previous local engine.
  await Promise.all(
    ["docker-compose.yml", "setup.sh"].map((file) =>
      rm(joinWorkspacePath(initialization, file)).catch(() => undefined),
    ),
  );
}

/** The database mode saved with the story's setup, if any. */
export async function readLocalDatabaseMode(
  worktree: string,
): Promise<ProjectInitializationDatabaseMode | undefined> {
  const path = localPreviewPaths(worktree).environment;
  try {
    const value = JSON.parse((await readExistingFiles([path]))[path] ?? "") as {
      databaseMode?: unknown;
    };
    return value.databaseMode === "compose" || value.databaseMode === "existing"
      ? value.databaseMode
      : undefined;
  } catch {
    return undefined;
  }
}

export type LocalPreviewFiles = {
  configurations: ProjectRunConfiguration[];
  /** Missing until Blame initialized the preview; invalid is an error. */
  manifest: PreviewManifest | LocalPreviewError | undefined;
  state: PreviewRuntimeSelectionState;
};

/**
 * The manifest, run configurations and runtime state of a worktree, read
 * together: the runtime agent reads them in one request, without starting
 * a program. They are read again each time, since the agent's commands and
 * setup scripts can change them too.
 */
export async function readLocalPreviewFiles(
  worktree: string,
): Promise<LocalPreviewFiles> {
  const paths = localPreviewPaths(worktree);
  const files = await readExistingFiles([
    paths.manifest,
    paths.runConfigurations,
    paths.runtimeState,
  ]);
  return {
    configurations: parseLocalRunConfigurations(files[paths.runConfigurations]),
    manifest: parseLocalPreviewManifest(files[paths.manifest]),
    state: parseLocalRuntimeState(files[paths.runtimeState]),
  };
}

/** The manifest of `files`, which throws when it is invalid. */
export function localPreviewManifest(files: LocalPreviewFiles) {
  if (files.manifest instanceof LocalPreviewError) throw files.manifest;
  return files.manifest;
}

export async function readLocalPreviewManifest(worktree: string) {
  const path = localPreviewPaths(worktree).manifest;
  const manifest = parseLocalPreviewManifest(
    (await readExistingFiles([path]))[path],
  );
  if (manifest instanceof LocalPreviewError) throw manifest;
  return manifest;
}

export async function readLocalRunConfigurations(worktree: string) {
  const path = localPreviewPaths(worktree).runConfigurations;
  return parseLocalRunConfigurations((await readExistingFiles([path]))[path]);
}

export async function readLocalRuntimeState(worktree: string) {
  const path = localPreviewPaths(worktree).runtimeState;
  return parseLocalRuntimeState((await readExistingFiles([path]))[path]);
}

function parseLocalPreviewManifest(text: string | null | undefined) {
  if (typeof text !== "string") return undefined;
  try {
    return parsePreviewManifest(JSON.parse(text));
  } catch (error) {
    return new LocalPreviewError(
      "preview_manifest_invalid",
      `Persisted preview manifest is invalid: ${errorText(error)}`,
    );
  }
}

function parseLocalRunConfigurations(
  text: string | null | undefined,
): ProjectRunConfiguration[] {
  if (typeof text !== "string") return [];
  return parseRunConfigurations(JSON.parse(text));
}

function parseLocalRuntimeState(
  text: string | null | undefined,
): PreviewRuntimeSelectionState {
  if (typeof text !== "string") return { desiredStatus: "stopped" };
  try {
    return parseLocalPreviewRuntimeSelectionState(JSON.parse(text));
  } catch {
    return { desiredStatus: "stopped" };
  }
}

export function writeLocalRuntimeState(
  worktree: string,
  state: PreviewRuntimeSelectionState,
) {
  return writeFileAtomic(
    localPreviewPaths(worktree).runtimeState,
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

// Local previews read the manifest through the same compiler as cloud
// previews, so both accept, refuse and run a manifest the same way.
export function compileLocalPreviewPlan(
  manifest: PreviewManifest,
  serving?: PreviewServing,
): PreviewExecutionPlan {
  try {
    return compilePreviewManifest(
      manifest,
      serving === "production" ? { serving } : {},
    );
  } catch (error) {
    throw new LocalPreviewError(
      "preview_manifest_invalid",
      `Preview manifest is invalid: ${errorText(error)}`,
    );
  }
}

export function errorText(error: unknown) {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unknown error";
}
