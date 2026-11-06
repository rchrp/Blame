import type { CoreSessionConfig } from "@cline/sdk";
import {
  componentPreviewDefaultWidth,
  componentPreviewFilePattern,
  componentPreviewMaximumRenders,
  componentPreviewWidthRange,
  parseComponentPreviewRequest,
  type ComponentPreviewRequest,
} from "./component-preview-request.js";
import type {
  PreviewRuntimeContext,
  PreviewToolRuntimeOptions,
} from "./preview-harness-tools.js";
import {
  previewToolModelOutput,
  recordSessionScreenshots,
} from "./preview-screenshots.js";
import { previewDevtoolsAgentTimeoutMs } from "./preview-devtools-policy.js";
import { limitToolText, toolOutputLimits } from "./tool-output-limit.js";

type AgentTool = NonNullable<CoreSessionConfig["extraTools"]>[number];
type ToolContext = Parameters<AgentTool["execute"]>[1];

// Shows one component on its own. The agent writes one preview file that
// exports its states; the desktop starts a temporary Vite server for the
// story, renders each state, theme and width in a page of its own and
// returns the screenshots with the errors each render reported. The
// story's managed preview, if any, keeps running and keeps the page that
// preview_devtools__* drives. Preview files are ignored by Git and
// finish_task removes them and stops the server.

export const componentPreviewFilePatterns = [componentPreviewFilePattern];
export const componentPreviewPathspecs = [
  ":(glob)**/*.blame-preview.*",
  ":(exclude,glob)**/node_modules/**",
];

type ComponentPreviewTarget = {
  projectId?: string;
  scope?: string;
  storyId?: string;
  workspaceMode?: PreviewRuntimeContext["workspaceMode"];
  worktree: string;
};

export type ComponentPreviewHostInput =
  | (ComponentPreviewTarget & {
      action: "render";
      request: ComponentPreviewRequest;
      runId?: string;
      sessionId?: string;
      signal?: AbortSignal;
      toolCallId?: string;
    })
  | {
      action: "stop";
      sessionId?: string;
      signal?: AbortSignal;
      worktree: string;
    };

const description = [
  "Render one component or screen on its own, with made-up data, and get one screenshot per render with its Vite error overlay and console errors.",
  "Use it after creating a UI component or changing how one renders, even when the app's preview is available: one call shows its main states (default, empty, error, loading, long content), dark mode and a mobile width. Check in the app alone only when this costs more: heavy fakes for a state the app already shows, or a change to the screen's integration rather than the component's rendering.",
  "Write one file `<name>.blame-preview.tsx` in the package of the component (the folder with its package.json and vite.config.*). It imports the component and the app's global stylesheet, and exports each state as a React element, for example `export default <Settings items={sample} />` and `export const empty = <Settings items={[]} />`; the state `default` is the default export.",
  "For Vue, Svelte or another framework, export `mount(element, state)` instead: it renders the named state into the element.",
  "No HTML page or route to write: a temporary Vite server, started on the first call and reused for the session, generates them. It uses the package's own Vite config (aliases, plugins, Tailwind, CSS) and the Vite installed in the project, never installs anything, and runs whatever the story's workspace: managed preview, project folder or desktop app.",
  `One call renders every combination of states, themes and widths, at most ${componentPreviewMaximumRenders}. The dark theme emulates prefers-color-scheme and sets the \`dark\` class, data-theme and color-scheme on <html>.`,
  "After editing the file or the component, call again to see the change. The story's own preview keeps running: preview_devtools__* still drives it, unchanged by this tool.",
  "The file is ignored by Git; finish_task deletes it and stops the server. Attach the useful screenshots to finish_task with their screenshot:<id> references; each caption says whether it shows the isolated component or the app.",
].join(" ");

export function componentPreviewTool(
  options: PreviewToolRuntimeOptions,
  preview: PreviewRuntimeContext | undefined,
): AgentTool | undefined {
  if (!options.componentPreview || !preview?.componentPreview) return undefined;
  const { maximum, minimum } = componentPreviewWidthRange;
  return {
    name: "open_component_preview",
    description,
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description:
            "Path of the preview file relative to the worktree, such as packages/app/src/settings.blame-preview.tsx. Its name must end in .blame-preview.tsx (or .jsx, .ts, .js, .mts, .mjs).",
        },
        states: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: componentPreviewMaximumRenders,
          default: ["default"],
          description:
            'Names of the exports to render, such as ["default", "empty", "error"]. With mount(element, state), the names passed to it.',
        },
        themes: {
          type: "array",
          items: { type: "string", enum: ["light", "dark"] },
          minItems: 1,
          maxItems: 2,
          default: ["light"],
        },
        widths: {
          type: "array",
          items: { type: "integer", minimum, maximum },
          minItems: 1,
          maxItems: componentPreviewMaximumRenders,
          default: [componentPreviewDefaultWidth],
          description:
            "Viewport widths in CSS pixels, such as [390, 1280]. The screenshot covers the page's full height.",
        },
      },
      required: ["file"],
      additionalProperties: false,
    },
    // The first call starts the server and pre-bundles the preview's
    // dependencies; the desktop bounds each step itself.
    retryable: false,
    timeoutMs: previewDevtoolsAgentTimeoutMs(),
    execute: async (input: unknown, context: ToolContext) =>
      limitToolText(
        await renderComponentPreview(options, preview, input, context),
        toolOutputLimits.componentPreview,
      ),
  };
}

async function renderComponentPreview(
  options: PreviewToolRuntimeOptions,
  preview: PreviewRuntimeContext,
  value: unknown,
  context: ToolContext,
) {
  const request = parseComponentPreviewRequest(value);
  if (!request.ok)
    return {
      content: [{ type: "text", text: request.message }],
      isError: true,
    };
  const sessionId = context.sessionId ?? context.conversationId;
  const result = await options.componentPreview!({
    action: "render",
    request: request.value,
    signal: context.signal,
    worktree: preview.worktree,
    ...(preview.workspaceMode ? { workspaceMode: preview.workspaceMode } : {}),
    ...(preview.scope ? { scope: preview.scope } : {}),
    ...(preview.storyId ? { storyId: preview.storyId } : {}),
    ...(preview.projectId ? { projectId: preview.projectId } : {}),
    ...(context.runId || sessionId
      ? { runId: context.runId ?? sessionId }
      : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
  });
  const output = previewToolModelOutput(result);
  recordSessionScreenshots(sessionId, output);
  return output;
}
