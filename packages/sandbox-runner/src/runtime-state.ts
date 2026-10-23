import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  previewEnvironmentValueRejection,
  type PreviewExecutionPlan,
  type RuntimeSelection,
} from "@blame/preview-runtime";
import { runtimePaths } from "./runtime-paths.js";

export type RunnerRuntimeState = {
  plan?: PreviewExecutionPlan;
  prepared: boolean;
  running: boolean;
  endpointRevision: number;
  browserBindingUrls: Record<string, string>;
  routeIds: Record<string, string>;
  sessionId: string;
  generation: number;
  selection?: RuntimeSelection;
  // endpointRevision whose functional probes passed.
  probedEndpointRevision?: number;
};

export async function readRuntimeState(): Promise<RunnerRuntimeState> {
  try {
    return JSON.parse(
      await readFile(runtimePaths.runtimeState, "utf8"),
    ) as RunnerRuntimeState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return initialRuntimeState();
  }
}

export async function writeRuntimeState(state: RunnerRuntimeState) {
  assertRuntimeStateSnapshotSafe(state);
  await mkdir(dirname(runtimePaths.runtimeState), {
    recursive: true,
    mode: 0o700,
  });
  const temporary = `${runtimePaths.runtimeState}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state), {
    mode: 0o600,
    flush: true,
  });
  await rename(temporary, runtimePaths.runtimeState);
}

export function assertRuntimeStateSnapshotSafe(state: RunnerRuntimeState) {
  for (const item of [
    ...(state.plan?.setup ?? []),
    ...(state.plan?.services ?? []),
  ]) {
    for (const [key, value] of Object.entries(item.environment)) {
      // Manifest values are development values already in the workspace;
      // only real-looking credentials must stay out of snapshots.
      if (previewEnvironmentValueRejection(value)) {
        throw new Error(
          `Secret material cannot be persisted in runner state (${key}).`,
        );
      }
    }
  }
  for (const value of Object.values(state.browserBindingUrls)) {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      [...url.searchParams.keys()].some((key) =>
        /token|signature|credential|x-amz/i.test(key),
      )
    ) {
      throw new Error(
        "Signed or credential-bearing URLs cannot be persisted in runner state.",
      );
    }
  }
}

export function initialRuntimeState(): RunnerRuntimeState {
  return {
    prepared: false,
    running: false,
    endpointRevision: 0,
    browserBindingUrls: {},
    routeIds: {},
    sessionId: "",
    generation: 0,
  };
}
