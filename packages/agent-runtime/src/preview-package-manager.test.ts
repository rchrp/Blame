import assert from "node:assert/strict";
import test from "node:test";

import {
  commandWithProjectPackageManager,
  manifestWithProjectPackageManager,
  projectPackageManager,
} from "./preview-package-manager.js";
import type { PreviewManifest } from "./types.js";

test("reads the pinned package manager without its integrity hash", () => {
  assert.deepEqual(
    projectPackageManager('{"packageManager":"pnpm@10.33.2+sha512.abc"}'),
    { name: "pnpm", version: "10.33.2" },
  );
  assert.deepEqual(projectPackageManager('{"packageManager":"yarn@4.5.0"}'), {
    name: "yarn",
    version: "4.5.0",
  });
  assert.equal(
    projectPackageManager('{"packageManager":"pnpm@latest"}'),
    undefined,
  );
  assert.equal(projectPackageManager("{}"), undefined);
  assert.equal(projectPackageManager("not json"), undefined);
});

test("prepares the pinned version of the same package manager only", () => {
  const pnpm = { name: "pnpm" as const, version: "10.33.2" };
  assert.equal(
    commandWithProjectPackageManager(
      'mkdir -p "$$COREPACK_HOME/bin" && corepack prepare pnpm@10.32.1 --activate && corepack pnpm dev',
      pnpm,
    ),
    'mkdir -p "$$COREPACK_HOME/bin" && corepack prepare pnpm@10.33.2 --activate && corepack pnpm dev',
  );
  assert.equal(
    commandWithProjectPackageManager(
      "corepack prepare yarn@1.22.22 --activate",
      pnpm,
    ),
    "corepack prepare yarn@1.22.22 --activate",
  );
});

test("pins every setup task and service command", () => {
  const manifest = {
    setup: [
      {
        id: "deps",
        command:
          "corepack prepare pnpm@9.0.0 --activate && corepack pnpm install",
      },
    ],
    services: [
      { id: "db", kind: "dependency" },
      {
        id: "web",
        kind: "preview",
        command: "corepack prepare pnpm@9.0.0 --activate && corepack pnpm dev",
      },
    ],
  } as unknown as PreviewManifest;
  const pinned = manifestWithProjectPackageManager(manifest, {
    name: "pnpm",
    version: "10.33.2",
  });
  assert.match(pinned.setup[0]!.command, /pnpm@10\.33\.2/);
  assert.equal(pinned.services[0]!.command, undefined);
  assert.match(pinned.services[1]!.command!, /pnpm@10\.33\.2/);
  assert.equal(
    manifestWithProjectPackageManager(manifest, undefined),
    manifest,
  );
});
