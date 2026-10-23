import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PreviewManifest } from "@blame/agent-runtime";
import { stalePreviewSetupReason } from "./preview-setup-preflight.ts";

function manifest(command: string) {
  return {
    setup: [],
    services: [
      { id: "web", kind: "preview", workingDir: "/workspace", command },
    ],
  } as unknown as PreviewManifest;
}

test("explains a setup that now runs a Docker wrapper", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-preflight-"));
  try {
    await mkdir(join(root, "scripts"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        scripts: { dev: "node scripts/dev.mjs", "dev:web": "next dev" },
      }),
    );
    await writeFile(
      join(root, "scripts/dev.mjs"),
      'import { spawnSync } from "node:child_process";\nspawnSync("docker", ["info"]);\n',
    );
    const reason = await stalePreviewSetupReason(
      root,
      manifest("corepack pnpm dev --webpack"),
    );
    assert.match(
      reason ?? "",
      /service web runs package\.json script "dev" -> scripts\/dev\.mjs/,
    );
    assert.equal(
      await stalePreviewSetupReason(root, manifest("corepack pnpm dev:web")),
      undefined,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("never reports anything it cannot check", async () => {
  assert.equal(
    await stalePreviewSetupReason("/nonexistent/blame", manifest("pnpm dev")),
    undefined,
  );
  assert.equal(await stalePreviewSetupReason("/tmp", undefined), undefined);
});
