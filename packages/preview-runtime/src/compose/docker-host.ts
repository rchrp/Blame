import { PreviewRuntimeError } from "../domain/preview-errors.js";
import type { PreviewFailureCode } from "../domain/preview-errors.js";

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type HostCommandOptions = {
  timeoutMs?: number;
  /** Receives output as it arrives, for the preview's run log. */
  onOutput?: (chunk: string) => void;
  /** Stops a long-running command, such as followed logs. */
  signal?: AbortSignal;
};

/**
 * The machine that runs Docker: the Vercel sandbox itself for cloud
 * previews, the Blame Runtime VM for local ones. Commands run as root there.
 */
export interface DockerHost {
  run(
    command: string,
    args: string[],
    options?: HostCommandOptions,
  ): Promise<CommandResult>;
  readFile(path: string): Promise<string | undefined>;
  /** Writes a file readable by root only, creating its directory. */
  writeFile(path: string, content: string): Promise<void>;
}

/** An engine failure; `runnerCode` names it for the runner protocol. */
export class ComposeEngineError extends PreviewRuntimeError {
  readonly runnerCode: string;

  constructor(
    code: string,
    message: string,
    failureCode: PreviewFailureCode = "ENGINE_START_FAILED",
  ) {
    super({ code: failureCode, message, providerCode: code, retryable: false });
    this.runnerCode = code;
  }
}

const detailLimit = 1_000;
const truncationMarker = "\n... [Compose output truncated] ...\n";

// Errors usually end stderr (Compose's own messages and a container's
// errors), while tools such as pnpm print their progress on stdout: keep the
// end of each stream, stderr last.
export function commandFailureDetail(
  stderr: string,
  stdout: string,
  limit = detailLimit,
) {
  const streams = [stdout, stderr].map((value) => value.trim()).filter(Boolean);
  const detail = streams.join("\n");
  if (detail.length <= limit) return detail;
  const share = Math.floor(
    (limit - truncationMarker.length * streams.length) / streams.length,
  );
  return streams
    .map((value) =>
      value.length <= share
        ? value
        : `${truncationMarker.trimStart()}${value.slice(-share)}`,
    )
    .join("\n");
}
