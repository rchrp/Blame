import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  databaseEvidence,
  projectDatabaseEvidence,
} from "./database-evidence.ts";

test("finds a database in dependencies, env keys, Compose services and migrations", () => {
  const evidence = databaseEvidence(
    {
      "packages/api/package.json": JSON.stringify({
        dependencies: { "@adonisjs/lucid": "21", mysql2: "3", react: "19" },
      }),
      "packages/api/.env.example": "PORT=3333\nDB_HOST=127.0.0.1\n",
      "docker-compose.yml":
        "services:\n  db:\n    image: postgres:17\n  cache:\n    image: redis:7\n",
      "backend/requirements.txt": "Django==5.1\npsycopg[binary]\n",
      "web/package.json": '{"dependencies":{"next":"15"}}',
    },
    ["packages/api/database/migrations"],
  );
  assert.deepEqual(evidence.sort(), [
    "AdonisJS Lucid in packages/api/package.json",
    "DB_HOST in packages/api/.env.example",
    "Django in backend/requirements.txt",
    "a MySQL driver in packages/api/package.json",
    "a PostgreSQL driver in backend/requirements.txt",
    "a db (postgres:17) service in docker-compose.yml",
    "migrations in packages/api/database/migrations",
  ]);
  assert.deepEqual(
    databaseEvidence({
      "package.json": '{"dependencies":{"vite":"7","redis":"4"}}',
      ".env": "VITE_API_URL=http://localhost\n",
    }),
    [],
  );
});

test("scans a monorepo past the folders the old fixed list missed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blame-db-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "packages", "server", "prisma", "migrations"), {
    recursive: true,
  });
  await mkdir(join(root, "node_modules", "pg"), { recursive: true });
  await writeFile(
    join(root, "node_modules", "pg", "package.json"),
    '{"dependencies":{"pg":"8"}}',
  );
  await writeFile(
    join(root, "packages", "server", "package.json"),
    '{"dependencies":{"@prisma/client":"6"}}',
  );
  await writeFile(
    join(root, "packages", "server", "prisma", "schema.prisma"),
    "datasource db {}",
  );
  const { evidence } = await projectDatabaseEvidence(root);
  assert.deepEqual(evidence.sort(), [
    "Prisma in packages/server/package.json",
    "a Prisma schema in packages/server/prisma/schema.prisma",
    "migrations in packages/server/prisma/migrations",
  ]);
});
