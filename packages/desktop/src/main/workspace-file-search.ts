import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  resolveWorkspacePath as resolveRuntimePath,
  run as runRuntime,
  runtimeManagedPath,
  toWorkspacePath,
} from "./workspace-runtime.ts";

export type WorkspaceSearchInput = {
  root: string;
  path?: string;
  query: string;
  limit?: number;
};

type WorkspaceFileMatch = { name: string; path: string; type: "file" };

type SearchRuntime = {
  run: (command: string, args: string[]) => Promise<{ stdout: string }>;
};

// Blame Runtime's own Node, installed by its provisioning on macOS and
// Windows alike.
const runtimeNode = "/usr/local/bin/node";

// Runs in Blame Runtime with `node -e`: lists the files with `find`, keeps
// those whose name or relative path contains the query and stops at the
// limit, so only the matches cross the runtime agent. The order is find's.
// normalize is normalizeWorkspaceSearchText; the equivalence test keeps the
// two in step.
const runtimeSearchScript = String.raw`
const { spawn } = require("node:child_process");
const { posix } = require("node:path");
const [root, query, limitText] = process.argv.slice(1);
const limit = Number(limitText);
const normalize = (value) =>
  value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
const matches = [];
let done = false;
let rest = "";
const find = spawn("find", [root, "-type", "f"], {
  stdio: ["ignore", "pipe", "inherit"],
});
const finish = () => {
  done = true;
  process.stdout.write(JSON.stringify(matches));
};
const consider = (path) => {
  if (done || !path) return;
  const name = posix.basename(path);
  const relative = posix.relative(root, path.replace(/\\/g, "/")) || ".";
  if (normalize(name).includes(query) || normalize(relative).includes(query))
    matches.push([name, relative]);
  if (matches.length < limit) return;
  finish();
  find.kill();
};
find.stdout.setEncoding("utf8").on("data", (chunk) => {
  const lines = (rest + chunk).split("\n");
  rest = lines.pop();
  for (const line of lines) consider(line);
});
find.on("error", (error) => console.error(error.message));
find.on("close", (code) => {
  consider(rest);
  if (done) return;
  if (code !== 0) process.exitCode = code ?? 1;
  else finish();
});
`;

export async function searchWorkspaceFiles(input: WorkspaceSearchInput) {
  const root = resolveRuntimePath(input.root);
  const query = normalizeWorkspaceSearchText(input.query);
  if (!query) return [];
  const limit = Math.min(input.limit ?? 30, 100);
  if (runtimeManagedPath(root)) return searchRuntimeFiles(root, query, limit);
  const matches: WorkspaceFileMatch[] = [];
  await walk(root, root, query, limit, matches);
  return matches;
}

/** The query is already normalized. */
export async function searchRuntimeFiles(
  root: string,
  query: string,
  limit: number,
  fns: SearchRuntime = { run: runRuntime },
): Promise<WorkspaceFileMatch[]> {
  const { stdout } = await fns.run(runtimeNode, [
    "-e",
    runtimeSearchScript,
    root,
    query,
    String(limit),
  ]);
  return (JSON.parse(stdout) as Array<[string, string]>).map(
    ([name, path]) => ({ name, path, type: "file" }),
  );
}

async function walk(
  root: string,
  directory: string,
  query: string,
  limit: number,
  matches: WorkspaceFileMatch[],
) {
  if (matches.length >= limit) return;
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    if (matches.length >= limit || shouldSkip(entry.name)) continue;
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(root, entryPath, query, limit, matches);
      continue;
    }
    const relativePath = toWorkspacePath(root, entryPath);
    if (
      entry.isFile() &&
      (normalizeWorkspaceSearchText(entry.name).includes(query) ||
        normalizeWorkspaceSearchText(relativePath).includes(query))
    ) {
      matches.push({
        name: entry.name,
        path: relativePath,
        type: "file",
      });
    }
  }
}

export function normalizeWorkspaceSearchText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function shouldSkip(name: string) {
  return [".git", "node_modules", "dist", "build", ".turbo"].includes(name);
}
