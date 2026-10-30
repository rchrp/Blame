import { createHash } from "node:crypto";
import type {
  PreviewManifest,
  ProjectRunConfiguration,
} from "@blame/agent-runtime";
import type { PreviewRuntimeSelectionState } from "./preview-run-state.ts";

// What a preview recovery depends on, hashed: the circuit breaker retries a
// failed recovery only once its configuration or its failure changed.

export function previewRecoveryConfigurationFingerprint(input: {
  configurations: ProjectRunConfiguration[];
  files: Array<{ content: string; file: string }>;
  manifest: PreviewManifest | undefined;
  runtimeState: PreviewRuntimeSelectionState;
}) {
  const hash = createHash("sha256");
  hash.update(
    JSON.stringify({
      configurations: input.configurations,
      desiredStatus: input.runtimeState.desiredStatus,
      manifest: input.manifest,
      selectedConfigurationId: input.runtimeState.selectedConfigurationId,
    }),
  );
  for (const { content, file } of input.files) {
    hash.update("\0");
    hash.update(file);
    hash.update("\0");
    hash.update(content);
  }
  return hash.digest("hex");
}

export function previewRecoveryFailureFingerprint(
  configurationFingerprint: string,
  configurations: ProjectRunConfiguration[],
  runtimeState: PreviewRuntimeSelectionState,
  error: unknown,
  errorType: string,
) {
  const diagnostic = errorMessage(error).trim().split(/\r?\n/u, 1)[0] ?? "";
  const selected = configurations.find(
    ({ id }) => id === runtimeState.selectedConfigurationId,
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        command: selected?.command,
        configurationFingerprint,
        diagnostic,
        errorType,
        exitCode: previewRecoveryExitCode(error),
        service: selected?.previewService ?? selected?.services[0],
      }),
    )
    .digest("hex");
}

function previewRecoveryExitCode(error: unknown) {
  if (error && typeof error === "object") {
    const value = "exitCode" in error ? error.exitCode : undefined;
    if (typeof value === "number") return value;
  }
  const match = errorMessage(error).match(/exited? with code (\d+)/iu);
  return match ? Number(match[1]) : undefined;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
