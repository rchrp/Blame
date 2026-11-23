// Runs the initialization checks on each fixture's manifest the way the
// analysis session does: scan the project, submit the result, print what
// Blame's rules answer (accepted, or the numbered problems). No VM needed.
//
//   node scripts/preview-campaign/validate-manifests.mjs [fixture ...]
import { homedir } from "node:os";
import { join } from "node:path";
import { fixtures, writeFixture } from "./fixtures.mjs";

// The built module of the agent runtime (`pnpm --filter @blame/agent-runtime build`).
const { scanProjectForInitialization, parseProjectInitializationPayload } = await import(new URL("../../../agent-runtime/dist/project-initialization.js", import.meta.url).href);

const root = join(homedir(), ".blame-campaign", "validation");
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(fixtures);
let failures = 0;
for (const name of names) {
  const fixture = fixtures[name];
  if (!fixture) {
    failures += 1;
    console.log(`?    ${name}: unknown fixture`);
    continue;
  }
  const directory = await writeFixture(root, name);
  const scan = await scanProjectForInitialization(directory);
  const submitted = { previewManifest: fixture.manifest, runConfigurations: fixture.runConfigurations, cloudPreviewIgnore: [] };
  const expected = fixture.expectFailure ? "fixture is meant to fail at runtime, not at validation" : "";
  try {
    const parsed = parseProjectInitializationPayload(submitted, scan, undefined, {});
    const risks = parsed.previewManifest?.risks ?? [];
    console.log(`ok   ${name}${risks.length ? ` (${risks.length} warning(s): ${risks.map((risk) => risk.message).join(" | ").slice(0, 300)})` : ""}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${String(error.message).slice(0, 700)} ${expected}`);
  }
}
console.log(`${names.length - failures}/${names.length} fixtures pass the initialization checks`);
process.exitCode = failures ? 1 : 0;
