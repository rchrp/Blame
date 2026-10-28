import type { AgentTool } from "./cline-initialization.js";
import { errorMessage } from "./cline-runtime-events.js";
import {
  type ProjectInitializationParseOptions,
  projectInitializationResultSchema,
} from "./project-initialization.js";
import {
  PreviewSetupError,
  type PreviewSetupIssue,
} from "./project-preview-validation.js";

// One initialization agent session, checked as it goes. Each submission is
// validated inside the tool call: a rejected one comes back to the agent as
// a tool error listing every problem, so it fixes them in the same session
// with everything it already read. The agent can also stop and report what
// blocks it when the cause is outside the repository and the setup.

/** Submissions one session may make before Blame stops it. */
export const maxInitializationSubmissions = 10;
/** The same rejection this many times in a row ends the session. */
const repeatedRejectionLimit = 3;

export const submitInitializationToolName = "submit_project_initialization";
export const blockedInitializationToolName =
  "report_project_initialization_blocked";

export const initializationBlockedCategories = {
  missing_secret:
    "A secret, API key or private value only the user has is required to install or start the project.",
  private_dependency:
    "A private package registry, Git repository or artifact is needed and cannot be reached without the user's credentials.",
  unavailable_image:
    "A required container image or runtime does not exist or cannot be pulled.",
  unsupported_stack:
    "The project cannot run in Linux containers (for example a native desktop or mobile app with no web or server part).",
  repository_problem:
    "The repository itself is broken: missing or conflicting lockfiles, unresolved merge conflicts, files that do not parse.",
  blame_problem:
    "A Blame rule or tool rejects a setup that is correct for this project, and no variation passes.",
} as const;

export type InitializationBlockedCategory =
  keyof typeof initializationBlockedCategories;

export type InitializationBlocked = {
  category: InitializationBlockedCategory;
  /** One or two sentences for the user: what blocks the analysis. */
  summary: string;
  /** What the user can do so the next analysis succeeds. */
  userAction: string;
  /** Files, commands or error messages that show it. */
  evidence?: string;
};

/** The analysis stopped because the agent reported what blocks it. */
export class InitializationBlockedError extends Error {
  readonly blocked: InitializationBlocked;

  constructor(blocked: InitializationBlocked) {
    super(
      [
        `Initialization blocked [${blocked.category}]: ${blocked.summary}`,
        `What you can do: ${blocked.userAction}`,
        ...(blocked.evidence ? [`Evidence: ${blocked.evidence}`] : []),
      ].join("\n"),
    );
    this.blocked = blocked;
  }
}

export type InitializationSessionOutcome<T> =
  | { type: "accepted"; result: T; submissions: number }
  | { type: "blocked"; blocked: InitializationBlocked }
  | { type: "stopped"; error: Error; submissions: number }
  | { type: "none"; lastRejection?: { input: unknown; error: unknown } };

type Check<T> = (
  input: unknown,
  options: ProjectInitializationParseOptions,
) => T;

export type InitializationSessionHooks = {
  /** A submission reached the checks. */
  onChecking?(submission: number): void;
  /** A submission was rejected and sent back to the agent. */
  onRejected?(submission: number, error: unknown): void;
};

export class InitializationSession<T> {
  private readonly check: Check<T>;
  private readonly hooks: InitializationSessionHooks;
  private readonly max: number;
  private submissions = 0;
  private accepted: T | undefined;
  private blocked: InitializationBlocked | undefined;
  private stopped: Error | undefined;
  private lastRejection: { input: unknown; error: unknown } | undefined;
  private lastSignature = "";
  private repeats = 0;
  private blockedChallenged = false;

  constructor(
    check: Check<T>,
    hooks: InitializationSessionHooks = {},
    max = maxInitializationSubmissions,
  ) {
    this.check = check;
    this.hooks = hooks;
    this.max = max;
  }

  /** Whether a session already ended with a result, a block or a stop. */
  get settled() {
    return Boolean(this.accepted || this.blocked || this.stopped);
  }

  get remaining() {
    return Math.max(0, this.max - this.submissions);
  }

  tools(): AgentTool[] {
    return [this.submitTool(), this.blockedTool()];
  }

  outcome(): InitializationSessionOutcome<T> {
    if (this.accepted)
      return {
        type: "accepted",
        result: this.accepted,
        submissions: this.submissions,
      };
    if (this.blocked) return { type: "blocked", blocked: this.blocked };
    if (this.stopped)
      return {
        type: "stopped",
        error: this.stopped,
        submissions: this.submissions,
      };
    return { type: "none", lastRejection: this.lastRejection };
  }

  /** Checks one submission; returns what the tool answers the agent. */
  submit(input: unknown) {
    if (this.settled)
      return { accepted: false, message: "This analysis already ended." };
    this.submissions += 1;
    this.hooks.onChecking?.(this.submissions);
    const final = this.submissions >= this.max;
    try {
      this.accepted = this.check(input, { acceptWarnings: final });
      return { accepted: true };
    } catch (error) {
      return this.reject(input, error, final);
    }
  }

  /** Records a block, once the agent confirmed it after a fixable rejection. */
  reportBlocked(input: unknown) {
    if (this.settled)
      return { recorded: false, message: "This analysis already ended." };
    const blocked = parseBlocked(input);
    // A block right after a first rejection is often a way out of a fixable
    // problem; once the same one came back twice, the agent tried.
    if (this.lastRejection && this.repeats < 2 && !this.blockedChallenged) {
      this.blockedChallenged = true;
      throw new Error(
        [
          "Your last submission was rejected for a problem in the setup itself, which you can fix:",
          rejectionProblems(this.lastRejection.error).join("\n"),
          "Fix it and submit again. Report a block only when the cause is outside the repository and the setup you write.",
          "If you are sure it is, call report_project_initialization_blocked again.",
        ].join("\n"),
      );
    }
    this.blocked = blocked;
    return { recorded: true };
  }

  private reject(input: unknown, error: unknown, final: boolean) {
    this.lastRejection = { input, error };
    const signature = rejectionSignature(error);
    this.repeats = signature === this.lastSignature ? this.repeats + 1 : 1;
    const resubmitted = sameInput(input, this.previousInput);
    this.lastSignature = signature;
    this.previousInput = input;
    // Warnings come from heuristics. Submitting the same setup again says
    // they do not apply: it is saved, with the warnings shown to the user.
    if (final || resubmitted || this.repeats >= repeatedRejectionLimit) {
      const saved = this.acceptWithWarnings(input);
      if (saved) return { accepted: true, savedWithWarnings: true };
      if (final || this.repeats >= repeatedRejectionLimit) {
        this.stopped = stoppedError(error, this.repeats, final);
        return { accepted: false, stopped: true, reason: errorMessage(error) };
      }
    }
    this.hooks.onRejected?.(this.submissions, error);
    throw new Error(rejectionFeedback(error, this.submissions, this.max));
  }

  private previousInput: unknown;

  private acceptWithWarnings(input: unknown) {
    try {
      this.accepted = this.check(input, { acceptWarnings: true });
      return true;
    } catch {
      return false;
    }
  }

  private submitTool(): AgentTool {
    return {
      name: submitInitializationToolName,
      description:
        "Submit the complete Blame project initialization result. Blame checks it immediately: a rejected result comes back as an error listing every problem to fix before submitting again.",
      inputSchema: projectInitializationResultSchema,
      lifecycle: { completesRun: true },
      execute: (input: unknown) => this.submit(input),
    } as AgentTool;
  }

  private blockedTool(): AgentTool {
    return {
      name: blockedInitializationToolName,
      description:
        "Stop the analysis because something outside the repository and the setup you write blocks it, and tell the user what to do. Never use it for a validation error you can fix.",
      inputSchema: blockedSchema,
      lifecycle: { completesRun: true },
      execute: (input: unknown) => this.reportBlocked(input),
    } as AgentTool;
  }
}

const blockedSchema = {
  type: "object",
  additionalProperties: false,
  required: ["category", "summary", "userAction"],
  properties: {
    category: {
      type: "string",
      enum: Object.keys(initializationBlockedCategories),
      description: Object.entries(initializationBlockedCategories)
        .map(([key, meaning]) => `${key}: ${meaning}`)
        .join(" "),
    },
    summary: {
      type: "string",
      maxLength: 400,
      description:
        "For the user, in plain words: what blocks the analysis. No internal field names.",
    },
    userAction: {
      type: "string",
      maxLength: 400,
      description:
        "What the user can do so the next analysis succeeds, as one concrete step.",
    },
    evidence: {
      type: "string",
      maxLength: 1200,
      description: "The files, commands or messages that show it.",
    },
  },
} as const;

function parseBlocked(input: unknown): InitializationBlocked {
  const record =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const category = record.category;
  if (
    typeof category !== "string" ||
    !(category in initializationBlockedCategories)
  )
    throw new Error(
      `category must be one of: ${Object.keys(initializationBlockedCategories).join(", ")}.`,
    );
  const text = (key: string, required: boolean) => {
    const value = record[key];
    if (typeof value === "string" && value.trim())
      return value.trim().slice(0, key === "evidence" ? 1200 : 400);
    if (required) throw new Error(`${key} is required.`);
    return undefined;
  };
  const evidence = text("evidence", false);
  return {
    category: category as InitializationBlockedCategory,
    summary: text("summary", true)!,
    userAction: text("userAction", true)!,
    ...(evidence ? { evidence } : {}),
  };
}

/** What the agent reads when a submission is rejected. */
export function rejectionFeedback(
  error: unknown,
  submission: number,
  max: number,
) {
  const left = max - submission;
  const problems = rejectionProblems(error);
  return [
    `Submission ${submission} of ${max} was rejected. ${left} ${left === 1 ? "submission is" : "submissions are"} left.`,
    problems.length === 1 ? "Problem:" : `Problems (${problems.length}):`,
    ...problems,
    "Fix every problem above, then call submit_project_initialization again with the complete corrected result, not a partial one.",
    "Problems marked [warning] come from heuristics. If one does not apply to this project, submit the same result again unchanged: it is saved and the warning is shown to the user.",
    "If something outside the repository and the setup blocks you, call report_project_initialization_blocked instead.",
  ].join("\n");
}

function rejectionProblems(error: unknown) {
  if (error instanceof PreviewSetupError)
    return error.issues.map(
      (issue, index) =>
        `${index + 1}. [${issue.severity === "blocking" ? "must fix" : "warning"}] The previewManifest ${issue.rule}.${issueHint(issue)}`,
    );
  return [`1. [must fix] ${readableRejection(errorMessage(error))}`];
}

function issueHint(issue: PreviewSetupIssue) {
  return issue.severity === "warning" ? ` (${issue.warning})` : "";
}

function readableRejection(message: string) {
  const text = message
    .replace(/^Error:\s*/, "")
    .replace(/^Initialization result /, "The result ");
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function rejectionSignature(error: unknown) {
  return error instanceof PreviewSetupError
    ? error.issues.map(({ rule }) => rule).join("|")
    : errorMessage(error);
}

function stoppedError(error: unknown, repeats: number, final: boolean) {
  const reason =
    error instanceof PreviewSetupError
      ? `The setup ${error.issues[0]!.rule}.`
      : readableRejection(errorMessage(error));
  return new Error(
    final
      ? `The setup was still rejected after ${maxInitializationSubmissions} corrections. Last problem: ${reason}`
      : `The setup was rejected ${repeats} times in a row for the same problem: ${reason}`,
  );
}

function sameInput(a: unknown, b: unknown) {
  if (b === undefined) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
