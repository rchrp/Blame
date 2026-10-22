import { previewNavigationAllowed } from "../preview-browser/preview-navigation-policy.ts";

// What the agent set on its browser page, per preview scope, so a new
// DevTools connection can put it back: after a timeout reset, a crash, or
// the browser reopening. chrome-devtools-mcp's emulate replaces the whole
// emulation on each call, so its last arguments are the current state.

export type PreviewReconnectReason =
  | "browser"
  | "cancelled"
  | "connection"
  | "preview"
  | "replaced"
  | "timeout";

type ScopeState = {
  closedBecause?: PreviewReconnectReason;
  connected: boolean;
  emulate?: Record<string, unknown>;
  resize?: { height: number; width: number };
  url?: string;
};

export type PreviewRestoreCall = (
  toolName: string,
  argumentsValue: Record<string, unknown>,
) => Promise<unknown>;

const reasonText: Record<PreviewReconnectReason, string> = {
  browser:
    "because the preview browser closed (idle, crash or restart) and was reopened",
  cancelled: "after the previous call was cancelled",
  connection: "after the DevTools connection dropped",
  preview: "after the preview was unavailable",
  replaced: "because the preview page changed",
  timeout: "after the previous call ran out of time",
};

export class PreviewDevtoolsPageState {
  private readonly scopes = new Map<string, ScopeState>();

  // The emulated CPU and network slowdown, which stretch every wait.
  slowdown(scope: string) {
    return this.scopes.get(scope)?.emulate ?? {};
  }

  // A connection ended. The first reason given is kept: closing it
  // ourselves also closes its endpoint, which reports "browser" later.
  closed(scope: string, reason: PreviewReconnectReason) {
    const state = this.scopes.get(scope);
    if (state?.connected) state.closedBecause ??= reason;
  }

  // A new connection opens. Returns why, when it replaces an earlier one.
  opened(scope: string): PreviewReconnectReason | undefined {
    const state = this.state(scope);
    const reconnected = state.connected
      ? (state.closedBecause ?? "connection")
      : undefined;
    state.connected = true;
    state.closedBecause = undefined;
    return reconnected;
  }

  // Remember what a successful call set, and where the page now is.
  record(
    scope: string,
    toolName: string,
    argumentsValue: Record<string, unknown>,
    result: unknown,
    pageUrl: string | undefined,
  ) {
    const state = this.state(scope);
    // A Chromium error page (dev server down) is not a page to come back to.
    if (pageUrl && /^https?:/iu.test(pageUrl)) state.url = pageUrl;
    if (resultFailed(result)) return;
    if (toolName === "emulate") {
      const next = { ...argumentsValue };
      // Extra headers persist until cleared, unlike the other settings.
      if (
        next.extraHttpHeaders === undefined &&
        state.emulate?.extraHttpHeaders !== undefined
      )
        next.extraHttpHeaders = state.emulate.extraHttpHeaders;
      state.emulate = next;
    }
    if (toolName === "resize_page") {
      const width = Number(argumentsValue.width);
      const height = Number(argumentsValue.height);
      if (width > 0 && height > 0) state.resize = { height, width };
    }
  }

  // Put the page back as the agent left it, and say what happened.
  async restore(
    scope: string,
    reason: PreviewReconnectReason,
    call: PreviewRestoreCall,
    page: { origin?: string; url?: string },
  ) {
    const state = this.state(scope);
    const restored: string[] = [];
    const failed: string[] = [];
    const attempt = async (
      label: string,
      toolName: string,
      argumentsValue: Record<string, unknown>,
    ) => {
      try {
        const result = await call(toolName, argumentsValue);
        if (resultFailed(result)) failed.push(label);
        else restored.push(label);
      } catch {
        failed.push(label);
      }
    };
    if (state.resize)
      await attempt(
        `viewport ${state.resize.width}×${state.resize.height}`,
        "resize_page",
        state.resize,
      );
    if (state.emulate && Object.keys(state.emulate).length)
      await attempt(emulationText(state.emulate), "emulate", state.emulate);
    if (state.url && state.url !== page.url) {
      if (previewNavigationAllowed(state.url, page.origin))
        await attempt(`page ${pathOf(state.url)}`, "navigate_page", {
          type: "url",
          url: state.url,
        });
      else failed.push(`page ${state.url} (no longer on this preview)`);
    }
    return [
      `Note: the browser was reconnected ${reasonText[reason]}. Console messages and network requests from before are no longer listed.`,
      restored.length ? `Restored: ${restored.join(", ")}.` : "",
      failed.length ? `Could not restore: ${failed.join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  forget(scope: string) {
    this.scopes.delete(scope);
  }

  private state(scope: string) {
    let state = this.scopes.get(scope);
    if (!state) {
      state = { connected: false };
      this.scopes.set(scope, state);
    }
    return state;
  }
}

function emulationText(value: Record<string, unknown>) {
  const parts = [
    typeof value.colorScheme === "string" && value.colorScheme !== "auto"
      ? `${value.colorScheme} color scheme`
      : undefined,
    typeof value.viewport === "string" ? `device ${value.viewport}` : undefined,
    value.cpuThrottlingRate
      ? `CPU ${value.cpuThrottlingRate}× slower`
      : undefined,
    typeof value.networkConditions === "string"
      ? `network ${value.networkConditions}`
      : undefined,
    value.geolocation ? "geolocation" : undefined,
    value.userAgent ? "user agent" : undefined,
    value.extraHttpHeaders ? "extra headers" : undefined,
  ].filter(Boolean);
  return parts.length ? `emulation (${parts.join(", ")})` : "emulation";
}

function pathOf(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function resultFailed(result: unknown) {
  return Boolean(
    result &&
    typeof result === "object" &&
    (result as { isError?: unknown }).isError === true,
  );
}
