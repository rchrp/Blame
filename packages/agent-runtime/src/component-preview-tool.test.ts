import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  finishComponentPreviews,
  removePreviewScratch,
  runtimeTools,
} from "./cline-runtime-tools.js";
import {
  componentPreviewFile,
  componentPreviewRenders,
  parseComponentPreviewRequest,
} from "./component-preview-request.js";
import {
  componentPreviewTool,
  type ComponentPreviewHostInput,
} from "./component-preview-tool.js";
import { sessionScreenshotIds } from "./preview-screenshots.js";

const run = promisify(execFile);
const context = {
  sessionId: "preview-session",
  toolCallId: "call-1",
} as never;
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
  const result = (await tool.execute(
    { file: "/dialog.blame-preview.html?state=empty" },
    context,
  )) as { content: Array<{ text: string }>; isError: boolean };
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /\.blame-preview\.tsx/u);
  assert.deepEqual(desktop.calls, []);
});

test("one call returns a screenshot per render and records them for finish_task", async () => {
  const desktop = fakeDesktop(() => rendered(4));
  const tool = componentPreviewTool(desktop.options, preview)!;
  const output = (await tool.execute(
    {
      file: "packages/app/src/card.blame-preview.tsx",
      states: ["default", "empty"],
      themes: ["light", "dark"],
    },
    context,
  )) as Array<Record<string, unknown>>;
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
  assert.ok(images.every((image) => image.mediaType === "image/png"));
  for (const id of ["1", "2", "3", "4"].map((digit) => digit.repeat(64)))
    assert.ok(sessionScreenshotIds("preview-session").has(id), id);
});

test("the tool exists only where the desktop offers it, in every workspace mode", () => {
  const desktop = fakeDesktop(() => rendered(1));
  const names = (
    workspaceMode: "direct" | "local-container",
    componentPreview: boolean,
  ) =>
    (
      runtimeTools(desktop.options, "/p", {
        componentPreview,
        workspaceMode,
        worktree: "/p",
      }) ?? []
    ).map((tool) => tool.name);
  assert.ok(names("direct", true).includes("open_component_preview"));
  assert.ok(names("local-container", true).includes("open_component_preview"));
  assert.ok(
    !names("local-container", false).includes("open_component_preview"),
  );
  assert.equal(componentPreviewTool({}, preview), undefined);
});

test("finishing stops the preview server, then removes the preview files", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-preview-finish-"));
  const git = async (cwd: string, args: string[]) =>
    (await run("git", args, { cwd })).stdout;
  try {
    await git(root, ["init", "-q"]);
    await writeFile(join(root, "card.blame-preview.tsx"), "export {}");
    const desktop = fakeDesktop(() => ({ stopped: 1 }));
    const note = await finishComponentPreviews(
      { ...desktop.options, git },
      root,
      "preview-session",
    );
    assert.deepEqual(desktop.calls, [
      { action: "stop", sessionId: "preview-session", worktree: root },
    ]);
    assert.equal(note, "Removed 1 temporary preview file.");
    assert.deepEqual(await readdir(root), [".git"]);
    const failing = await finishComponentPreviews(
      {
        componentPreview: async () => {
          throw new Error("runtime unreachable");
        },
        git,
      },
      root,
      "preview-session",
    );
    assert.equal(
      failing,
      "The component preview server did not stop: runtime unreachable",
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("finishing removes temporary preview files and nothing else", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-preview-scratch-"));
  const git = async (cwd: string, args: string[]) =>
    (await run("git", args, { cwd })).stdout;
  try {
    await git(root, ["init", "-q"]);
    await mkdir(join(root, "packages/app/src"), { recursive: true });
    await mkdir(join(root, "node_modules/pkg"), { recursive: true });
    await writeFile(join(root, "keep.ts"), "keep");
    await writeFile(join(root, "tracked.blame-preview.md"), "tracked");
    await git(root, ["add", "keep.ts", "tracked.blame-preview.md"]);
    await git(root, [
      "-c",
      "user.email=a@b",
      "-c",
      "user.name=n",
      "commit",
      "-qm",
      "init",
    ]);
    await writeFile(join(root, "settings.blame-preview.tsx"), "export {}");
    await writeFile(
      join(root, "packages/app/src/dialog.blame-preview.tsx"),
      "export {}",
    );
    await writeFile(join(root, "packages/app/src/dialog.tsx"), "draft");
    await writeFile(join(root, "node_modules/pkg/x.blame-preview.js"), "");
    await writeFile(join(root, "draft.ts"), "untracked");
    // The project ignores its build output; a build of the preview stays.
    await writeFile(join(root, ".gitignore"), "dist/\n");
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist/card.blame-preview.js"), "");
    await writeFile(join(root, ".git/info/exclude"), "*.blame-preview.*\n");
    await writeFile(join(root, "card.blame-preview.tsx"), "export {}");
    assert.equal(
      await removePreviewScratch(git, root),
      "Removed 3 temporary preview files.",
    );
    assert.deepEqual(await readdir(join(root, "dist")), [
      "card.blame-preview.js",
    ]);
    assert.deepEqual((await readdir(root)).sort(), [
      ".git",
      ".gitignore",
      "dist",
      "draft.ts",
      "keep.ts",
      "node_modules",
      "packages",
      "tracked.blame-preview.md",
    ]);
    assert.deepEqual(await readdir(join(root, "packages/app/src")), [
      "dialog.tsx",
    ]);
    assert.deepEqual(await readdir(join(root, "node_modules/pkg")), [
      "x.blame-preview.js",
    ]);
    assert.equal(await removePreviewScratch(git, root), undefined);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
