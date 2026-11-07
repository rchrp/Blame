import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  componentPreviewRenders,
  parseComponentPreviewRequest,
  type ComponentPreviewRender,
  type ComponentPreviewTheme,
} from "@blame/agent-runtime";
import type { ScreenshotCaptureContext } from "../agent-screenshots/agent-screenshot-capture.ts";
import type { ComponentPreviewHost } from "./component-preview-hosts.ts";
import {
  componentPreviewToolkitPlugin,
  type ComponentPreviewAngularReport,
  type ComponentPreviewToolkit,
} from "./component-preview-server-script.ts";
import type {
  ComponentPreviewServer,
  ComponentPreviewServerStart,
} from "./component-preview-server.ts";

// open_component_preview, on the desktop side. One temporary Vite server
// per worktree, started on the first call and reused by the next ones,
// renders in a page of its own: the story's preview page, if any, is never
// navigated nor emulated. The server stops at finish_task, when the run is
// cancelled or ends, after ten minutes without a call, and when Blame quits.
// For a cloud preview it runs in the preview's sandbox.

export type ComponentPreviewTarget = {
  scope?: string;
  // The story whose cloud preview hosts the server.
  storyId?: string;
  workspaceMode?: "cloud-mirror" | "direct" | "local-container";
  worktree: string;
};

export type ComponentPreviewRenderInput = ComponentPreviewTarget & {
  request: unknown;
  runId?: string;
  sessionId?: string;
  toolCallId?: string;
};

export type ComponentPreviewCapture = {
  consoleErrors: string[];
  image?: Buffer;
  // What the page reported, or why it could not render.
  message?: string;
  // The text of the Vite error overlay, when the page shows one.
  overlay?: string;
  status: "error" | "ready" | "timeout";
  url: string;
  viewport: { height: number; width: number };
};

// A page of the agent's browser, used only by component previews.
export type ComponentPreviewPage = {
  capture(input: {
    theme: ComponentPreviewTheme;
    timeoutMs: number;
    url: string;
    width: number;
  }): Promise<ComponentPreviewCapture>;
  close(): void;
};

export type ComponentPreviewBrowser = {
  // A new page that may only load `origin`.
  openPage(origin: string): Promise<ComponentPreviewPage>;
};

export type ComponentPreviewLocation =
  | {
      host: ComponentPreviewHost;
      // Worktree-relative package directory, "" for the worktree root.
      packageDir: string;
      // Blame's own Vite, for a React, Vue, Nuxt, Svelte or Angular package
      // without a Vite config.
      toolkit?: Pick<ComponentPreviewToolkit, "framework">;
    }
  | { message: string };

export type ComponentPreviewDependencies = {
  browser(): Promise<ComponentPreviewBrowser>;
  idleMs?: number;
  locate(
    target: ComponentPreviewTarget,
    file: string,
  ): Promise<ComponentPreviewLocation>;
  startServer?(input: ComponentPreviewServerStart): Promise<RunningServer>;
  storeScreenshots(
    result: unknown,
    context: ScreenshotCaptureContext,
  ): Promise<unknown>;
};

type RunningServer = Pick<
  ComponentPreviewServer,
  | "angular"
  | "notes"
  | "origin"
  | "pageUrl"
  | "running"
  | "stop"
  | "toolkit"
  | "viteVersion"
>;

type Running = {
  description: string;
  idleTimer?: NodeJS.Timeout;
  key: string;
  page?: ComponentPreviewPage;
  server: RunningServer;
  sessions: Set<string>;
};

export const componentPreviewIdleMs = 10 * 60_000;
// The server's own fallback, past Blame's idle stop.
const serverIdleMs = componentPreviewIdleMs + 60_000;
const firstRenderTimeoutMs = 90_000;
const renderTimeoutMs = 30_000;

export class ComponentPreviewService {
  private readonly dependencies: ComponentPreviewDependencies;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly running = new Map<string, Running>();

  constructor(dependencies: ComponentPreviewDependencies) {
    this.dependencies = dependencies;
  }

  // Calls for the same worktree run one after the other.
  render(input: ComponentPreviewRenderInput, signal?: AbortSignal) {
    const previous = this.queues.get(input.worktree) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.renderNow(input, signal));
    const settled = next.catch(() => undefined);
    this.queues.set(input.worktree, settled);
    void settled.then(() => {
      if (this.queues.get(input.worktree) === settled)
        this.queues.delete(input.worktree);
    });
    return next;
  }

  // Stops the servers of a worktree, or those a session used. Returns how
  // many stopped.
  async stop(selector: { sessionId?: string; worktree?: string }) {
    const worktrees = [...this.running.entries()]
      .filter(
        ([worktree, running]) =>
          worktree === selector.worktree ||
          (selector.sessionId !== undefined &&
            running.sessions.has(selector.sessionId)),
      )
      .map(([worktree]) => worktree);
    await Promise.all(worktrees.map((worktree) => this.close(worktree)));
    return worktrees.length;
  }

  async shutdown() {
    await Promise.all([...this.running.keys()].map((key) => this.close(key)));
  }

  // Whether a server runs for this worktree.
  serving(worktree: string) {
    return this.running.has(worktree);
  }

  private async renderNow(
    input: ComponentPreviewRenderInput,
    signal?: AbortSignal,
  ) {
    const parsed = parseComponentPreviewRequest(input.request);
    if (!parsed.ok) return failure(parsed.message);
    const request = parsed.value;
    const location = await this.dependencies.locate(input, request.file);
    if ("message" in location) return failure(location.message);
    const opened = await this.server(input, location, signal);
    if ("message" in opened) return failure(opened.message);
    const { running, started } = opened;
    if (input.sessionId) running.sessions.add(input.sessionId);
    const file = posix.relative(location.packageDir || ".", request.file);
    const renders = componentPreviewRenders(request);
    const content: unknown[] = [
      {
        type: "text",
        text: `${serverSummary(running, started, location)} ${renders.length} ${renders.length === 1 ? "render" : "renders"} of ${request.file}:`,
      },
    ];
    const screenshots: unknown[] = [];
    try {
      for (const [index, render] of renders.entries()) {
        signal?.throwIfAborted();
        const capture = await this.capture(running, {
          render,
          timeoutMs:
            started && index === 0 ? firstRenderTimeoutMs : renderTimeoutMs,
          url: running.server.pageUrl({
            file,
            fresh: index === 0,
            state: render.state,
            theme: render.theme,
          }),
        });
        content.push({
          type: "text",
          text: renderReport(index, renders.length, render, capture),
        });
        if (!capture.image) continue;
        const stored = recordValue(
          await this.dependencies.storeScreenshots(
            {
              content: [
                {
                  data: capture.image.toString("base64"),
                  mimeType: "image/png",
                  type: "image",
                },
              ],
            },
            {
              page: {
                colorScheme: render.theme,
                url: capture.url,
                viewport: capture.viewport,
              },
              ...(input.runId ? { runId: input.runId } : {}),
              scope: input.scope ?? `component-preview:${input.worktree}`,
              ...(input.sessionId ? { sessionId: input.sessionId } : {}),
              ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
            },
          ),
        );
        content.push(...arrayValue(stored.content));
        screenshots.push(
          ...arrayValue(recordValue(stored._meta).blameScreenshots),
        );
      }
    } finally {
      this.keepAlive(input.worktree, running);
    }
    return {
      content,
      _meta: { blameScreenshots: screenshots },
      ...(screenshots.length ? {} : { isError: true }),
    };
  }

  private async server(
    input: ComponentPreviewRenderInput,
    location: Extract<ComponentPreviewLocation, { host: unknown }>,
    signal?: AbortSignal,
  ): Promise<{ running: Running; started: boolean } | { message: string }> {
    const key = `${location.host.key}:${location.packageDir}:${location.toolkit?.framework ?? "vite"}`;
    const current = this.running.get(input.worktree);
    if (current?.key === key && current.server.running)
      return { running: current, started: false };
    if (current) await this.close(input.worktree);
    const start =
      this.dependencies.startServer ??
      (async (options: ComponentPreviewServerStart) =>
        (
          await import("./component-preview-server.ts")
        ).ComponentPreviewServer.start(options));
    let server: RunningServer;
    try {
      server = await start({
        cacheName: `blame-preview-${createHash("sha256").update(input.worktree).digest("hex").slice(0, 12)}`,
        host: location.host,
        idleMs: serverIdleMs,
        packageDir: location.packageDir,
        signal,
        ...(location.toolkit ? { toolkit: location.toolkit } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      return {
        message: `The component preview server did not start in ${location.host.description}: ${errorMessage(error)}`,
      };
    }
    const running: Running = {
      description: location.host.description,
      key,
      server,
      sessions: new Set(),
    };
    this.running.set(input.worktree, running);
    return { running, started: true };
  }

  private async capture(
    running: Running,
    input: { render: ComponentPreviewRender; timeoutMs: number; url: string },
  ): Promise<ComponentPreviewCapture> {
    try {
      running.page ??= await (
        await this.dependencies.browser()
      ).openPage(running.server.origin);
      return await running.page.capture({
        theme: input.render.theme,
        timeoutMs: input.timeoutMs,
        url: input.url,
        width: input.render.width,
      });
    } catch (error) {
      // The next render opens a new page.
      running.page?.close();
      running.page = undefined;
      return {
        consoleErrors: [],
        message: `The browser could not render the page: ${errorMessage(error)}`,
        status: "error",
        url: input.url,
        viewport: { height: 0, width: input.render.width },
      };
    }
  }

  private keepAlive(worktree: string, running: Running) {
    if (this.running.get(worktree) !== running) return;
    if (running.idleTimer) clearTimeout(running.idleTimer);
    running.idleTimer = setTimeout(
      () => void this.close(worktree),
      this.dependencies.idleMs ?? componentPreviewIdleMs,
    );
    running.idleTimer.unref?.();
  }

  private async close(worktree: string) {
    const running = this.running.get(worktree);
    if (!running) return;
    this.running.delete(worktree);
    if (running.idleTimer) clearTimeout(running.idleTimer);
    running.page?.close();
    running.page = undefined;
    await running.server.stop();
  }
}

export function renderReport(
  index: number,
  count: number,
  render: ComponentPreviewRender,
  capture: ComponentPreviewCapture,
) {
  const outcome =
    capture.status === "ready"
      ? "rendered."
      : capture.status === "timeout"
        ? `did not finish rendering in time${capture.message ? `: ${capture.message}` : "."}`
        : `the page reported an error: ${capture.message ?? "unknown error"}`;
  return [
    `Render ${index + 1}/${count} — ${render.state}, ${render.theme}, ${render.width} px: ${outcome}`,
    `Error overlay: ${capture.overlay ? `Vite shows an error: ${capture.overlay}` : "none"}.`,
    capture.consoleErrors.length
      ? `Console errors:\n${capture.consoleErrors.map((line) => `- ${line}`).join("\n")}`
      : "Console errors: none.",
  ].join("\n");
}

function failure(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}

// Which Vite serves the renders, and what Blame added when it is its own.
function serverSummary(
  running: Running,
  started: boolean,
  location: Extract<ComponentPreviewLocation, { host: unknown }>,
) {
  const { server } = running;
  const verb = started ? "Started" : "Reused";
  const where = `in ${running.description} for ${location.packageDir || "the worktree root"}, at ${server.origin}`;
  if (!server.toolkit || !location.toolkit)
    return `${verb} a Vite ${server.viteVersion} server ${where}.`;
  const { framework } = location.toolkit;
  const shims =
    framework === "next"
      ? ", with shims for next/link, next/image, next/navigation and next/font"
      : framework === "react-native"
        ? ", with react-native resolved to react-native-web, .web.* files first and __DEV__ set"
        : framework === "nuxt"
          ? ", Nuxt's auto-imports and shims for <NuxtLink>, @nuxt/image, useRoute, useRouter, navigateTo, useHead, useRuntimeConfig and useState"
          : "";
  const applies =
    framework === "nuxt"
      ? "its nuxt.config and PostCSS config apply"
      : "its PostCSS config and tsconfig or jsconfig paths apply";
  const vueCli =
    framework === "vue" ? " In a Vue CLI package, @/ resolves to src/." : "";
  const svelte =
    framework === "svelte"
      ? " The package's own Svelte compiles its components, with its svelte.config.* if it has one."
      : "";
  const angular = server.angular ? ` ${angularSummary(server.angular)}` : "";
  const notes = server.notes?.length ? ` ${server.notes.join(" ")}` : "";
  const installed =
    started && server.toolkit.installed
      ? ` Blame installed this Vite first, once for this environment, in ${server.toolkit.directory}.`
      : "";
  return `${verb} Blame's own Vite ${server.viteVersion} server with ${componentPreviewToolkitPlugin(framework).name}${shims}, ${where}: the package has no Vite config, so ${applies}.${vueCli}${svelte}${angular}${notes}${installed}`;
}

// What the Angular compiler compiles with, and how the page runs change
// detection.
function angularSummary(angular: ComponentPreviewAngularReport) {
  const zone = angular.zone
    ? "zone.js loads first, from its polyfills"
    : "its polyfills have no zone.js, so the render is zoneless";
  const problem = angular.problem ? ` ${angular.problem}.` : "";
  return `The project's Angular ${angular.version} compiler compiles its components with ${angular.tsconfig}; ${zone}.${problem}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
