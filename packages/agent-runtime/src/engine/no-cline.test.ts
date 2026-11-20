// The engine host must never load the Cline runtime: it is the light
// process that replaces it. This walks every module the host can load
// (static imports and dynamic ones) from the built output.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const specifiers =
  /(?:^|[\s;])(?:import|export)\s[^"';]*?from\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gm;

function graph(entry: string) {
  const files = new Set<string>();
  const packages = new Set<string>();
  const pending = [entry];
  while (pending.length) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(specifiers)) {
      const specifier = match[1] ?? match[2] ?? match[3]!;
      if (specifier.startsWith("."))
        pending.push(resolve(dirname(file), specifier));
      else packages.add(specifier);
    }
  }
  return { files, packages };
}

const here = dirname(fileURLToPath(import.meta.url));

it("the engine host loads nothing of Cline", () => {
  const { files, packages } = graph(resolve(here, "index.js"));
  const cline = [...packages].filter((name) => name.startsWith("@cline/"));
  assert.deepEqual(cline, [], `the engine host imports ${cline.join(", ")}`);
  const runtime = [...files].filter((file) => /cline-|cline\//.test(file));
  assert.deepEqual(runtime, []);
  assert.ok(files.size > 5, "the graph was walked");
});

it("every task purpose and runner is part of that graph", () => {
  // The one-shot agents that moved to the engine: none of them may reach
  // Cline, whichever module they live in.
  const { files } = graph(resolve(here, "index.js"));
  const modules = ["purposes", "tasks"].flatMap((folder) =>
    readdirSync(resolve(here, folder))
      .filter((name) => name.endsWith(".js") && !name.endsWith(".test.js"))
      .map((name) => resolve(here, folder, name)),
  );
  assert.ok(modules.length > 3);
  const outside = modules.filter((file) => !files.has(file));
  assert.deepEqual(
    outside,
    [],
    "a purpose the host does not load is unchecked",
  );
});

it("the protocol modules the main process loads import no code at all", () => {
  const { files, packages } = graph(resolve(here, "protocol.js"));
  assert.deepEqual([...packages], []);
  assert.deepEqual(
    [...files].map((file) => file.slice(here.length + 1)).sort(),
    ["protocol.js", "task-protocol.js"],
  );
});
