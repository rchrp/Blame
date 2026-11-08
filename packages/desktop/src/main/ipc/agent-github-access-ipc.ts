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

/** At session start: grants the host's gh token when the project allows it. */
export function prepareSessionGithubAccess(session: Record<string, unknown>) {
  const projects = agentGithubAccessSettings();
  return grantSessionGithubAccess(session, {
    enabled: (projectId) => projects.enabled(projectId),
    readToken: () => readHostGithubToken(),
  });
}

export function registerAgentGithubAccessIpcHandlers(input: {
  isAppWindow(sender: WebContents): boolean;
}) {
  ipcMain.handle("agent-github-access:get", (event, value) => {
    if (!input.isAppWindow(event.sender))
      throw new Error("Settings request was rejected");
    return agentGithubAccessSettings().enabled(projectId(value));
  });
  ipcMain.handle("agent-github-access:set", (event, value) => {
    if (!input.isAppWindow(event.sender))
      throw new Error("Settings request was rejected");
    const body =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
    return agentGithubAccessSettings().setEnabled(
      projectId(value) ?? "",
      body.enabled === true,
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
