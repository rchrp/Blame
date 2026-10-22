import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { removePreviewScratch } from "./cline-runtime-tools.js";
import {
  componentPreviewPath,
  componentPreviewTool,
} from "./component-preview-tool.js";
import { sessionScreenshotIds } from "./preview-screenshots.js";

const run = promisify(execFile);
const screenshotId = "c".repeat(64);
const context = { sessionId: "preview-session", toolCallId: "call-1" } as never;
const preview = { scope: "story:1", worktree: "/workspace" };

function readyTarget(status = "ready") {
  return {
    available: status === "ready",
    loading: false,
    message: status === "ready" ? "Ready." : "The preview is not running.",
    reason: "X",
    status,
  } as never;
}

function fakeHost(status = "ready") {
  const calls: Array<{ arguments?: unknown; toolName: string }> = [];
  const options = {
    previewDevtools: async () => readyTarget(status),
    previewDevtoolsTools: async () => [],
    previewDevtoolsCall: async (input: {
      arguments?: unknown;
      toolName: string;
    }) => {
      calls.push({ arguments: input.arguments, toolName: input.toolName });
      if (input.toolName === "evaluate_script")
        return {
          content: [{ type: "text", text: '```json\n{"overlay":null}\n```' }],
        };
      if (input.toolName === "list_console_messages")
        return {
          content: [
            {
              type: "text",
              text: "## Console messages\nmsgid=4 [error] Missing key prop",
            },
          ],
        };
      if (input.toolName === "take_screenshot")
        return {
          content: [
            { type: "text", text: "Took a screenshot." },
            { type: "image", data: "AAAA", mimeType: "image/png" },
            {
              type: "text",
              text: `Screenshot saved as screenshot:${screenshotId}.`,
            },
          ],
          _meta: {
            blameScreenshots: [
              {
                id: screenshotId,
                mimeType: "image/png",
                width: 390,
                height: 844,
                pageUrl: "http://127.0.0.1:5173/x",
                viewport: { width: 390, height: 844 },
                colorScheme: "dark",
              },
            ],
          },
        };
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
  return { calls, options };
}

test("only temporary preview paths are accepted", () => {
  for (const path of [
    "/settings.blame-preview.html",
    "/settings.blame-preview.html?state=empty&theme=dark",
    "/packages/app/dialog.blame-preview.html",
    "/blame-preview/settings",
    "/blame-preview/settings?state=error",
  ])
    assert.equal(componentPreviewPath(path), true, path);
  for (const path of [
    "/settings",
    "/settings.html",
    "settings.blame-preview.html",
    "//evil.test/x.blame-preview.html",
    "/blame-preview/../admin",
    "/x?file=a.blame-preview.html",
    "",
  ])
    assert.equal(componentPreviewPath(path), false, path);
});

test("refuses a path outside the temporary names without opening anything", async () => {
  const host = fakeHost();
  const tool = componentPreviewTool(host.options, preview)!;
  const result = (await tool.execute({ path: "/settings" }, context)) as {
    content: Array<{ text: string }>;
    isError: boolean;
  };
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /only opens temporary preview pages/);
  assert.deepEqual(host.calls, []);
});

test("refuses when the managed preview is not ready", async () => {
  const host = fakeHost("stopped");
  const tool = componentPreviewTool(host.options, preview)!;
  const result = (await tool.execute(
    { path: "/a.blame-preview.html" },
    context,
  )) as {
    content: Array<{ text: string }>;
    isError: boolean;
  };
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not ready \(stopped\)/);
  assert.deepEqual(host.calls, []);
});

test("opens the page, reports errors and returns a screenshot", async () => {
  const host = fakeHost();
  const tool = componentPreviewTool(host.options, preview)!;
  const output = (await tool.execute(
    {
      path: "/dialog.blame-preview.html?state=empty",
      viewport: { width: 390, height: 844 },
      colorScheme: "dark",
    },
    context,
  )) as Array<Record<string, unknown>>;
  assert.deepEqual(
    host.calls.map(({ toolName }) => toolName),
    [
      "emulate",
      "navigate_page",
      "evaluate_script",
      "list_console_messages",
      "take_screenshot",
    ],
  );
  assert.deepEqual(host.calls[0].arguments, {
    colorScheme: "dark",
    viewport: "390x844x1",
  });
  assert.deepEqual(host.calls[1].arguments, {
    type: "url",
    url: "/dialog.blame-preview.html?state=empty",
  });
  assert.match(
    String(output[0].text),
    /Opened \/dialog\.blame-preview\.html\?state=empty \(390×844, dark\)/,
  );
  assert.match(String(output[0].text), /Error overlay: none/);
  assert.match(String(output[0].text), /Missing key prop/);
  assert.equal(
    output.find((block) => block.type === "image")?.mediaType,
    "image/png",
  );
  assert.ok(sessionScreenshotIds("preview-session").has(screenshotId));
});

test("no tool without a managed preview scope", () => {
  assert.equal(
    componentPreviewTool(fakeHost().options, { worktree: "/w" }),
    undefined,
  );
});

test("finishing removes temporary preview files and nothing else", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-preview-scratch-"));
  const git = async (cwd: string, args: string[]) =>
    (await run("git", args, { cwd })).stdout;
  try {
    await git(root, ["init", "-q"]);
    await mkdir(join(root, "app/blame-preview/settings"), { recursive: true });
    await mkdir(join(root, "node_modules/pkg/blame-preview"), {
      recursive: true,
    });
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
    await writeFile(join(root, "settings.blame-preview.html"), "<div></div>");
    await writeFile(join(root, "settings.blame-preview.tsx"), "export {}");
    await writeFile(
      join(root, "app/blame-preview/settings/page.tsx"),
      "export {}",
    );
    await writeFile(join(root, "node_modules/pkg/blame-preview/index.js"), "");
    await writeFile(join(root, "draft.ts"), "untracked");
    // The project ignores its build output; a build of the preview stays.
    await writeFile(join(root, ".gitignore"), ".next/\n");
    await mkdir(join(root, ".next/server/app/blame-preview"), {
      recursive: true,
    });
    await writeFile(join(root, ".next/server/app/blame-preview/page.js"), "");
    await writeFile(
      join(root, ".git/info/exclude"),
      "*.blame-preview.*\nblame-preview/\n",
    );
    await writeFile(join(root, "dialog.blame-preview.tsx"), "export {}");
    assert.equal(
      await removePreviewScratch(git, root),
      "Removed 4 temporary preview files.",
    );
    assert.deepEqual(
      await readdir(join(root, ".next/server/app/blame-preview")),
      ["page.js"],
    );
    assert.deepEqual(
      (await readdir(root)).filter((name) => name !== "app").sort(),
      [
        ".git",
        ".gitignore",
        ".next",
        "draft.ts",
        "keep.ts",
        "node_modules",
        "tracked.blame-preview.md",
      ],
    );
    // Git does not track empty folders: emptied ones are left as they are.
    assert.deepEqual(
      await readdir(join(root, "app/blame-preview/settings")),
      [],
    );
    assert.deepEqual(
      await readdir(join(root, "node_modules/pkg/blame-preview")),
      ["index.js"],
    );
    assert.equal(await removePreviewScratch(git, root), undefined);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
