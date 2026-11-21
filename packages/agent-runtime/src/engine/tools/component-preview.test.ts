import assert from "node:assert/strict";
import test from "node:test";
import {
  componentPreviewFile,
  componentPreviewRenders,
  parseComponentPreviewRequest,
} from "../../component-preview-request.js";
import { sessionScreenshotIds } from "../../preview-screenshots.js";
import type { ToolContentBlock } from "../tool.js";
import { componentPreviewTool } from "./component-preview.js";
import { previewClientTools } from "./preview.js";
import type { ComponentPreviewHostInput } from "./preview-types.js";
import { callThroughToolSet, toolContext } from "./testing.js";

const context = toolContext({ session: "preview-session", call: "call-1" });
const preview = {
  componentPreview: true,
  scope: "story:1",
  workspaceMode: "local-container" as const,
  worktree: "/workspace",
};

function fakeDesktop(result: (input: ComponentPreviewHostInput) => unknown) {
  const calls: ComponentPreviewHostInput[] = [];
  return {
    calls,
    options: {
      componentPreview: async (input: ComponentPreviewHostInput) => {
        calls.push(input);
        return result(input);
      },
    },
  };
}

// What the desktop returns: one stored screenshot per render.
function rendered(count: number) {
  const ids = Array.from({ length: count }, (_, index) =>
    String(index + 1).repeat(64),
  );
  return {
    content: [
      { type: "text", text: `Started a Vite 8.3.6 server. ${count} renders:` },
      ...ids.flatMap((id, index) => [
        {
          type: "text",
          text: `Render ${index + 1}/${count} — default, light, 1280 px: rendered.\nError overlay: none.\nConsole errors: none.`,
        },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "text", text: `Screenshot saved as screenshot:${id}.` },
      ]),
    ],
    _meta: {
      blameScreenshots: ids.map((id) => ({
        colorScheme: "light",
        height: 900,
        id,
        mimeType: "image/png",
        pageUrl: "http://127.0.0.1:5123/__blame_component_preview__/t",
        viewport: { height: 900, width: 1280 },
        width: 1280,
      })),
    },
  };
}

test("only preview files inside the worktree are accepted", () => {
  for (const [path, expected] of [
    ["settings.blame-preview.tsx", "settings.blame-preview.tsx"],
    [
      "./packages/app/src/dialog.blame-preview.jsx",
      "packages/app/src/dialog.blame-preview.jsx",
    ],
    [
      "packages\\app\\card.blame-preview.ts",
      "packages/app/card.blame-preview.ts",
    ],
  ])
    assert.equal(componentPreviewFile(path), expected, path);
  for (const path of [
    "",
    "settings.tsx",
    "settings.blame-preview.html",
    ".blame-preview.tsx",
    "/abs/settings.blame-preview.tsx",
    "C:/abs/settings.blame-preview.tsx",
    "../outside/settings.blame-preview.tsx",
    "node_modules/pkg/x.blame-preview.tsx",
    "app/blame-preview/settings/page.tsx",
  ])
    assert.equal(componentPreviewFile(path), undefined, path);
});

test("a call defaults to the default state, the light theme and one width", () => {
  const parsed = parseComponentPreviewRequest({
    file: "src/card.blame-preview.tsx",
  });
  assert.deepEqual(parsed, {
    ok: true,
    value: {
      file: "src/card.blame-preview.tsx",
      states: ["default"],
      themes: ["light"],
      widths: [1280],
    },
  });
});

test("one call renders every combination, at most six", () => {
  const six = parseComponentPreviewRequest({
    file: "card.blame-preview.tsx",
    states: ["default", "empty", "error"],
    themes: ["light", "dark"],
  });
  assert.ok(six.ok);
  assert.deepEqual(
    componentPreviewRenders(six.value).map(
      ({ state, theme, width }) => `${state}/${theme}/${width}`,
    ),
    [
      "default/light/1280",
      "default/dark/1280",
      "empty/light/1280",
      "empty/dark/1280",
      "error/light/1280",
      "error/dark/1280",
    ],
  );
  const eight = parseComponentPreviewRequest({
    file: "card.blame-preview.tsx",
    states: ["default", "empty"],
    themes: ["light", "dark"],
    widths: [390, 1280],
  });
  assert.equal(eight.ok, false);
  assert.match(
    (eight as { message: string }).message,
    /make 8 renders; one call renders at most 6/u,
  );
});

test("states, themes and widths outside the contract are refused", () => {
  for (const request of [
    { states: [] },
    { states: ["has space"] },
    { themes: ["sepia"] },
    { widths: [199] },
    { widths: [4097] },
    { widths: [390.5] },
  ]) {
    const parsed = parseComponentPreviewRequest({
      file: "card.blame-preview.tsx",
      ...request,
    });
    assert.equal(parsed.ok, false, JSON.stringify(request));
  }
});

test("an invalid call is refused without asking the desktop", async () => {
  const desktop = fakeDesktop(() => rendered(1));
  const tool = componentPreviewTool(desktop.options, preview)!;
  const result = (await tool.run(
    { file: "/dialog.blame-preview.html?state=empty" } as never,
    context,
  )) as { content: Array<{ text: string }>; ok: boolean };
  assert.equal(result.ok, false);
  assert.match(result.content[0]!.text, /\.blame-preview\.tsx/u);
  assert.deepEqual(desktop.calls, []);
});

test("one call returns a screenshot per render and records them for finish_task", async () => {
  const desktop = fakeDesktop(() => rendered(4));
  const tool = componentPreviewTool(desktop.options, preview)!;
  const output = (
    (await tool.run(
      {
        file: "packages/app/src/card.blame-preview.tsx",
        states: ["default", "empty"],
        themes: ["light", "dark"],
      } as never,
      context,
    )) as { content: ToolContentBlock[] }
  ).content;
  assert.equal(desktop.calls.length, 1);
  const call = desktop.calls[0] as Extract<
    ComponentPreviewHostInput,
    { action: "render" }
  >;
  assert.equal(call.action, "render");
  assert.equal(call.worktree, "/workspace");
  assert.equal(call.scope, "story:1");
  assert.equal(call.sessionId, "preview-session");
  assert.equal(call.toolCallId, "call-1");
  assert.deepEqual(call.request, {
    file: "packages/app/src/card.blame-preview.tsx",
    states: ["default", "empty"],
    themes: ["light", "dark"],
    widths: [1280],
  });
  const images = output.filter((block) => block.type === "image");
  assert.equal(images.length, 4);
  assert.ok(
    images.every(
      (image) => "mediaType" in image && image.mediaType === "image/png",
    ),
  );
  for (const id of ["1", "2", "3", "4"].map((digit) => digit.repeat(64)))
    assert.ok(sessionScreenshotIds("preview-session").has(id), id);
});

test("the tool exists only where the desktop offers it, in every workspace mode", () => {
  const desktop = fakeDesktop(() => rendered(1));
  const offered = (
    workspaceMode: "cloud-mirror" | "direct" | "local-container",
    componentPreview: boolean,
  ) =>
    componentPreviewTool(desktop.options, {
      componentPreview,
      workspaceMode,
      worktree: "/p",
    })?.name === "open_component_preview";
  assert.ok(offered("direct", true));
  assert.ok(offered("local-container", true));
  assert.ok(offered("cloud-mirror", true));
  assert.ok(!offered("local-container", false));
  assert.equal(componentPreviewTool({}, preview), undefined);
});

test("the tool says when to use it, not only how", () => {
  const desktop = fakeDesktop(() => rendered(1));
  const { description } = componentPreviewTool(desktop.options, preview)!;
  assert.match(
    description,
    /Use it after creating a UI component or changing how one renders, even when the app's preview is available/,
  );
  assert.match(description, /default, empty, error, loading, long content/);
  assert.match(
    description,
    /in the app alone only when this costs more: heavy fakes for a state the app already shows, or a change to the screen's integration/,
  );
  assert.match(
    description,
    /each caption says whether it shows the isolated component or the app/,
  );
});

test("the tool describes React packages without Vite, such as a Next.js app", () => {
  const desktop = fakeDesktop(() => rendered(1));
  const { description } = componentPreviewTool(desktop.options, preview)!;
  assert.match(
    description,
    /in the package of the component \(the folder with its package\.json\)/,
  );
  assert.match(
    description,
    /A React package without Vite, such as a Next\.js app, gets Blame's own Vite with @vitejs\/plugin-react, its PostCSS or Tailwind config and tsconfig or jsconfig paths/,
  );
  assert.match(
    description,
    /next\/link, next\/image, next\/navigation and next\/font become small shims in this server only/,
  );
  assert.match(
    description,
    /Only client components render: a Server Component \(an async component, or one importing server-only modules such as next\/headers\) is reported as such/,
  );
  assert.match(description, /never installs the project's dependencies/);
  assert.match(
    description,
    /In a cloud preview it runs in the preview's sandbox, where the dependencies are installed/,
  );
});

test("the tool describes Vue 3 packages without Vite, with a short mount example", () => {
  const desktop = fakeDesktop(() => rendered(1));
  const { description } = componentPreviewTool(desktop.options, preview)!;
  assert.match(
    description,
    /For Vue, Angular, Svelte or another framework, write `<name>\.blame-preview\.ts` and export `mount\(element, state\)` instead: it renders the named state into the element, for Vue with `createApp\(Component, props\)\.mount\(element\)`/,
  );
  assert.match(
    description,
    /A Vue 3 package without Vite, such as a Vue CLI app, gets Blame's own Vite with @vitejs\/plugin-vue: \.vue files with their <style> and <style scoped> blocks, its PostCSS or Tailwind config, tsconfig or jsconfig paths, and Vue CLI's @ alias for src; Vue 2 is not supported/,
  );
});

test("the tool describes SvelteKit apps and Svelte 5 packages without Vite, with a short mount example", () => {
  const desktop = fakeDesktop(() => rendered(1));
  const { description } = componentPreviewTool(desktop.options, preview)!;
  assert.match(
    description,
    /for Vue with `createApp\(Component, props\)\.mount\(element\)`, for Svelte with `mount\(Component, \{ target: element, props \}\)`/,
  );
  assert.match(
    description,
    /A SvelteKit app keeps its own Vite and sveltekit\(\) \(\$lib or #lib, \$env and \$app\/env\): \$app\/state, and \$app\/stores before SvelteKit 3, give a page at \/, and its public environment variables reach the page; SvelteKit's router does not run/,
  );
  assert.match(
    description,
    /A Svelte 5 package without Vite, such as a Rollup or webpack app, gets Blame's own Vite with @sveltejs\/vite-plugin-svelte, compiled by the package's own Svelte \(5\.46\.4 or later\) with its svelte\.config\.\*, its PostCSS or Tailwind config and tsconfig or jsconfig paths; Svelte 4 is not supported/,
  );
});

test("the tool describes React Native packages with react-native-web, such as an Expo app", () => {
  const desktop = fakeDesktop(() => rendered(1));
  const { description } = componentPreviewTool(desktop.options, preview)!;
  assert.match(
    description,
    /A React Native package with react-native-web, such as an Expo app with web support, gets Blame's own Vite with @vitejs\/plugin-react: react-native resolves to react-native-web, \.web\.\* files come first, __DEV__ is set and EXPO_PUBLIC_\* variables reach process\.env; without react-native-web it is not rendered, and an Expo module without a web implementation is named in the page's error: check those in the app or on a device/,
  );
});

test("the tool describes Angular packages without Vite, with createApplication and createComponent", () => {
  const desktop = fakeDesktop(() => rendered(1));
  const { description } = componentPreviewTool(desktop.options, preview)!;
  assert.match(
    description,
    /for Angular with `createApplication\(\{ providers \}\)` then `createComponent\(Component, \{ environmentInjector: app\.injector, hostElement: element \}\)`/,
  );
  assert.match(
    description,
    /An Angular 17 to 22 package without Vite, such as an Angular CLI app, gets Blame's own Vite with @analogjs\/vite-plugin-angular, which compiles with the project's Angular compiler and the tsconfig of angular\.json: templateUrl and styleUrl files, its PostCSS or Tailwind config and tsconfig paths; the preview file imports the stylesheets of the styles field of angular\.json\./,
  );
  assert.match(
    description,
    /zone\.js loads first when the polyfills of angular\.json include it, otherwise the render is zoneless\./,
  );
});

test("the tool describes Nuxt packages: their auto-imports, the shims, and what replaces data fetching", () => {
  const desktop = fakeDesktop(() => rendered(1));
  const { description } = componentPreviewTool(desktop.options, preview)!;
  assert.match(
    description,
    /A Nuxt 3 or 4 package gets it too, with Nuxt's auto-imports: Vue's API, composables\/ and utils\/, and the components of components\/ by their Nuxt names \(components\/base\/Button\.vue is <BaseButton>\); ~ and @ point to its srcDir \(app\/ in Nuxt 4\)/,
  );
  assert.match(
    description,
    /<NuxtLink>, <NuxtImg>, useRoute, useRouter, navigateTo, useHead, useRuntimeConfig and useState are small shims; useFetch, useAsyncData, \$fetch and imports of server\/ fail with a message: pass made-up data through props/,
  );
  assert.match(
    description,
    /Import the stylesheets of nuxt\.config's css field in the preview file/,
  );
});

test("the screenshots reach the model as images through the tool set", async () => {
  const desktop = fakeDesktop(() => rendered(2));
  const tool = componentPreviewTool(desktop.options, preview)!;
  const result = await callThroughToolSet([tool], "open_component_preview", {
    file: "src/card.blame-preview.tsx",
    themes: ["light", "dark"],
  });
  assert.equal(result.outcome, "completed");
  assert.equal(
    result.content.filter((block) => block.type === "image").length,
    2,
  );
  assert.equal(result.blobs.length, 2);
  assert.match(
    JSON.stringify(result.content),
    /Screenshot saved as screenshot:1{64}/,
  );
  // The component preview is no preview tool of its own: the list leaves it to its caller.
  assert.ok(
    !(await previewClientTools(desktop.options, preview)).some(
      (item) => item.name === "open_component_preview",
    ),
  );
});

test("a conversation gets the tool once, when its workspace holds a project it renders", async () => {
  const { conversationClientTools } = await import("./index.js");
  const checked: string[] = [];
  const services = (supported: boolean | Error) => ({
    connection: () => undefined,
    componentPreview: async () => rendered(1),
    prepareComponentPreview: async ({ worktree }: { worktree: string }) => {
      checked.push(worktree);
      if (supported instanceof Error) throw supported;
      return supported;
    },
  });
  const names = async (
    kind: "story" | "orchestrator" | "quick-chat" | "new-project",
    supported: boolean | Error = true,
    preview?: {
      worktree: string;
      workspaceMode?: "direct" | "local-container" | "cloud-mirror";
    },
  ) =>
    (
      await conversationClientTools(services(supported), {
        session: "s",
        kind,
        workspaceRoot: "/repo",
        skills: false,
        ...(preview ? { preview } : {}),
      })
    ).tools.map((tool) => tool.name);
  // A story in a managed preview, local or cloud, or in the project folder.
  for (const workspaceMode of [
    "local-container",
    "cloud-mirror",
    "direct",
  ] as const)
    assert.ok(
      (
        await names("story", true, { worktree: "/worktree", workspaceMode })
      ).includes("open_component_preview"),
    );
  assert.ok(
    (await names("story")).includes("open_component_preview"),
    "a story without a preview",
  );
  assert.ok((await names("quick-chat")).includes("open_component_preview"));
  assert.ok(!(await names("orchestrator")).includes("open_component_preview"));
  assert.ok(!(await names("new-project")).includes("open_component_preview"));
  assert.ok(
    !(await names("quick-chat", false)).includes("open_component_preview"),
  );
  assert.ok(
    !(await names("story", new Error("no git"))).includes(
      "open_component_preview",
    ),
  );
  // Plan and new-project conversations are never checked.
  assert.deepEqual(checked, [
    "/worktree",
    "/worktree",
    "/worktree",
    "/repo",
    "/repo",
    "/repo",
    "/repo",
  ]);
});

test("in a quick chat the tool renders in the project folder", async () => {
  const { conversationClientTools } = await import("./index.js");
  const desktop = fakeDesktop(() => rendered(1));
  const { tools } = await conversationClientTools(
    {
      connection: () => undefined,
      ...desktop.options,
      prepareComponentPreview: async () => true,
    },
    {
      session: "chat-1",
      kind: "quick-chat",
      workspaceRoot: "/repo",
      projectId: "p1",
      skills: false,
    },
  );
  const tool = tools.find((item) => item.name === "open_component_preview")!;
  await tool.run(
    { file: "src/card.blame-preview.tsx" } as never,
    toolContext({ session: "chat-1" }),
  );
  const call = desktop.calls[0] as Extract<
    ComponentPreviewHostInput,
    { action: "render" }
  >;
  assert.equal(call.worktree, "/repo");
  assert.equal(call.workspaceMode, "direct");
  assert.equal(call.projectId, "p1");
  assert.equal(call.sessionId, "chat-1");
  assert.match(
    tool.description,
    /when your turn ends, Blame deletes it and stops the server/,
  );
});
