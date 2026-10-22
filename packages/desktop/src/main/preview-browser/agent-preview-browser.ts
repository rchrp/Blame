import { randomUUID } from "node:crypto";
import { BrowserWindow, type WebContents } from "electron";
import { probePreviewApplication } from "./preview-application-probe.ts";
import {
  type PreviewBrowserState,
  type PreviewBrowserStateUpdate,
  updatedPreviewBrowserState,
} from "./preview-browser-state.ts";
import { previewNavigationAllowed } from "./preview-navigation-policy.ts";

// A browser reserved for the agent, one per preview scope. It is never
// shown, keeps rendering while the user looks elsewhere, and navigates
// independently of the user's preview. It shares the user's session
// partition, so cookies, sign-in and the managed network bridge apply.

export type AgentPreviewSource = {
  initialUrl: string;
  partition: string;
  previewOrigin?: string;
};

export type AgentPreviewBrowser = {
  destroyed: boolean;
  // The viewport the agent sees, kept across DevTools reconnections.
  viewport: { height: number; width: number };
  id: string;
  scope: string;
  state: PreviewBrowserState;
  touch(): void;
  webContents: WebContents;
  window: BrowserWindow;
};

type AgentRecord = AgentPreviewBrowser & {
  applicationProbe?: Promise<void>;
  idleTimer?: NodeJS.Timeout;
  previewOrigin?: string;
  ready: Promise<void>;
};

export const agentPreviewViewport = { height: 900, width: 1440 };
const agentPreviewIdleMs = 10 * 60_000;
const agentPreviewLoadTimeoutMs = 30_000;
const agentPreviewProbeTimeoutMs = 2_000;
const agentPreviewFrameRate = 30;
const agents = new Map<string, AgentRecord>();

export function agentPreviewBrowser(scope: string) {
  const record = agents.get(scope);
  return record && !record.destroyed ? record : undefined;
}

export async function ensureAgentPreviewBrowser(
  scope: string,
  source: AgentPreviewSource,
) {
  const current = agentPreviewBrowser(scope);
  if (current) {
    current.touch();
    await current.ready;
    return current;
  }
  const record = createAgentRecord(scope, source);
  agents.set(scope, record);
  await record.ready;
  return record;
}

export function destroyAgentPreviewBrowser(scope: string) {
  const record = agents.get(scope);
  if (!record) return false;
  agents.delete(scope);
  record.destroyed = true;
  if (record.idleTimer) clearTimeout(record.idleTimer);
  if (!record.window.isDestroyed()) record.window.destroy();
  return true;
}

export function destroyAllAgentPreviewBrowsers() {
  Array.from(agents.keys()).forEach(destroyAgentPreviewBrowser);
}

export function reloadAgentPreviewBrowser(scope: string) {
  const record = agentPreviewBrowser(scope);
  if (!record) return false;
  updateState(record, { application: null, error: null, loading: true });
  record.webContents.reload();
  return true;
}

export function refreshAgentApplicationState(record: AgentPreviewBrowser) {
  const agent = record as AgentRecord;
  if (agent.applicationProbe) return agent.applicationProbe;
  const probe = probePreviewApplication(
    (code) => agent.webContents.executeJavaScript(code, true),
    agentPreviewProbeTimeoutMs,
  )
    .then((application) => {
      if (agent.destroyed) return;
      updateState(agent, {
        application,
        ...(application.status === "ready" ? { error: null } : {}),
        loading: false,
      });
    })
    .finally(() => {
      if (agent.applicationProbe === probe) agent.applicationProbe = undefined;
    });
  agent.applicationProbe = probe;
  return probe;
}

function createAgentRecord(scope: string, source: AgentPreviewSource) {
  const window = new BrowserWindow({
    height: agentPreviewViewport.height,
    show: false,
    useContentSize: true,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
      partition: source.partition,
      sandbox: true,
    },
    width: agentPreviewViewport.width,
  });
  const webContents = window.webContents;
  webContents.setFrameRate(agentPreviewFrameRate);
  webContents.setAudioMuted(true);
  const id = randomUUID();
  const record: AgentRecord = {
    destroyed: false,
    id,
    previewOrigin: source.previewOrigin,
    ready: Promise.resolve(),
    scope,
    state: { id, loading: true, url: source.initialUrl },
    touch: () => restartIdleTimer(record),
    viewport: { ...agentPreviewViewport },
    webContents,
    window,
  };
  window.once("closed", () => {
    if (agents.get(scope) === record) agents.delete(scope);
    record.destroyed = true;
    if (record.idleTimer) clearTimeout(record.idleTimer);
  });
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  attachAgentEvents(record);
  record.ready = loadInitialUrl(record, source.initialUrl);
  record.touch();
  return record;
}

async function loadInitialUrl(record: AgentRecord, url: string) {
  const timeout = setTimeout(() => {
    if (record.destroyed) return;
    record.webContents.stop();
    updateState(record, {
      error: "Preview loading timed out. Reload to try again.",
      loading: false,
    });
  }, agentPreviewLoadTimeoutMs);
  try {
    await record.webContents.loadURL(url);
  } catch {
    // did-fail-load already recorded the error in the state.
  } finally {
    clearTimeout(timeout);
  }
}

function restartIdleTimer(record: AgentRecord) {
  if (record.destroyed) return;
  if (record.idleTimer) clearTimeout(record.idleTimer);
  record.idleTimer = setTimeout(
    () => destroyAgentPreviewBrowser(record.scope),
    agentPreviewIdleMs,
  );
  record.idleTimer.unref?.();
}

function attachAgentEvents(record: AgentRecord) {
  const webContents = record.webContents;
  // Links cannot take the agent off its preview; navigate_page is checked
  // separately by the CDP proxy.
  webContents.on("will-navigate", (event, url) => {
    if (!previewNavigationAllowed(url, record.previewOrigin))
      event.preventDefault();
  });
  webContents.on("did-start-loading", () =>
    updateState(record, { application: null, error: null, loading: true }),
  );
  webContents.on("did-stop-loading", () =>
    updateState(record, { loading: false }),
  );
  webContents.on("did-finish-load", () => {
    void refreshAgentApplicationState(record);
  });
  webContents.on("did-navigate", (_event, url) =>
    updateState(record, { error: null, url }),
  );
  webContents.on("did-navigate-in-page", (_event, url) =>
    updateState(record, { url }),
  );
  webContents.on(
    "did-fail-load",
    (_event, code, description, validatedUrl, isMainFrame) => {
      // -3 is an aborted load, for example one replaced by a newer one.
      if (!isMainFrame || code === -3) return;
      updateState(record, {
        error: description,
        loading: false,
        url: validatedUrl,
      });
    },
  );
  webContents.on("render-process-gone", (_event, details) => {
    updateState(record, {
      error: `Agent preview renderer stopped (${details.reason}).`,
      loading: false,
    });
    destroyAgentPreviewBrowser(record.scope);
  });
}

function updateState(record: AgentRecord, update: PreviewBrowserStateUpdate) {
  if (record.destroyed || record.webContents.isDestroyed()) return;
  record.state = updatedPreviewBrowserState(
    record.state,
    {
      id: record.id,
      loading: record.webContents.isLoading(),
      url: record.webContents.getURL() || record.state.url,
    },
    update,
  );
}
