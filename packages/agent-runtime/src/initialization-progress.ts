import type { AgentEvent, InitializeProjectInput } from "./types.js";

// Progress of a project initialization, for the app's progress bar. The
// app subscribes to `initializationProgressSessionId(progressId)` before
// it starts the run; each step is a notice on that channel.

export const initializationProgressKind = "initialization_progress";

export type InitializationProgress = {
  kind: typeof initializationProgressKind;
  phase: "scanning" | "analyzing" | "correcting" | "checking";
  /** 0 to 99: the app finishes the bar once the setup is saved. */
  percent: number;
  label: string;
  detail?: string;
  attempt?: number;
  maxAttempts?: number;
};

export function initializationProgressSessionId(progressId: string) {
  return `initialization:${progressId}`;
}

export function initializationProgress(
  events: { emit(event: AgentEvent): void } | undefined,
  input: Pick<InitializeProjectInput, "progressId">,
  maxAttempts: number,
) {
  return new InitializationProgressReporter(
    input.progressId && events ? (event) => events.emit(event) : undefined,
    input.progressId,
    maxAttempts,
  );
}

export class InitializationProgressReporter {
  private readonly emit: ((event: AgentEvent) => void) | undefined;
  private readonly progressId: string | undefined;
  private readonly maxAttempts: number;
  private percent = 0;
  private phase: InitializationProgress["phase"] = "scanning";
  private attemptNumber = 1;

  constructor(
    emit: ((event: AgentEvent) => void) | undefined,
    progressId: string | undefined,
    maxAttempts: number,
  ) {
    this.emit = emit;
    this.progressId = progressId;
    this.maxAttempts = maxAttempts;
  }

  scanning() {
    this.send("scanning", 4, "Reading the repository");
  }

  analyzing() {
    this.send("analyzing", 10, "Analyzing the project");
  }

  /** A submission reached Blame's checks. */
  checking(submission = this.attemptNumber) {
    this.attemptNumber = submission;
    this.send(
      "checking",
      this.percent + (95 - this.percent) * 0.35,
      "Checking the setup",
    );
  }

  /** Blame sent a submission back to the agent to fix. */
  rejected(submission: number, error: unknown) {
    this.attemptNumber = submission + 1;
    this.send(
      "correcting",
      this.percent,
      `Fixing the setup · ${submission + 1} of ${this.maxAttempts}`,
      readableValidationError(
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  tool(toolName: string) {
    this.send(
      this.phase === "correcting" ? "correcting" : "analyzing",
      this.percent + (86 - this.percent) * 0.12,
      initializationToolLabel(toolName),
    );
  }

  /** Blame stopped a model answer that never ended and starts over. */
  restarting() {
    this.send(
      "analyzing",
      this.percent,
      "Starting the analysis again",
      "The model's last answer never ended, so Blame stopped it.",
    );
  }

  private send(
    phase: InitializationProgress["phase"],
    percent: number,
    label: string,
    detail?: string,
  ) {
    if (!this.emit || !this.progressId) return;
    this.phase = phase;
    this.percent = Math.max(this.percent, Math.min(Math.round(percent), 99));
    const payload: InitializationProgress = {
      kind: initializationProgressKind,
      phase,
      percent: this.percent,
      label,
      ...(detail ? { detail } : {}),
      attempt: this.attemptNumber,
      maxAttempts: this.maxAttempts,
    };
    this.emit({
      type: "notice",
      sessionId: initializationProgressSessionId(this.progressId),
      createdAt: new Date().toISOString(),
      payload,
    });
  }
}

export function initializationToolLabel(toolName: string) {
  const name = toolName.toLowerCase();
  if (name.startsWith("submit_project_initialization"))
    return "Writing the preview setup";
  if (name.startsWith("report_project_initialization_blocked"))
    return "Reporting what blocks the analysis";
  if (/read/.test(name)) return "Reading project files";
  if (/search|grep|find/.test(name)) return "Searching the code";
  if (/list|glob|tree/.test(name)) return "Exploring folders";
  if (/command|shell|bash|exec/.test(name)) return "Running a command";
  return "Analyzing the project";
}

function readableValidationError(message: string) {
  const rule = message
    .replace(/^Error:\s*/, "")
    .replace(/^Initialization result (?:previewManifest )?/, "");
  return `The setup ${rule}.`.replace(/\.\.$/, ".");
}
