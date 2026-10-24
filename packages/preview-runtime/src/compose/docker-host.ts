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

export function commandFailureDetail(
  stderr: string,
  stdout: string,
  limit = detailLimit,
) {
  const detail = [stderr, stdout]
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n");
  if (detail.length <= limit) return detail;
  if (limit <= truncationMarker.length) return detail.slice(-limit);
  const available = limit - truncationMarker.length;
  const headLength = Math.floor(available / 3);
  return `${detail.slice(0, headLength)}${truncationMarker}${detail.slice(-(available - headLength))}`;
}
