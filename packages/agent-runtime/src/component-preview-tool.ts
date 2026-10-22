import type { CoreSessionConfig } from "@cline/sdk";
import type {
  PreviewRuntimeContext,
  PreviewToolRuntimeOptions,
} from "./preview-harness-tools.js";
import {
  previewToolModelOutput,
  recordSessionScreenshots,
} from "./preview-screenshots.js";
import { previewDevtoolsAgentTimeoutMs } from "./preview-devtools-policy.js";

type AgentTool = NonNullable<CoreSessionConfig["extraTools"]>[number];
type ToolContext = Parameters<AgentTool["execute"]>[1];

// Shows one component on its own: the agent writes a temporary page with
// made-up data, the project's dev server serves it, and this tool opens it
// in the agent's browser, then reports errors and a screenshot. Temporary
// files are named so Git ignores them and finish_task deletes them.

export const componentPreviewFilePatterns = [
  "*.blame-preview.*",
  "blame-preview/",
];
export const componentPreviewPathspecs = [
  ":(glob)**/*.blame-preview.*",
  ":(glob)**/blame-preview/**",
  ":(exclude,glob)**/node_modules/**",
];

type ComponentPreviewInput = {
  colorScheme?: "dark" | "light";
  path: string;
  viewport?: { height: number; width: number };
};

export function componentPreviewPath(value: string) {
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  const [pathname] = value.split(/[?#]/u, 1);
  const segments = pathname.split("/").filter(Boolean);
  if (segments.some((segment) => segment === ".." || segment === "."))
    return false;
  return segments.some(
    (segment) =>
      segment === "blame-preview" || /\.blame-preview\./u.test(segment),
  );
}

export function componentPreviewTool(
  options: PreviewToolRuntimeOptions,
  preview: PreviewRuntimeContext | undefined,
): AgentTool | undefined {
  if (
    !preview?.scope ||
    !options.previewDevtools ||
    !options.previewDevtoolsCall
  )
    return undefined;
  return {
    name: "open_component_preview",
    description:
      "Open a temporary page that shows one component or screen on its own, served by this story's managed preview, in your browser. Write the page first (see the component-preview skill): a `<name>.blame-preview.html` plus `<name>.blame-preview.tsx` for Vite, or `app/blame-preview/<name>/page.tsx` for the Next.js App Router. Pass the path the dev server serves, such as /settings.blame-preview.html?state=empty or /blame-preview/settings. Returns load errors, console errors and a screenshot. Paths outside these temporary names are refused. Temporary files are ignored by Git and removed by finish_task.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Path on the preview's dev server, starting with /. It must contain a *.blame-preview.* file name or a blame-preview/ folder.",
        },
        viewport: {
          type: "object",
          properties: {
            width: { type: "number", minimum: 200, maximum: 4096 },
            height: { type: "number", minimum: 200, maximum: 4096 },
          },
          required: ["width", "height"],
          additionalProperties: false,
        },
        colorScheme: { type: "string", enum: ["light", "dark"] },
      },
      required: ["path"],
      additionalProperties: false,
    },
    // It drives the browser through several calls, each bounded by the
    // desktop service; Cline's 30 s default would cut a slow first load.
    retryable: false,
    timeoutMs: previewDevtoolsAgentTimeoutMs(),
    execute: (input: unknown, context: ToolContext) =>
      openComponentPreview(options, preview, input, context),
  };
}

async function openComponentPreview(
  options: PreviewToolRuntimeOptions,
  preview: PreviewRuntimeContext,
  value: unknown,
  context: ToolContext,
) {
  const input = parsedInput(value);
  if (!input.ok) return failure(input.message);
  const signal = context.signal;
  const target = await options.previewDevtools!({
    ...preview,
    signal,
    waitFor: "ready",
  });
  if (!target || target.status !== "ready" || !target.available)
    return failure(
      `The managed preview is not ready (${target?.status ?? "unavailable"}): ${target?.message ?? "no preview state"}. Fix the preview first; open_component_preview needs its dev server.`,
    );
  const sessionId = context.sessionId ?? context.conversationId;
  const call = (toolName: string, args: Record<string, unknown> = {}) =>
    options.previewDevtoolsCall!({
      ...preview,
      arguments: args,
      signal,
      toolName,
      ...(context.runId || sessionId
        ? { runId: context.runId ?? sessionId }
        : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
    });
  const emulation = {
    ...(input.value.colorScheme
      ? { colorScheme: input.value.colorScheme }
      : {}),
    ...(input.value.viewport
      ? {
          viewport: `${input.value.viewport.width}x${input.value.viewport.height}x1`,
        }
      : {}),
  };
  if (Object.keys(emulation).length) {
    const emulated = await call("emulate", emulation);
    if (isError(emulated))
      return failure(`Emulation failed: ${resultText(emulated)}`);
  }
  const opened = await call("navigate_page", {
    type: "url",
    url: input.value.path,
  });
  if (isError(opened))
    return failure(`The page did not open: ${resultText(opened)}`);
  const overlay = await call("evaluate_script", { function: overlayProbe });
  const consoleErrors = await call("list_console_messages", {
    types: ["error"],
  });
  const screenshot = await call("take_screenshot", { format: "png" });
  const output = previewToolModelOutput(screenshot);
  recordSessionScreenshots(sessionId, output);
  const report = [
    `Opened ${input.value.path}${describeEmulation(input.value)}.`,
    `Error overlay: ${overlayText(overlay)}.`,
    `Console errors:${consoleText(consoleErrors)}`,
  ].join("\n");
  return Array.isArray(output)
    ? [{ type: "text", text: report }, ...output]
    : {
        content: [
          { type: "text", text: `${report}\n${resultText(screenshot)}` },
        ],
      };
}

// Vite and Next.js render compile errors in an overlay element.
const overlayProbe = `() => {
  const vite = document.querySelector("vite-error-overlay");
  if (vite) return { overlay: "vite", message: (vite.shadowRoot?.querySelector(".message")?.textContent ?? "").slice(0, 800) };
  const next = document.querySelector("nextjs-portal")?.shadowRoot;
  const dialog = next?.querySelector("[data-nextjs-dialog], [data-nextjs-error-overlay-nav], .nextjs-container-errors-header");
  if (dialog) return { overlay: "next", message: (dialog.textContent ?? "").slice(0, 800) };
  return { overlay: null };
}`;

function overlayText(result: unknown) {
  const text = resultText(result);
  const overlay = text.match(/"overlay"\s*:\s*"(vite|next)"/u)?.[1];
  if (!overlay) return isError(result) ? "unknown" : "none";
  const message = text.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/u)?.[1] ?? "";
  return `${overlay === "vite" ? "Vite" : "Next.js"} shows an error: ${message.replaceAll("\\n", " ").slice(0, 400)}`;
}

function consoleText(result: unknown) {
  const lines = resultText(result)
    .split("\n")
    .filter((line) => /^msgid=/u.test(line.trim()));
  return lines.length ? `\n${lines.slice(0, 20).join("\n")}` : " none.";
}

function describeEmulation(input: ComponentPreviewInput) {
  const parts = [
    input.viewport
      ? `${input.viewport.width}×${input.viewport.height}`
      : undefined,
    input.colorScheme,
  ].filter(Boolean);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

function parsedInput(
  value: unknown,
): { ok: true; value: ComponentPreviewInput } | { message: string; ok: false } {
  const record = recordValue(value);
  const path = typeof record.path === "string" ? record.path.trim() : "";
  if (!componentPreviewPath(path))
    return {
      ok: false,
      message: `open_component_preview only opens temporary preview pages: a path with a *.blame-preview.* file name or a blame-preview/ folder, such as /settings.blame-preview.html or /blame-preview/settings. Got: ${path || "(empty)"}`,
    };
  const viewport = recordValue(record.viewport);
  const width = Number(viewport.width);
  const height = Number(viewport.height);
  const colorScheme = record.colorScheme;
  return {
    ok: true,
    value: {
      path,
      ...(record.viewport !== undefined &&
      Number.isFinite(width) &&
      Number.isFinite(height)
        ? {
            viewport: {
              height: Math.min(Math.max(Math.round(height), 200), 4096),
              width: Math.min(Math.max(Math.round(width), 200), 4096),
            },
          }
        : {}),
      ...(colorScheme === "dark" || colorScheme === "light"
        ? { colorScheme }
        : {}),
    },
  };
}

function failure(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function isError(result: unknown) {
  return recordValue(result).isError === true;
}

function resultText(result: unknown) {
  const content = recordValue(result).content;
  return Array.isArray(content)
    ? content
        .map((block) => {
          const item = recordValue(block);
          return item.type === "text" && typeof item.text === "string"
            ? item.text
            : "";
        })
        .filter(Boolean)
        .join("\n")
    : "";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
