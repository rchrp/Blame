import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  normalizeWorkspaceSearchText,
  searchRuntimeFiles,
} from "./workspace-file-search.ts";
import { toWorkspacePath } from "./workspace-runtime.ts";

const execFileAsync = promisify(execFile);

// Runs Blame Runtime's command on this computer, with this Node.
const hostRuntime = {
  sent: 0,
  async run(_command: string, args: string[]) {
    const { stdout } = await execFileAsync(process.execPath, args, {
      maxBuffer: 256 * 1024 * 1024,
    });
    hostRuntime.sent += Buffer.byteLength(stdout);
    return { stdout };
  },
};

// What the search returned when Electron received every path of the tree
// and filtered them itself.
async function electronSideSearch(root: string, query: string, limit: number) {
  const { stdout } = await execFileAsync("find", [root, "-type", "f"], {
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((path) => ({ name: posix.basename(path), path }))
    .map((entry) => ({
      name: entry.name,
      path: toWorkspacePath(root, entry.path),
      type: "file" as const,
    }))
    .filter(
      (entry) =>
        normalizeWorkspaceSearchText(entry.name).includes(query) ||
        normalizeWorkspaceSearchText(entry.path).includes(query),
    )
    .slice(0, limit);
}

const trickyFiles = [
  "src/Café.tsx",
  "src/café-decomposed.ts",
  "src/CAFÉ-UPPER.md",
  "src/ﬁle-ligature.ts",
  "src/Ｆｕｌｌｗｉｄｔｈ.txt",
  "src/my file (copy).ts",
  "src/back\\slash.ts",
  "src/über/ÜBER-index.ts",
  "src/deep/a/b/c/d/e/needle.ts",
  "node_modules/pkg/index.js",
  "node_modules/pkg/cafe.js",
  ".git/objects/ab/cafe",
  ".next/cache/cafe.json",
  "dist/build/cafe.js",
  ...Array.from({ length: 150 }, (_, index) => `many/item-${index}.ts`),
];

const queries = [
  "cafe",
  "CAFÉ",
  "café",
  "file",
  "fullwidth",
  "my file",
  "backslash",
  "uber",
  "src/deep",
  "needle",
  "item",
  "item-1",
  "index",
  ".ts",
  "js",
  "nothing-matches-this",
];

async function searchesMatch(root: string, limits: number[]) {
  for (const raw of queries) {
    const query = normalizeWorkspaceSearchText(raw);
    if (!query) continue;
    for (const limit of limits)
      assert.deepEqual(
        await searchRuntimeFiles(root, query, limit, hostRuntime),
        await electronSideSearch(root, query, limit),
        `query ${JSON.stringify(raw)}, limit ${limit}`,
      );
  }
}

test("the runtime search returns what filtering every path in Electron did", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "blame-file-search-")),
  );
  try {
    for (const file of trickyFiles) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), "");
    }
    await searchesMatch(root, [1, 30, 100]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("the runtime search matches on a real tree and sends only the matches", async () => {
  const root = join(import.meta.dirname, "..", "..");
  await searchesMatch(root, [30, 100]);
  hostRuntime.sent = 0;
  const matches = await searchRuntimeFiles(root, "ts", 100, hostRuntime);
  assert.equal(matches.length, 100);
  assert.equal(
    hostRuntime.sent,
    Buffer.byteLength(JSON.stringify(matches.map((m) => [m.name, m.path]))),
  );
});
