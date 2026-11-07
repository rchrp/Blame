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
// preview_devtools__* drives. A cloud preview's server runs in its sandbox.
// Preview files are ignored by Git and finish_task removes them and stops
// the server.

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
  "Write one file `<name>.blame-preview.tsx` in the package of the component (the folder with its package.json). It imports the component and the app's global stylesheet, and exports each state as a React element, for example `export default <Settings items={sample} />` and `export const empty = <Settings items={[]} />`; the state `default` is the default export.",
  "For Vue, Angular, Svelte or another framework, write `<name>.blame-preview.ts` and export `mount(element, state)` instead: it renders the named state into the element, for Vue with `createApp(Component, props).mount(element)`, for Svelte with `mount(Component, { target: element, props })`, for Angular with `createApplication({ providers })` then `createComponent(Component, { environmentInjector: app.injector, hostElement: element })`.",
  "No HTML page or route to write: a temporary Vite server, started on the first call and reused for the session, generates them. A package with a vite.config.* uses its own Vite and config (aliases, plugins, Tailwind, CSS). A SvelteKit app keeps its own Vite and sveltekit() ($lib or #lib, $env and $app/env): $app/state, and $app/stores before SvelteKit 3, give a page at /, and its public environment variables reach the page; SvelteKit's router does not run. A React package without Vite, such as a Next.js app, gets Blame's own Vite with @vitejs/plugin-react, its PostCSS or Tailwind config and tsconfig or jsconfig paths; next/link, next/image, next/navigation and next/font become small shims in this server only. A React Native package with react-native-web, such as an Expo app with web support, gets Blame's own Vite with @vitejs/plugin-react: react-native resolves to react-native-web, .web.* files come first, __DEV__ is set and EXPO_PUBLIC_* variables reach process.env; without react-native-web it is not rendered, and an Expo module without a web implementation is named in the page's error: check those in the app or on a device. A Vue 3 package without Vite, such as a Vue CLI app, gets Blame's own Vite with @vitejs/plugin-vue: .vue files with their <style> and <style scoped> blocks, its PostCSS or Tailwind config, tsconfig or jsconfig paths, and Vue CLI's @ alias for src; Vue 2 is not supported. A Svelte 5 package without Vite, such as a Rollup or webpack app, gets Blame's own Vite with @sveltejs/vite-plugin-svelte, compiled by the package's own Svelte (5.46.4 or later) with its svelte.config.*, its PostCSS or Tailwind config and tsconfig or jsconfig paths; Svelte 4 is not supported. An Angular 17 to 22 package without Vite, such as an Angular CLI app, gets Blame's own Vite with @analogjs/vite-plugin-angular, which compiles with the project's Angular compiler and the tsconfig of angular.json: templateUrl and styleUrl files, its PostCSS or Tailwind config and tsconfig paths; the preview file imports the stylesheets of the styles field of angular.json. zone.js loads first when the polyfills of angular.json include it, otherwise the render is zoneless. It never installs the project's dependencies, and runs whatever the story's workspace: managed preview, project folder or desktop app. In a cloud preview it runs in the preview's sandbox, where the dependencies are installed, once the preview is started.",
  "Only client components render: a Server Component (an async component, or one importing server-only modules such as next/headers) is reported as such; preview one of its client sub-components with made-up props, or check that screen in the app.",
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
