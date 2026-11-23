// What the self-repair tools (`blame_inspect`, `blame_configure`,
// `blame_repair`) ask of the app, and the shapes they answer with. The tools
// run in the engine host; the desktop's main process answers what only it
// knows (the app, the runtime VM, its own log, the preview's lifecycle)
// through one service, `blameApp`.

import type { DesktopServices } from "../desktop-services.js";
import type { McpConnections } from "./mcp.js";

/** The Settings sections a step can be handed to (the app's `SettingsSectionId`). */
export const settingsSections = [
  "models",
  "mcp",
  "desktop",
  "account",
  "general",
] as const;
export type SettingsSection = (typeof settingsSections)[number];

/** One request to the desktop's `blameApp` service. */
export type BlameAppRequest = {
  action: "state" | "log" | "restart_preview" | "start_runtime";
  /** log: keep the lines holding this text. */
  search?: string;
  /** log: how many recent lines. */
  lines?: number;
  /** restart_preview: the conversation's preview. */
  worktree?: string;
  workspaceMode?: "local-container" | "cloud-mirror" | "direct";
};

/** What `state` says of the app and its runtime VM. */
export type BlameAppState = {
  app: { version: string; packaged: boolean; platform: string; arch: string };
  runtime?: {
    status: string;
    /** The VM is installed and stopped. */
    startRequired?: boolean;
    /** The VM is installed and out of date. */
    updateRequired?: boolean;
    issues: { name: string; status: string; action?: string }[];
    error?: string;
  };
  /** Errors and warnings the app logged lately. */
  log: { errors: number; lastError?: string };
};

export type BlameAppLog = { lines: string[]; total: number };

/** What the engine host knows and the desktop does not. */
export type BlameHostServices = {
  /** The model providers the person connected, without their credentials. */
  providers(): Promise<
    {
      provider: string;
      label: string;
      auth?: string;
      expiresAt?: string | null;
      endpoint?: string;
    }[]
  >;
  /** The latest model request failures of a conversation, newest last. */
  sessionFailures(session: string): Promise<string[]>;
};

export type BlameToolServices = Pick<
  DesktopServices,
  | "blameApp"
  | "previewDevtools"
  | "previewContainerLogs"
  | "refreshPreviewDependencies"
> & {
  mcp?: McpConnections;
  blameHost?: BlameHostServices;
  /** Where the user's skills live (`~`); tests point it elsewhere. */
  home?: string;
  /** Plugin folders whose skills the conversation lists. */
  pluginPaths?: readonly string[];
  /** Fetches a skill's files; the platform's by default. */
  fetch?: typeof fetch;
  /** The user's MCP settings file; the app's by default. */
  mcpSettingsPath?: () => string;
  log?(message: string, payload?: Record<string, unknown>): void;
};

/** What `blame_inspect` says of one area. */
export type AreaReport = {
  area: string;
  status: "ok" | "problem" | "unknown";
  summary: string;
  details?: unknown;
  /** What to do about it, in the tools' own words. */
  next?: string;
};
