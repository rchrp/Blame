import assert from "node:assert/strict";
import test from "node:test";
import type { ServiceLaunchPlan } from "@blame/preview-runtime";
import { parseEnvDeclarations } from "./env-declarations.ts";
import { environmentPreflightFailure } from "./environment-preflight.ts";
import { resolvePreviewEnvironment } from "./environment-resolver.ts";

const adonis = `import { Env } from '@adonisjs/core/env'

export default await Env.create(new URL('../', import.meta.url), {
  NODE_ENV: Env.schema.enum(['development', 'production', 'test'] as const),
  PORT: Env.schema.number(),
  APP_KEY: Env.schema.string(),
  HOST: Env.schema.string({ format: 'host' }),
  LOG_LEVEL: Env.schema.string.optional(),
  DATABASE_URL: Env.schema.string(),
  SMTP_HOST: Env.schema.string.optional({ format: 'host' }),
})
`;

const t3 = `import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().url(),
    STRIPE_SECRET_KEY: z
      .string()
      .min(1),
    SENTRY_DSN: z
      .string()
      .optional(),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  },
  client: {
    NEXT_PUBLIC_APP_URL: z.string().url(),
  },
  runtimeEnv: {
    DATABASE_URL: process.env.DATABASE_URL,
  },
});
`;

test("reads the keys an AdonisJS app validates at startup", () => {
  const parsed = parseEnvDeclarations("packages/api/start/env.ts", adonis)!;
  assert.equal(parsed.directory, "packages/api");
  assert.deepEqual(
    parsed.declarations.map(({ key, required }) => `${key}:${required}`),
    [
      "NODE_ENV:true",
      "PORT:true",
      "APP_KEY:true",
      "HOST:true",
      "LOG_LEVEL:false",
      "DATABASE_URL:true",
      "SMTP_HOST:false",
    ],
  );
  assert.equal(parsed.declarations[0]!.rejectsEmpty, true);
});

test("reads t3-env and zod schemas, chains over several lines included", () => {
  const parsed = parseEnvDeclarations("apps/web/src/env.ts", t3)!;
  assert.equal(parsed.directory, "apps/web");
  assert.deepEqual(
    parsed.declarations.map(({ key, required }) => `${key}:${required}`),
    [
      "DATABASE_URL:true",
      "STRIPE_SECRET_KEY:true",
      "SENTRY_DSN:false",
      "NODE_ENV:false",
      "NEXT_PUBLIC_APP_URL:true",
    ],
  );
  const zod = parseEnvDeclarations(
    "env.mjs",
    "const schema = z.object({\n  REDIS_URL: z.string(),\n  PORT: z.coerce.number().default(3000),\n});\nexport const env = schema.parse(process.env);\n",
  )!;
  assert.equal(zod.directory, ".");
  assert.deepEqual(
    zod.declarations.map(({ key, required }) => `${key}:${required}`),
    ["REDIS_URL:true", "PORT:false"],
  );
  assert.equal(
    parseEnvDeclarations("src/env.ts", "export const a = 1"),
    undefined,
  );
});

test("fails a start that lacks a required key, in words a person can act on", () => {
  const api: ServiceLaunchPlan = {
    id: "api",
    kind: "preview",
    container: { image: "node:24" },
    workingDir: "/workspace/packages/api",
    environment: { HOST: "0.0.0.0", PORT: "3333" },
    dependsOn: [],
    endpoints: [{ id: "http", protocol: "http", port: 3333 }],
    bindings: [],
  };
  const declarations = {
    "packages/api": parseEnvDeclarations("packages/api/start/env.ts", adonis)!
      .declarations,
  };
  const resolve = (env: string) => ({
    databaseMode: "existing" as const,
    repositoryRoot: "/project",
    fromProject: [],
    files: [],
    warnings: [],
    resolved: resolvePreviewEnvironment({
      plan: { services: [api], setup: [] },
      bindings: {},
      databaseMode: "existing",
      envFiles: [{ path: "packages/api/.env", content: env }],
      project: [],
      story: [],
      declarations,
    }),
  });
  assert.equal(
    environmentPreflightFailure(resolve("NODE_ENV=development\nAPP_KEY=\n"), [
      "api",
    ]),
    "api needs APP_KEY and DATABASE_URL; they are not set in this preview. Set them in the Variables tab or switch to an isolated database on the Preview Environment page.",
  );
  assert.equal(
    environmentPreflightFailure(
      resolve(
        "NODE_ENV=development\nAPP_KEY=key-1234567890123\nDATABASE_URL=\n",
      ),
      ["api"],
    ),
    "api needs DATABASE_URL; it is empty in this preview. Set it in the Variables tab or switch to an isolated database on the Preview Environment page.",
  );
  assert.equal(
    environmentPreflightFailure(
      resolve(
        "NODE_ENV=development\nAPP_KEY=key-1234567890123\nDATABASE_URL=mysql://u:p@localhost/app\n",
      ),
      ["api"],
    ),
    undefined,
  );
  // A service the run configuration does not start is not checked.
  assert.equal(environmentPreflightFailure(resolve(""), ["web"]), undefined);
});
