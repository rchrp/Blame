import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizePreviewManifest,
  parsePreviewManifest,
} from "./preview-manifest.js";

test("normalization keeps a service's production commands, with corepack shims", () => {
  const manifest = normalizePreviewManifest(
    parsePreviewManifest({
      confidence: "high",
      project: {},
      setup: [],
      services: [
        {
          id: "web",
          kind: "preview",
          container: { image: "node:24-bookworm" },
          command: "corepack pnpm dev",
          endpoints: [
            {
              id: "http",
              protocol: "http",
              port: 3000,
              healthcheck: { type: "http", path: "/", timeoutMs: 30_000 },
            },
          ],
          production: {
            build: "corepack pnpm build",
            command: "corepack pnpm start",
          },
        },
      ],
      caches: [],
      risks: [],
      probes: [],
    }),
  );
  const production = manifest.services[0]!.production!;
  assert.match(
    production.build!,
    /corepack enable --install-directory .*corepack pnpm build$/,
  );
  assert.match(
    production.command,
    /corepack enable --install-directory .*corepack pnpm start$/,
  );
  assert.deepEqual(
    parsePreviewManifest(manifest).services[0]!.production,
    production,
  );
});
