import {
  parsePreviewManifest,
  parseRunConfigurations,
  type PreviewManifest,
  type ProjectRunConfiguration,
} from "@blame/agent-runtime";
import {
  compilePreviewManifest,
  type PreviewExecutionPlan,
} from "@blame/preview-runtime";
import {
  initialPreviewRuntimeSelection,
  type PreviewRuntimeSelectionState,
} from "../../preview-run-state.ts";
import {
  dirnameWorkspacePath,
  joinWorkspacePath,
  mkdir,
  pathExists,
  readFile,
  rm,
  writeFile,
  writeFileAtomic,
} from "../../workspace-runtime.ts";
import { parseLocalPreviewRuntimeSelectionState } from "./local-preview-lifecycle.ts";

// The files a story worktree keeps for its local preview, under `.blame`:
// the manifest and run configurations Blame initialized, the selected run
// configuration with its lifecycle, and the engine's own state.

export type LocalPreviewErrorCode =
  | "preview_container_stopped"
  | "preview_dependency_timeout"
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
  // Files of the previous local engine.
  await Promise.all(
    ["docker-compose.yml", "setup.sh"].map((file) =>
      rm(joinWorkspacePath(initialization, file)).catch(() => undefined),
    ),
  );
}

export async function readLocalPreviewManifest(worktree: string) {
  const path = localPreviewPaths(worktree).manifest;
  if (!(await pathExists(path))) return undefined;
  try {
    return parsePreviewManifest(JSON.parse(await readFile(path)));
  } catch (error) {
    throw new LocalPreviewError(
      "preview_manifest_invalid",
      `Persisted preview manifest is invalid: ${errorText(error)}`,
    );
  }
}

export async function readLocalRunConfigurations(
  worktree: string,
): Promise<ProjectRunConfiguration[]> {
  const path = localPreviewPaths(worktree).runConfigurations;
  if (!(await pathExists(path))) return [];
  return parseRunConfigurations(JSON.parse(await readFile(path)));
}

export async function readLocalRuntimeState(
  worktree: string,
): Promise<PreviewRuntimeSelectionState> {
  const path = localPreviewPaths(worktree).runtimeState;
  if (!(await pathExists(path))) return { desiredStatus: "stopped" };
  try {
    return parseLocalPreviewRuntimeSelectionState(
      JSON.parse(await readFile(path)),
    );
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
): PreviewExecutionPlan {
  try {
    return compilePreviewManifest(manifest);
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
