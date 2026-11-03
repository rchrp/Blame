import assert from "node:assert/strict";
import test from "node:test";
import type { PreviewExecutionPlan } from "@blame/preview-runtime";
import { materializePreviewEnvValues } from "../workspace-env.ts";
import {
  localDatabaseHostRewrite,
  previewDatabaseMode,
} from "./database-environment.ts";
import { localPreviewHostGateway, previewExtraHosts } from "./host-gateway.ts";

const alias = "host.docker.internal";

test("rewrites hosts on the developer's computer in database settings", () => {
  const cases: Array<[string, string, string | undefined]> = [
    [
      "DATABASE_URL",
      "postgres://app:secret@localhost:5432/app",
      "postgres://app:secret@host.docker.internal:5432/app",
    ],
    [
      "DATABASE_URL",
      '"mysql://root:pw@127.0.0.1:13307/blame?ssl=false"',
      '"mysql://root:pw@host.docker.internal:13307/blame?ssl=false"',
    ],
    ["REDIS_URL", "redis://localhost", "redis://host.docker.internal"],
    ["DB_HOST", "127.0.0.1", alias],
    ["PGHOST", "'localhost'", `'${alias}'`],
    // A hosted database, or a name that merely contains "localhost", stays.
    ["DATABASE_URL", "postgres://u:p@db.neon.tech/app", undefined],
    ["DATABASE_URL", "postgres://u:p@localhost.example.com/app", undefined],
    ["DB_PORT", "5432", undefined],
    ["DB_DATABASE", "localhost", undefined],
  ];
  for (const [key, value, expected] of cases)
    assert.equal(localDatabaseHostRewrite(key, value, alias), expected, value);
});

test("keeps the developer's database settings when the preview uses the project's database", () => {
  const developer = [
    "PORT=3333",
    "DB_HOST=127.0.0.1",
    "DB_PORT=13307",
    "DB_PASSWORD=real-secret",
    "DATABASE_URL=postgres://app:secret@localhost:5432/app",
    "HOSTED_URL=https://example.com",
    "",
  ].join("\n");
  const preview = materializePreviewEnvValues(
    developer,
    undefined,
    {},
    {},
    {
      mode: "existing",
      hostAlias: alias,
    },
  );
  assert.equal(
    preview,
    [
      "PORT=3333",
      `DB_HOST=${alias}`,
      "DB_PORT=13307",
      "DB_PASSWORD=real-secret",
      `DATABASE_URL=postgres://app:secret@${alias}:5432/app`,
      "HOSTED_URL=https://example.com",
      "",
    ].join("\n"),
  );
  // With an isolated database they stay out, as before.
  assert.match(
    materializePreviewEnvValues(
      developer,
      undefined,
      {},
      {},
      { mode: "compose" },
    ),
    /^# DATABASE_URL left out by Blame/m,
  );
});

test("reads the database mode from the saved choice, else from the manifest", () => {
  const withDatabase = {
    services: [
      { kind: "preview", container: { image: "node:24" } },
      { kind: "dependency", container: { image: "postgres:17-alpine" } },
    ],
  } as unknown as PreviewExecutionPlan;
  const withCacheOnly = {
    services: [{ kind: "dependency", container: { image: "redis:7" } }],
  } as unknown as PreviewExecutionPlan;
  assert.equal(previewDatabaseMode(withDatabase), "compose");
  assert.equal(previewDatabaseMode(withCacheOnly), "existing");
  assert.equal(previewDatabaseMode(withDatabase, "existing"), "existing");
  assert.equal(previewDatabaseMode(withCacheOnly, "compose"), "compose");
});

test("finds the gateway that reaches the developer's computer", async () => {
  const commands: string[] = [];
  const run = async (_command: string, args: string[]) => {
    commands.push(args[1]!);
    return args[1]!.includes("host.lima.internal")
      ? { exitCode: 0, stdout: "192.168.5.2\n", stderr: "" }
      : { exitCode: 0, stdout: "172.29.0.1\n", stderr: "" };
  };
  const mac = await localPreviewHostGateway(run, "darwin");
  assert.deepEqual(mac, {
    alias,
    address: "192.168.5.2",
    reachesLoopback: true,
  });
  assert.deepEqual(previewExtraHosts(mac), { [alias]: "192.168.5.2" });
  const windows = await localPreviewHostGateway(run, "win32");
  assert.equal(windows.address, "172.29.0.1");
  assert.equal(windows.reachesLoopback, false);
  const linux = await localPreviewHostGateway(run, "linux");
  assert.equal(linux.address, "host-gateway");
  // Detected once per platform.
  await localPreviewHostGateway(run, "darwin");
  assert.equal(commands.length, 2);
});
