import { emulatePreviewDevice, previewDeviceSize } from "./device-emulation.ts";
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
  device?: "phone" | "tablet";
  initialUrl: string;
  partition: string;
  previewOrigin?: string;
};

export type AgentPreviewBrowser = {
  device?: "phone" | "tablet";
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
// While a run that used the browser is going, it may spend a long time
// editing code between two looks; the browser stays open for it, up to this
// long without a call in case the run never reports its end.
const agentPreviewHeldIdleMs = 60 * 60_000;
const agentPreviewLoadTimeoutMs = 30_000;
const agentPreviewProbeTimeoutMs = 2_000;
const agentPreviewFrameRate = 30;
const agents = new Map<string, AgentRecord>();
// Agent sessions currently using each scope's browser.
const holders = new Map<string, Set<string>>();

export function agentPreviewBrowser(scope: string) {
  const record = agents.get(scope);
  return record && !record.destroyed ? record : undefined;
}

export async function ensureAgentPreviewBrowser(
  scope: string,
  source: AgentPreviewSource,
) {
  let current = agentPreviewBrowser(scope);
  if (current && current.device !== source.device) {
    destroyAgentPreviewBrowser(scope);
    current = undefined;
  }
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

// A session is using this scope's browser: keep it open until the session
// ends, so a long run does not lose its page, emulation and history.
export function holdAgentPreviewBrowser(scope: string, sessionId: string) {
  const sessions = holders.get(scope) ?? new Set<string>();
  sessions.add(sessionId);
  holders.set(scope, sessions);
  const record = agents.get(scope);
  if (record) restartIdleTimer(record);
}

// The session's run ended; its browsers fall back to the normal idle delay.
export function releaseAgentPreviewSession(sessionId: string) {
  for (const [scope, sessions] of holders) {
    if (!sessions.delete(sessionId)) continue;
    if (!sessions.size) holders.delete(scope);
    const record = agents.get(scope);
    if (record) restartIdleTimer(record);
  }
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
  const viewport = source.device
    ? previewDeviceSize(source.device)
    : agentPreviewViewport;
  const window = new BrowserWindow({
    height: viewport.height,
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
    width: viewport.width,
  });
  const webContents = window.webContents;
  webContents.setFrameRate(agentPreviewFrameRate);
  webContents.setAudioMuted(true);
  const id = randomUUID();
  if (source.device) emulatePreviewDevice(window.webContents, source.device);
  const record: AgentRecord = {
    device: source.device,
    destroyed: false,
    id,
    previewOrigin: source.previewOrigin,
    ready: Promise.resolve(),
    scope,
    state: { id, loading: true, url: source.initialUrl },
    touch: () => restartIdleTimer(record),
    viewport: { ...viewport },
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
    holders.get(record.scope)?.size
      ? agentPreviewHeldIdleMs
      : agentPreviewIdleMs,
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

// What the agent's page looks like right now, read in an isolated world so
// page scripts cannot change the answer.
export async function agentPreviewPageState(scope: string) {
  const record = agentPreviewBrowser(scope);
  if (!record) return undefined;
  try {
    const value = (await record.webContents.executeJavaScriptInIsolatedWorld(
      1_207,
      [
        {
          code: `({ url: location.href, width: innerWidth, height: innerHeight, dark: matchMedia("(prefers-color-scheme: dark)").matches })`,
        },
      ],
    )) as { dark?: unknown; height?: unknown; url?: unknown; width?: unknown };
    return {
      colorScheme: value.dark === true ? ("dark" as const) : ("light" as const),
      url: typeof value.url === "string" ? value.url : (record.state.url ?? ""),
      viewport: {
        height:
          typeof value.height === "number"
            ? value.height
            : record.viewport.height,
        width:
          typeof value.width === "number" ? value.width : record.viewport.width,
      },
    };
  } catch {
    return {
      colorScheme: "light" as const,
      url: record.state.url ?? "",
      viewport: record.viewport,
    };
  }
}
