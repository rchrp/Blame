import { previewNavigationAllowed } from "../preview-browser/preview-navigation-policy.ts";
import {
  emulationInput,
  emulationState,
  type EmulationState,
} from "./preview-devtools-emulation.ts";

// What the agent set on its browser page, per preview scope, so a new
// connection can put it back: after a timeout reset, a crash, or the
// browser reopening. A dropped CDP connection loses the emulation it set.

export type PreviewReconnectReason =
  "browser" | "cancelled" | "connection" | "preview" | "replaced" | "timeout";

type ScopeState = {
  closedBecause?: PreviewReconnectReason;
  connected: boolean;
  emulation: EmulationState;
  url?: string;
};

export type PreviewRestore = {
  emulate(value: EmulationState): Promise<unknown>;
  navigate(url: string): Promise<unknown>;
};

const reasonText: Record<PreviewReconnectReason, string> = {
  browser:
    "because the preview browser closed (idle, crash or restart) and was reopened",
  cancelled: "after the previous call was cancelled",
  connection: "after the browser connection dropped",
  preview: "after the preview was unavailable",
  replaced: "because the preview page changed",
  timeout: "after the previous call ran out of time",
};

export class PreviewDevtoolsPageState {
  private readonly scopes = new Map<string, ScopeState>();

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
    pageUrl: string | undefined,
  ) {
    const state = this.state(scope);
    // A Chromium error page (dev server down) is not a page to come back to.
    if (pageUrl && /^https?:/iu.test(pageUrl)) state.url = pageUrl;
    if (toolName === "emulate")
      state.emulation = emulationState(
        state.emulation,
        emulationInput(argumentsValue),
      );
  }

  // Put the page back as the agent left it, and say what happened.
  async restore(
    scope: string,
    reason: PreviewReconnectReason,
    restore: PreviewRestore,
    page: { origin?: string; url?: string },
  ) {
    const state = this.state(scope);
    const restored: string[] = [];
    const failed: string[] = [];
    const attempt = async (label: string, run: () => Promise<unknown>) => {
      try {
        await run();
        restored.push(label);
      } catch {
        failed.push(label);
      }
    };
    if (Object.keys(state.emulation).length)
      await attempt(emulationText(state.emulation), () =>
        restore.emulate(state.emulation),
      );
    if (state.url && state.url !== page.url) {
      const url = state.url;
      if (previewNavigationAllowed(url, page.origin))
        await attempt(`page ${pathOf(url)}`, () => restore.navigate(url));
      else failed.push(`page ${url} (no longer on this preview)`);
    }
    return [
      `Note: the browser was reconnected ${reasonText[reason]}. Console messages and network requests from before are no longer listed.`,
      restored.length ? `Restored: ${restored.join(", ")}.` : "",
      failed.length ? `Could not restore: ${failed.join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  private state(scope: string) {
    let state = this.scopes.get(scope);
    if (!state) {
      state = { connected: false, emulation: {} };
      this.scopes.set(scope, state);
    }
    return state;
  }
}

function emulationText(value: EmulationState) {
  const parts = [
    value.device ? `device ${value.device}` : undefined,
    value.viewport
      ? `viewport ${value.viewport.width}×${value.viewport.height}`
      : undefined,
    value.colorScheme ? `${value.colorScheme} color scheme` : undefined,
    value.offline ? "offline" : undefined,
    value.geolocation ? "geolocation" : undefined,
  ].filter(Boolean);
  return `emulation (${parts.join(", ")})`;
}

function pathOf(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}
