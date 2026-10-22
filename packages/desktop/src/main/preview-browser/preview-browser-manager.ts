import { randomUUID } from "node:crypto";
import {
  BrowserWindow,
  type IpcMainInvokeEvent,
  shell,
  WebContentsView,
} from "electron";
import { previewSessionPartition } from "./preview-session-partition";
import { PreviewNetworkBridge } from "./preview-network-bridge";
import type {
  DesktopBridgeGrant,
  PreviewBridgeSource,
} from "./preview-bridge-grant";
import { attachPreviewRequestTelemetry } from "./preview-request-telemetry";
import { keepsManagedPreviewBridge } from "./preview-navigation-policy";
import {
  electronCdpDebuggee,
  previewNavigationPolicy,
} from "./electron-cdp-debuggee";
import { startPreviewCdpProxy } from "./preview-cdp-proxy";
import { probePreviewApplication } from "./preview-application-probe";
import {
  type PreviewBrowserState,
  type PreviewBrowserStateUpdate,
  updatedPreviewBrowserState,
} from "./preview-browser-state";

type PreviewBrowserRecord = {
  devtoolsScope?: string;
  id: string;
  owner: BrowserWindow;
  previewOrigin?: string;
  state?: PreviewBrowserState;
  view: WebContentsView;
  visible: boolean;
  loadTimeout?: NodeJS.Timeout;
  applicationProbe?: Promise<void>;
  bridge?: PreviewNetworkBridge;
  ownerClosed: () => void;
};

type PreviewBrowserBounds = {
  height: number;
  width: number;
  x: number;
  y: number;
};

type PreviewBrowserCaptureSize = "full" | "thumbnail";
type PreviewDevtoolsTargetInput = {
  probeApplication?: boolean;
  scope?: string;
};

const previews = new Map<string, PreviewBrowserRecord>();
const previewLoadTimeoutMs = 30_000;
const previewApplicationProbeTimeoutMs = 2_000;
const hiddenPreviewFrameRate = 1;
const visiblePreviewFrameRate = 30;
let activePreviewDevtoolsTarget: PreviewBrowserState | undefined;
const previewDevtoolsTargets = new Map<string, PreviewBrowserState>();

export type PreviewDevtoolsTarget = {
  application?: PreviewBrowserState["application"];
  available: boolean;
  currentUrl?: string;
  error?: string;
  id?: string;
  loading: boolean;
  visible?: boolean;
  previewOrigin?: string;
  scope?: string;
};

// No Chromium debugging port is ever opened. Each MCP connection gets a
// loopback proxy, guarded by a random token, that only reaches this page.
export async function openPreviewDevtoolsEndpoint(input: { scope: string }) {
  const scope = normalizedPreviewDevtoolsScope(input.scope);
  const target = scope ? previewDevtoolsTargets.get(scope) : undefined;
  const record = target ? previews.get(target.id) : undefined;
  if (!record || record.view.webContents.isDestroyed())
    throw new Error("The scoped preview page is no longer available.");
  const webContents = record.view.webContents;
  return startPreviewCdpProxy(
    electronCdpDebuggee(webContents, {
      contentSize: () => {
        const { height, width } = record.view.getBounds();
        return { height, width };
      },
    }),
    previewNavigationPolicy(record.previewOrigin),
  );
}

export function getPreviewDevtoolsTarget(
  input: PreviewDevtoolsTargetInput = {},
): PreviewDevtoolsTarget {
  const scope = normalizedPreviewDevtoolsScope(input.scope);
  const target = previewDevtoolsTargetForScope(scope);
  return previewDevtoolsTarget(
    previewDevtoolsTargetReady(target),
    target,
    scope,
  );
}

export async function inspectPreviewDevtoolsTarget(
  input: PreviewDevtoolsTargetInput = {},
) {
  const scope = normalizedPreviewDevtoolsScope(input.scope);
  const target = previewDevtoolsTargetForScope(scope);
  const record = target ? previews.get(target.id) : undefined;
  if (
    input.probeApplication !== false &&
    record &&
    record.visible &&
    previewDevtoolsTargetReady(target)
  ) {
    await refreshApplicationState(record);
  }
  return getPreviewDevtoolsTarget(input);
}

function previewDevtoolsTarget(
  available: boolean,
  target: PreviewBrowserState | undefined,
  scope: string | undefined,
): PreviewDevtoolsTarget {
  const record = target ? previews.get(target.id) : undefined;
  return {
    ...(target?.application ? { application: target.application } : {}),
    available,
    currentUrl: target?.url,
    error: target?.error,
    id: target?.id,
    loading: target?.loading ?? false,
    visible: target ? previews.get(target.id)?.visible : undefined,
    ...(record?.previewOrigin ? { previewOrigin: record.previewOrigin } : {}),
    ...(scope ? { scope } : {}),
  };
}

function previewDevtoolsTargetForScope(scope: string | undefined) {
  return scope
    ? previewDevtoolsTargets.get(scope)
    : activePreviewDevtoolsTarget;
}

function previewDevtoolsTargetReady(target: PreviewBrowserState | undefined) {
  return Boolean(target?.url && !target.loading && !target.error);
}

function normalizedPreviewDevtoolsScope(scope: string | undefined) {
  const normalized = scope?.trim();
  return normalized || undefined;
}

export async function createPreviewBrowser(
  event: IpcMainInvokeEvent,
  input: {
    storageKey: string;
    previewSessionId?: string;
    previewWorktree?: string;
  },
  options: {
    bridgeGrant?(source: PreviewBridgeSource): Promise<DesktopBridgeGrant>;
  },
) {
  const owner = BrowserWindow.fromWebContents(event.sender);
  if (!owner) throw new Error("Preview owner window not found");
  if (!input.storageKey?.trim() || input.storageKey.length > 2_048)
    throw new Error("Preview storage key is invalid");
  const bridgeSource = previewBridgeSource(input);
  const id = randomUUID();
  const view = createPreviewBrowserView(input.storageKey);
  view.webContents.setFrameRate(hiddenPreviewFrameRate);
  const bridge =
    bridgeSource && options.bridgeGrant
      ? new PreviewNetworkBridge(
          view.webContents.session,
          () => options.bridgeGrant!(bridgeSource),
          bridgeSource.kind,
        )
      : undefined;
  if (bridge) {
    try {
      await bridge.start();
    } catch (error) {
      await bridge.close().catch(() => undefined);
      view.webContents.close();
      throw error;
    }
  }
  if (owner.isDestroyed() || event.sender.isDestroyed()) {
    await bridge?.close().catch(() => undefined);
    if (!view.webContents.isDestroyed()) view.webContents.close();
    throw new Error("Preview owner window closed during creation");
  }
  const ownerClosed = () => {
    destroyPreviewBrowser(id);
  };
  const record: PreviewBrowserRecord = {
    id,
    owner,
    view,
    visible: false,
    bridge,
    ownerClosed,
  };
  previews.set(id, record);
  owner.contentView.addChildView(view);
  view.setBounds({ height: 0, width: 0, x: 0, y: 0 });
  view.setVisible(false);
  view.setBorderRadius(8);
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (safeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  attachPreviewBrowserEvents(record);
  attachPreviewRequestTelemetry(record.view.webContents);
  owner.once("closed", ownerClosed);
  return { id };
}

function previewBridgeSource(input: {
  previewSessionId?: string;
  previewWorktree?: string;
}) {
  const previewSessionId = input.previewSessionId?.trim();
  const previewWorktree = input.previewWorktree?.trim();
  if (previewSessionId && previewWorktree)
    throw new Error("Preview bridge source is ambiguous");
  if (previewSessionId) {
    if (previewSessionId.length > 128)
      throw new Error("Preview session ID is invalid");
    return {
      kind: "cloud" as const,
      sessionId: previewSessionId,
    };
  }
  if (!previewWorktree) return undefined;
  if (previewWorktree.length > 8_192)
    throw new Error("Preview worktree is invalid");
  return { kind: "local" as const, worktree: previewWorktree };
}

function createPreviewBrowserView(storageKey: string) {
  return new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: previewSessionPartition(storageKey),
      sandbox: true,
    },
  });
}

export async function loadPreviewBrowser(input: { id: string; url: string }) {
  const record = previews.get(input.id);
  if (!record) return false;
  record.previewOrigin = urlOrigin(input.url);
  startPreviewLoadTimeout(record, input.url);
  try {
    await record.view.webContents.loadURL(input.url);
  } finally {
    clearPreviewLoadTimeout(record);
  }
  return true;
}

export function setPreviewBrowserBounds(input: {
  bounds: PreviewBrowserBounds;
  id: string;
  visible: boolean;
}) {
  const record = previews.get(input.id);
  if (!record) return false;
  const bounds = normalizedBounds(input.bounds);
  const visible = input.visible && bounds.width > 0 && bounds.height > 0;
  record.visible = visible;
  record.view.setBounds(bounds);
  record.view.setVisible(visible);
  record.view.webContents.setFrameRate(
    visible ? visiblePreviewFrameRate : hiddenPreviewFrameRate,
  );
  record.view.webContents.setAudioMuted(!visible);
  syncPreviewDevtoolsTargets(record, previewBrowserState(record));
  return true;
}

export function setPreviewBrowserDevtoolsScope(input: {
  id: string;
  scope?: string | null;
}) {
  const record = previews.get(input.id);
  if (!record) return false;
  clearPreviewDevtoolsScope(record);
  record.devtoolsScope = normalizedPreviewDevtoolsScope(
    input.scope ?? undefined,
  );
  syncPreviewDevtoolsTargets(record, previewBrowserState(record));
  return true;
}

export function reloadPreviewBrowser(input: { id: string }) {
  const record = previews.get(input.id);
  if (!record) return false;
  startPreviewLoadTimeout(record, record.view.webContents.getURL());
  sendPreviewBrowserState(record, {
    application: null,
    error: null,
    loading: true,
  });
  record.view.webContents.reload();
  return true;
}

export function reloadPreviewBrowserForScope(input: { scope?: string }) {
  const scope = normalizedPreviewDevtoolsScope(input.scope);
  const target = previewDevtoolsTargetForScope(scope);
  if (!target) return false;
  return reloadPreviewBrowser({ id: target.id });
}

export function destroyPreviewBrowser(id: string) {
  const record = previews.get(id);
  if (!record) return false;
  previews.delete(id);
  record.owner.removeListener("closed", record.ownerClosed);
  clearPreviewLoadTimeout(record);
  clearPreviewDevtoolsTargets(record);
  record.bridge?.disableRoutes();
  void record.bridge?.close();
  if (!record.owner.isDestroyed())
    record.owner.contentView.removeChildView(record.view);
  if (!record.view.webContents.isDestroyed()) record.view.webContents.close();
  return true;
}

export function destroyAllPreviewBrowsers() {
  Array.from(previews.keys()).forEach((id) => destroyPreviewBrowser(id));
}

export async function capturePreviewBrowser(
  id: string,
  size: PreviewBrowserCaptureSize,
) {
  const record = previews.get(id);
  if (!record || !record.view.getVisible()) return null;
  const image = await record.view.webContents.capturePage(
    size === "thumbnail" ? previewThumbnailBounds(record) : undefined,
  );
  if (image.isEmpty()) return null;
  if (size === "thumbnail")
    return image.resize({ height: 24, quality: "good", width: 24 }).toDataURL();
  return image.toDataURL();
}

function previewThumbnailBounds(record: PreviewBrowserRecord) {
  const bounds = record.view.getBounds();
  const width = Math.max(1, Math.min(96, bounds.width));
  const height = Math.max(1, Math.min(96, bounds.height));
  return {
    height,
    width,
    x: Math.max(0, Math.round((bounds.width - width) / 2)),
    y: Math.max(0, Math.round((bounds.height - height) / 2)),
  };
}

function attachPreviewBrowserEvents(record: PreviewBrowserRecord) {
  record.view.webContents.on("will-navigate", (_event, url) => {
    if (
      record.bridge &&
      !keepsManagedPreviewBridge(
        record.view.webContents.getURL(),
        url,
        (candidate) => record.bridge!.expectedOrigin(candidate),
      )
    ) {
      record.bridge.disableRoutes();
    }
  });
  record.view.webContents.on("did-start-loading", () => {
    startPreviewLoadTimeout(record, record.view.webContents.getURL());
    sendPreviewBrowserState(record, {
      application: null,
      error: null,
      loading: true,
    });
  });
  record.view.webContents.on("did-stop-loading", () => {
    clearPreviewLoadTimeout(record);
    sendPreviewBrowserState(record, { loading: false });
  });
  record.view.webContents.on("did-finish-load", () => {
    clearPreviewLoadTimeout(record);
    void refreshApplicationState(record);
  });
  record.view.webContents.on("did-navigate", (_event, url) =>
    sendPreviewBrowserState(record, { error: null, loading: false, url }),
  );
  record.view.webContents.on("did-navigate-in-page", (_event, url) =>
    sendPreviewBrowserState(record, { error: null, url }),
  );
  record.view.webContents.on(
    "did-fail-load",
    (_event, _code, description, validatedUrl, isMainFrame) => {
      if (!isMainFrame) return;
      clearPreviewLoadTimeout(record);
      sendPreviewBrowserState(record, {
        error: description,
        loading: false,
        url: validatedUrl,
      });
    },
  );
  record.view.webContents.on("render-process-gone", (_event, details) => {
    clearPreviewLoadTimeout(record);
    sendPreviewBrowserState(record, {
      error: `Preview renderer stopped (${details.reason}). Reload to recover.`,
      loading: false,
    });
  });
  record.view.webContents.on("unresponsive", () => {
    sendPreviewBrowserState(record, {
      error: "Preview renderer is not responding. Reload to recover.",
      loading: false,
    });
  });
}

function refreshApplicationState(record: PreviewBrowserRecord) {
  if (record.applicationProbe) return record.applicationProbe;
  const probe = updateApplicationState(record).finally(() => {
    if (record.applicationProbe === probe) record.applicationProbe = undefined;
  });
  record.applicationProbe = probe;
  return probe;
}

async function updateApplicationState(record: PreviewBrowserRecord) {
  const application = await probePreviewApplication(
    (source) => record.view.webContents.executeJavaScript(source, true),
    previewApplicationProbeTimeoutMs,
  );
  if (record.view.webContents.isDestroyed()) return;
  sendPreviewBrowserState(record, {
    application,
    ...(application.status === "ready" ? { error: null } : {}),
    loading: false,
  });
}

function startPreviewLoadTimeout(record: PreviewBrowserRecord, url: string) {
  clearPreviewLoadTimeout(record);
  record.loadTimeout = setTimeout(() => {
    record.view.webContents.stop();
    sendPreviewBrowserState(record, {
      error: "Preview loading timed out. Reload to try again.",
      loading: false,
      url,
    });
  }, previewLoadTimeoutMs);
}

function clearPreviewLoadTimeout(record: PreviewBrowserRecord) {
  if (record.loadTimeout) clearTimeout(record.loadTimeout);
  record.loadTimeout = undefined;
}

function sendPreviewBrowserState(
  record: PreviewBrowserRecord,
  state: PreviewBrowserStateUpdate,
) {
  const nextState = updatedPreviewBrowserState(
    record.state,
    {
      id: record.id,
      loading: record.view.webContents.isLoading(),
      url: record.view.webContents.getURL(),
    },
    state,
  );
  record.state = nextState;
  syncPreviewDevtoolsTargets(record, nextState);
  if (record.owner.isDestroyed()) return;
  record.owner.webContents.send(
    `preview-browser:state:${record.id}`,
    nextState,
  );
}

function previewBrowserState(record: PreviewBrowserRecord) {
  if (record.state) return record.state;
  return {
    id: record.id,
    loading: record.view.webContents.isLoading(),
    url: record.view.webContents.getURL(),
  } satisfies PreviewBrowserState;
}

function syncPreviewDevtoolsTargets(
  record: PreviewBrowserRecord,
  state: PreviewBrowserState,
) {
  if (record.devtoolsScope)
    previewDevtoolsTargets.set(record.devtoolsScope, state);
  if (record.visible) {
    activePreviewDevtoolsTarget = state;
    return;
  }
  clearActivePreviewDevtoolsTarget(record.id);
}

function clearPreviewDevtoolsScope(record: PreviewBrowserRecord) {
  if (!record.devtoolsScope) return;
  const target = previewDevtoolsTargets.get(record.devtoolsScope);
  if (target?.id === record.id)
    previewDevtoolsTargets.delete(record.devtoolsScope);
}

function clearPreviewDevtoolsTargets(record: PreviewBrowserRecord) {
  clearPreviewDevtoolsScope(record);
  clearActivePreviewDevtoolsTarget(record.id);
}

function clearActivePreviewDevtoolsTarget(id: string) {
  if (activePreviewDevtoolsTarget?.id === id)
    activePreviewDevtoolsTarget = undefined;
}

function urlOrigin(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function safeExternalUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function normalizedBounds(bounds: PreviewBrowserBounds) {
  return {
    height: Math.max(0, Math.round(bounds.height)),
    width: Math.max(0, Math.round(bounds.width)),
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
  };
}
