// The workspace harness's data as this package handles it: the task contract
// a session gives blame-harness (crates/blame-harness, which validates the
// tools' inputs and runs them) and the shape of a workspace result. Types
// only.

/** Trusted caller requirements, never commands inferred from acceptance prose. */
export type RequiredProjectCheck = { id: string; task: string; args?: string[] };

export type LightTaskContract = {
  environment?: { isolated: boolean; managedPreview: boolean };
  acceptance_criteria?: string[];
  required_checks?: RequiredProjectCheck[];
  effect_requirement?: "none" | "source_change";
  objective?: string;
  session_id?: string;
  story_id?: string;
};

/**
 * What the app grants a session's commands (the harness's
 * `commandCredentials`). With it, a command never inherits GH_TOKEN or
 * GITHUB_TOKEN: GH_TOKEN is the granted token, when there is one.
 */
export type LightCommandCredentials = {
  githubToken?: string;
  /**
   * Host commands only (cloud sessions): the directory of the gh Blame
   * provides, put first on PATH, and the GH_CONFIG_DIR gh uses instead of
   * the person's.
   */
  githubCli?: { binDirectory?: string; configDirectory: string };
};

/** An image part of a result, as a model reads it. */
export type ImageContent = { type: "image"; data: string; mimeType: string };

export type LightToolResult<T> =
  | { status: "ok"; data: T; receipt?: string; content?: ImageContent[] }
  | {
      status: "blocked";
      category: "input" | "code" | "command" | "environment" | "external";
      message: string;
      recovery?: string;
      diagnosticId?: string;
    }
  | {
      status: "failed";
      category: "harness";
      applied?: boolean;
      recovery?: "recovery_required";
      paths?: string[];
      message: string;
      diagnosticId: string;
    };
