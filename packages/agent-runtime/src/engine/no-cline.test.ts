// The engine host must never load the Cline runtime: it is the light
// process that replaces it. This walks every module the host can load
// (static imports and dynamic ones) from the built output.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

it("development stories, plan mode and the new-project assistant run on that host", () => {
  const { files } = graph(resolve(here, "index.js"));
  for (const purpose of [
    "quick-chat",
    "development-story",
    "plan",
    "new-project",
  ])
    assert.ok(
      files.has(resolve(here, "purposes", `${purpose}.js`)),
      `the ${purpose} purpose is in the host's graph, which loads no Cline`,
    );
});

// Every module of the conversations' client tools, each walked on its own.
const toolModules = [
  "tool.js",
  "desktop-services.js",
  "tools/index.js",
  "tools/attachments.js",
  "tools/component-preview.js",
  "tools/github.js",
  "tools/guards.js",
  "tools/mcp.js",
  "tools/mcp-oauth.js",
  "tools/mcp-settings.js",
  "tools/output.js",
  "tools/policy.js",
  "tools/preview.js",
  "tools/preview-types.js",
  "tools/skills.js",
  "tools/story-history.js",
  "tools/story-proposal.js",
  "tools/web-research.js",
];

for (const module of toolModules)
  it(`${module} loads nothing of Cline`, () => {
    const { files, packages } = graph(resolve(here, module));
    const cline = [...packages].filter((name) => name.startsWith("@cline/"));
    assert.deepEqual(cline, [], `${module} imports ${cline.join(", ")}`);
    const runtime = [...files].filter((file) => /cline-|cline\//.test(file));
    assert.deepEqual(runtime, [], `${module} loads ${runtime.join(", ")}`);
  });

it("the engine host's graph holds every client tool module", () => {
  const { files } = graph(resolve(here, "index.js"));
  for (const module of toolModules)
    assert.ok(files.has(resolve(here, module)), `${module} is not exported`);
});

it("the protocol module the main process loads imports no code at all", () => {
  const { files, packages } = graph(resolve(here, "protocol.js"));
  assert.deepEqual([...packages], []);
  assert.equal(files.size, 1);
});
