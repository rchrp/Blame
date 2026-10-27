import assert from "node:assert/strict";
import test from "node:test";

import type { ProjectInitializationScan } from "./project-initialization-scan.js";
import { parseProjectInitializationPayload } from "./project-initialization.js";
import { validatePreviewSetup } from "./project-preview-validation.js";
import { parsePreviewManifest } from "./preview-manifest.js";

const scan = {
  files: { "package.json": '{"name":"app"}' },
  discovery: { migrationPaths: ["database/migrations"] },
} as unknown as ProjectInitializationScan;

function manifest(setupCommand: string, serviceCommand = "node server.js") {
  return parsePreviewManifest({
    confidence: "high",
    project: { root: ".", detectedStack: ["node"], confidence: "high" },
    setup: [
      {
        id: "deps",
        container: { image: "node:22-bookworm" },
        workingDir: "/workspace",
        command: setupCommand,
        dependsOn: ["db"],
      },
    ],
    services: [
      {
        id: "db",
        kind: "dependency",
        container: { image: "mysql:8.0" },
        endpoints: [{ id: "mysql", protocol: "tcp", port: 3306 }],
      },
      {
        id: "api",
        kind: "preview",
        container: { image: "node:22-bookworm" },
        workingDir: "/workspace",
        command: serviceCommand,
        dependsOn: ["db"],
        endpoints: [
          {
            id: "http",
            protocol: "http",
            port: 3333,
            healthcheck: { type: "http", path: "/", timeoutMs: 30_000 },
          },
        ],
      },
    ],
    caches: [],
    risks: [],
    probes: [],
  });
}

test("recognizes migration commands across ecosystems and package scripts", () => {
  for (const command of [
    "npm install && node ace migration:run --force",
    "npm install && php artisan migrate --force",
    "npm install && python manage.py migrate",
    "npm install && alembic upgrade head",
    "npm install && npx prisma migrate deploy",
    "npm install && npx prisma db push",
    "npm install && npx knex migrate:latest",
    "npm install && pnpm --filter api run db:migrate",
    "npm install && pnpm migrate",
    "npm install && yarn run migrations:apply",
    "npm install && mix ecto.migrate",
  ]) {
    assert.deepEqual(
      validatePreviewSetup(manifest(command), scan),
      [],
      command,
    );
  }
});

test("keeps heuristic rules as warnings that the last attempt may accept", () => {
  const setup = manifest("npm install");
  assert.throws(
    () => validatePreviewSetup(setup, scan),
    /must run detected database migrations/,
  );
  const warnings = validatePreviewSetup(setup, scan, { acceptWarnings: true });
  assert.deepEqual(
    warnings.map(({ severity }) => severity),
    ["warning"],
  );
  assert.match(warnings[0]!.warning, /database migrations/);
});

test("blocking rules still fail even when warnings are accepted", () => {
  assert.throws(
    () =>
      validatePreviewSetup(manifest("npm ci && node ace migration:run"), scan, {
        acceptWarnings: true,
      }),
    /npm install --no-package-lock/,
  );
});

test("a setup accepted with warnings lists them as risks", () => {
  const result = parseProjectInitializationPayload(
    {
      previewManifest: manifest("npm install"),
      runConfigurations: [
        {
          id: "api",
          name: "API",
          command: "npm start",
          cwd: ".",
          default: true,
          category: "web",
          services: ["api"],
          previewService: "api",
          scopes: ["api"],
        },
      ],
    },
    scan,
    undefined,
    { acceptWarnings: true },
  );
  assert.deepEqual(
    result.previewManifest.risks.map(({ level }) => level),
    ["medium"],
  );
  assert.match(result.previewManifest.risks[0]!.message, /migrations/);
});
