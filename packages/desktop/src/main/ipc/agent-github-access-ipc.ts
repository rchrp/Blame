import { join } from "node:path";
import { app, ipcMain, type WebContents } from "electron";
import {
  AgentGithubAccessSettings,
  grantSessionGithubAccess,
  readHostGithubToken,
} from "../github-access/agent-github-access.ts";

let settings: AgentGithubAccessSettings | undefined;

function agentGithubAccessSettings() {
  settings ??= new AgentGithubAccessSettings(
    join(app.getPath("userData"), "agent-github-access.json"),
  );
  return settings;
}

/** At session start: grants the host's gh token at the project's level. */
export function prepareSessionGithubAccess(session: Record<string, unknown>) {
  const projects = agentGithubAccessSettings();
  return grantSessionGithubAccess(session, {
    level: (projectId) => projects.level(projectId),
    readToken: () => readHostGithubToken(),
  });
}

export function registerAgentGithubAccessIpcHandlers(input: {
  isAppWindow(sender: WebContents): boolean;
}) {
  ipcMain.handle("agent-github-access:get", (event, value) => {
    if (!input.isAppWindow(event.sender))
      throw new Error("Settings request was rejected");
    return agentGithubAccessSettings().level(projectId(value));
  });
  ipcMain.handle("agent-github-access:set", (event, value) => {
    if (!input.isAppWindow(event.sender))
      throw new Error("Settings request was rejected");
    const body =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
    return agentGithubAccessSettings().setLevel(
      projectId(value) ?? "",
      body.level,
    );
  });
}

function projectId(value: unknown) {
  const id =
    value && typeof value === "object"
      ? (value as Record<string, unknown>).projectId
      : undefined;
  return typeof id === "string" ? id : undefined;
}
