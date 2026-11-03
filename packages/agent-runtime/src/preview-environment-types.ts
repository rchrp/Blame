// What a story preview's environment looks like, for the Variables tab and
// the development agent. Values only travel to the app, masked when they
// look secret; the agent sees key names and statuses, never values.

/**
 * Where a value comes from, strongest first: Blame's own values, a story
 * override, a project variable, the developer's env files, then defaults.
 */
export type PreviewVariableSource =
  | "blame-service"
  | "blame-origin"
  | "blame-database"
  | "blame-listen"
  | "story"
  | "project"
  | "env-file"
  | "manifest"
  | "env-example";

/**
 * `removed`: a developer database setting left out because the preview has
 * its own database. `missing`: a key the code or `.env.example` expects
 * that nothing sets.
 */
export type PreviewVariableStatus =
  "set" | "empty" | "placeholder" | "removed" | "missing";

export type PreviewVariableView = {
  key: string;
  /** The value, masked when it looks secret. */
  value: string;
  masked: boolean;
  source: PreviewVariableSource;
  /** The env file it comes from, relative to the project root. */
  file?: string;
  /** What Blame changed, such as a host renamed to reach your computer. */
  note?: string;
  /** Blame's own values cannot be overridden. */
  locked: boolean;
  status: PreviewVariableStatus;
  /** The code declares it required (an env schema such as start/env.ts). */
  required?: boolean;
};

export type PreviewEnvironmentServiceView = {
  id: string;
  kind: "service" | "setup";
  /** The service's working directory, relative to the project root. */
  directory: string;
  variables: PreviewVariableView[];
  /** Its environment changed since its container started. */
  changedSinceStart: boolean;
};

export type PreviewVariableRequest = {
  key: string;
  reason: string;
  serviceId?: string;
  requestedAt: string;
};

export type PreviewEnvironmentView = {
  databaseMode: "compose" | "existing";
  services: PreviewEnvironmentServiceView[];
  /** Problems a start would hit, in plain words. */
  warnings: string[];
  /** Variables the development agent asked for. */
  requests: PreviewVariableRequest[];
  /** Stored values are protected by the system keychain. */
  encrypted: boolean;
};

export type PreviewVariableScope = "story" | "project";

export type SetPreviewVariableInput = {
  worktree: string;
  key: string;
  /** Undefined removes the variable from that scope. */
  value?: string;
  scope: PreviewVariableScope;
  /** Only this service; all services when omitted. */
  serviceId?: string;
};

export type PreviewEnvironmentKeyStatus = {
  key: string;
  status: "set" | "missing" | "placeholder";
  services: string[];
  required?: boolean;
};
