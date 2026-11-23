import type { AgentImportChoice } from "@blame/app";
import { app, ipcMain, type WebContents } from "electron";
import {
  applyAgentImport,
  scanAgentSetups,
  type BlameMcpStore,
} from "../agent-import/import.ts";
import { scanEnvironment } from "../agent-import/environment.ts";
import { fingerprint } from "../agent-import/servers.ts";
import { addImportedMcpServers, readMcpServersForImport } from "../mcp-ipc";

const store: BlameMcpStore = {
  add: addImportedMcpServers,
  list: async () =>
    (await readMcpServersForImport()).map((server) => ({
      name: server.name,
      fingerprint: fingerprint(server),
    })),
};

export function registerAgentImportIpcHandlers(input: {
  isAppWindow(sender: WebContents): boolean;
}) {
  ipcMain.handle("agent-import:scan", (event) => {
    assertAppWindow(input, event.sender);
    return scanAgentSetups(scanEnvironment(app.getPath("home")), store);
  });
  ipcMain.handle("agent-import:apply", (event, value) => {
    assertAppWindow(input, event.sender);
    return applyAgentImport(
      scanEnvironment(app.getPath("home")),
      store,
      validateChoices(value),
    );
  });
}

function assertAppWindow(
  input: { isAppWindow(sender: WebContents): boolean },
  sender: WebContents,
) {
  if (!input.isAppWindow(sender))
    throw new Error("Import request was rejected");
}

function validateChoices(value: unknown): AgentImportChoice[] {
  if (!Array.isArray(value) || value.length > 1000)
    throw new Error("Invalid import choices");
  return value.map((choice) => {
    if (
      typeof choice !== "object" ||
      choice === null ||
      typeof (choice as { id?: unknown }).id !== "string"
    )
      throw new Error("Invalid import choice");
    const { id, rename } = choice as { id: string; rename?: unknown };
    return { id, rename: rename === true };
  });
}
