import assert from "node:assert/strict";
import test from "node:test";
import {
  launchEnvironment,
  normalizedLaunchCommand,
} from "./command-normalization.js";
import { compilePreviewManifest } from "./manifest-compiler.js";

test("runs bare pnpm through corepack", () => {
  assert.equal(
    normalizedLaunchCommand("pnpm install && pnpm dev"),
    "(corepack enable 2>/dev/null || true) && corepack pnpm install && corepack pnpm dev",
  );
  assert.equal(
    normalizedLaunchCommand("corepack enable && pnpm dev"),
    "(corepack enable 2>/dev/null || true) && corepack pnpm dev",
  );
});

test("keeps commands that already use corepack", () => {
  const command =
    'corepack enable --install-directory "$$COREPACK_HOME/bin" && corepack pnpm dev';
  assert.equal(normalizedLaunchCommand(command), command);
  assert.equal(normalizedLaunchCommand("npm run dev"), "npm run dev");
});

test("keeps the project lockfile untouched on npm install", () => {
  assert.equal(
    normalizedLaunchCommand("npm install && npm run dev"),
    "npm install --no-package-lock && npm run dev",
  );
  assert.equal(
    normalizedLaunchCommand("npm install --no-package-lock"),
    "npm install --no-package-lock",
  );
  assert.equal(
    normalizedLaunchCommand("npm install --prefix web react"),
    "npm install --prefix web react",
  );
});

test("drops numeric host users", () => {
  assert.equal(
    normalizedLaunchCommand(
      "su -s /bin/bash -c 'npm run dev' '#${BLAME_HOST_UID}'",
    ),
    "bash -lc 'npm run dev'",
  );
});

test("sets CI for package installs only", () => {
  assert.deepEqual(launchEnvironment("pnpm install", { A: "1" }), {
    A: "1",
    CI: "true",
  });
  assert.deepEqual(launchEnvironment("pnpm dev", {}), {});
  assert.deepEqual(launchEnvironment("npm ci", { CI: "1" }), { CI: "1" });
});

test("the compiled plan carries the normalized commands", () => {
  const plan = compilePreviewManifest({
    confidence: "high",
    project: {},
    setup: [
      {
        id: "install",
        container: { image: "node:24" },
        command: "pnpm install",
      },
    ],
    services: [
      {
        id: "web",
        kind: "preview",
        container: { image: "node:24" },
        command: "pnpm dev",
        endpoints: [
          {
            id: "http",
            protocol: "http",
            port: 3000,
            healthcheck: { type: "http", path: "/", timeoutMs: 30000 },
          },
        ],
      },
    ],
    caches: [],
    risks: [],
    probes: [],
  });
  assert.match(plan.setup[0]!.command, /corepack pnpm install$/);
  assert.equal(plan.setup[0]!.environment.CI, "true");
  assert.match(plan.services[0]!.command ?? "", /corepack pnpm dev$/);
  assert.equal(plan.services[0]!.environment.CI, undefined);
});
