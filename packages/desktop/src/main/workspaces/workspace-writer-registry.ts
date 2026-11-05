import { normalize, resolve } from "node:path";

// Which local agent sessions are writing in which folder. Several may share
// one: Direct stories, chats and plan mode all work in the project folder,
// and the harness refuses an edit whose file changed since it was read.
export class WorkspaceWriterRegistry {
  private readonly activeSessions = new Set<string>();
  private readonly sessionWorkspaces = new Map<string, string>();

  begin(sessionId: string, workspace: string) {
    const canonical = canonicalWorkspace(workspace);
    const current = this.sessionWorkspaces.get(sessionId);
    if (this.activeSessions.has(sessionId) && current !== canonical) {
      throw new Error(`Session ${sessionId} already owns another workspace`);
    }
    this.sessionWorkspaces.set(sessionId, canonical);
    this.activeSessions.add(sessionId);
  }

  rebind(previousSessionId: string, sessionId: string) {
    const workspace = this.sessionWorkspaces.get(previousSessionId);
    const active = this.activeSessions.has(previousSessionId);
    this.sessionWorkspaces.delete(previousSessionId);
    this.activeSessions.delete(previousSessionId);
    if (!workspace) return;
    this.sessionWorkspaces.set(sessionId, workspace);
    if (active) this.activeSessions.add(sessionId);
  }

  end(sessionId: string) {
    this.activeSessions.delete(sessionId);
  }

  forget(sessionId: string) {
    this.activeSessions.delete(sessionId);
    this.sessionWorkspaces.delete(sessionId);
  }

  workspaceForSession(sessionId: string) {
    return this.sessionWorkspaces.get(sessionId);
  }

  hasActiveWriter(workspace: string) {
    const canonical = canonicalWorkspace(workspace);
    return [...this.activeSessions].some(
      (sessionId) => this.sessionWorkspaces.get(sessionId) === canonical,
    );
  }

  releaseWorkspace(workspace: string) {
    const canonical = canonicalWorkspace(workspace);
    for (const [sessionId, candidate] of this.sessionWorkspaces) {
      if (candidate !== canonical) continue;
      this.activeSessions.delete(sessionId);
      this.sessionWorkspaces.delete(sessionId);
    }
  }

  clear() {
    this.activeSessions.clear();
    this.sessionWorkspaces.clear();
  }
}

function canonicalWorkspace(value: string) {
  const path = normalize(resolve(value));
  return process.platform === "win32" ? path.toLowerCase() : path;
}
