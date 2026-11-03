import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeEnvironmentFiles } from "./environment-files.js";

test("writes each service's variables and the env files outside the workspace", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "blame-runner-env-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const directory = join(base, "environment");
  const owner = { uid: process.getuid!(), gid: process.getgid!() };
  const targets = await writeEnvironmentFiles(
    {
      variables: {
        api: {
          DATABASE_URL: "postgres://u:p$1@db.example.com/app",
          PRIVATE_KEY: "-----BEGIN\nKEY-----",
        },
        "setup-migrate": {
          DATABASE_URL: "postgres://u:p$1@db.example.com/app",
        },
      },
      files: [
        { path: "packages/api/.env", content: "APP_KEY=secret\n" },
        { path: "../escape/.env", content: "NO=1\n" },
      ],
    },
    owner,
    directory,
  );
  assert.deepEqual(targets.environmentFiles, {
    api: join(directory, "services", "api.env"),
    "setup-migrate": join(directory, "services", "setup-migrate.env"),
  });
  // Raw: a dollar stays a dollar; a value on several lines is left out.
  assert.equal(
    await readFile(targets.environmentFiles.api!, "utf8"),
    "DATABASE_URL=postgres://u:p$1@db.example.com/app\n",
  );
  assert.deepEqual(targets.skipped, ["api:PRIVATE_KEY"]);
  assert.deepEqual(targets.fileMounts, [
    {
      source: join(directory, "files", "packages/api/.env"),
      target: "packages/api/.env",
    },
  ]);
  assert.equal((await stat(targets.environmentFiles.api!)).mode & 0o777, 0o600);
  // A start without secrets clears what the previous one wrote.
  assert.deepEqual(await writeEnvironmentFiles(undefined, owner, directory), {
    environmentFiles: {},
    fileMounts: [],
    skipped: [],
  });
  await assert.rejects(stat(directory), /ENOENT/);
});
