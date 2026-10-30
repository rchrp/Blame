import { ipcMain, type WebContents } from "electron";
import { readGitIdentity, saveGitIdentity } from "../git-identity";
import { resetRuntimeGitIdentityConfigured } from "../workspace-runtime";

export function registerGitIdentityIpcHandlers(input: {
  isAppWindow(sender: WebContents): boolean;
}) {
  ipcMain.handle("git-identity:read", (event, value: unknown) => {
    if (!input.isAppWindow(event.sender))
      throw new Error("Git identity request was rejected");
    const root = record(value).root;
    return readGitIdentity(typeof root === "string" && root ? { root } : {});
  });
  ipcMain.handle("git-identity:save", async (event, value: unknown) => {
    if (!input.isAppWindow(event.sender))
      throw new Error("Git identity request was rejected");
    const body = record(value);
    const identity = await saveGitIdentity({
      email: typeof body.email === "string" ? body.email : "",
      name: typeof body.name === "string" ? body.name : "",
    });
    // BlameRuntime copies the identity once per session: copy it again.
    resetRuntimeGitIdentityConfigured();
    return identity;
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
