import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  crossDeviceLinkError,
  envHostFileMounts,
  materializedPreviewEnvHostFileMounts,
  materializedPreviewEnvFilesMatch,
  materializePreviewEnvValues,
  linkEnvFile,
  mergeEnvValues,
  syncProjectEnvFiles,
  relativeWorkspacePath,
} from "./workspace-env.ts";
import { joinWorkspacePath } from "./workspace-runtime.ts";

test("copies nested Windows env files into Linux directories, not backslash filenames", () => {
  const root = String.raw`C:\Users\René O'Neil\Mon projet`;
  const worktree =
    "/home/blame/.local/share/blame/runtime/worktrees/Mon projet/story-1";
  for (const path of [".env", "apps/api/.env", "apps/web/.env.local"]) {
    const source = `${root}\\${path.replaceAll("/", "\\")}`;
    const relative = relativeWorkspacePath(root, source, "win32");
    assert.equal(joinWorkspacePath(worktree, relative), `${worktree}/${path}`);
  }
});

test("syncs nested host env files to their corresponding runtime paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blame-env-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "apps", "api"), { recursive: true });
  await writeFile(join(root, "apps", "api", ".env"), "DATABASE_URL=fixture\n");
  const worktree =
    "/home/blame/.local/share/blame/runtime/worktrees/app/story-1";
  const copied = new Map<string, string>();
  await syncProjectEnvFiles(root, worktree, {
    isManaged: () => true,
    write: async (destination, source) => {
      copied.set(destination, await readFile(source, "utf8"));
    },
  });
  assert.deepEqual(
    [...copied],
    [[`${worktree}/apps/api/.env`, "DATABASE_URL=fixture\n"]],
  );
});

test("links runtime env files from repository root and fills blank main values", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-env-source-"));
  const worktree = await mkdtemp(join(tmpdir(), "blame-env-worktree-"));

  try {
    await writeFile(
      join(root, ".env"),
      "ROOT_SECRET=source\nONLY_SOURCE=source\n",
    );
    await writeFile(join(root, ".env.example"), "ROOT_SECRET=\n");
    await writeFile(join(root, ".env.local"), "LOCAL_SECRET=source\n");
    await mkdir(join(root, "apps", "backend"), { recursive: true });
    await mkdir(join(root, "apps", "extension", "dist"), {
      recursive: true,
    });
    await writeFile(
      join(root, "apps", "backend", ".env"),
      "BACKEND_SECRET=source\n",
    );
    await writeFile(
      join(root, "apps", "extension", "dist", ".env"),
      "DIST_SECRET=source\n",
    );
    await writeFile(
      join(worktree, ".env"),
      "ROOT_SECRET=\nWORKTREE_SECRET=worktree\n",
    );

    await syncProjectEnvFiles(root, worktree);

    assert.equal(
      await readFile(join(worktree, ".env"), "utf8"),
      "ROOT_SECRET=source\nONLY_SOURCE=source\nWORKTREE_SECRET=worktree\n",
    );
    assert.equal(
      await readFile(join(root, ".env"), "utf8"),
      "ROOT_SECRET=source\nONLY_SOURCE=source\nWORKTREE_SECRET=worktree\n",
    );
    await assertSameFile(join(root, ".env"), join(worktree, ".env"));
    assert.equal(
      await readFile(join(worktree, ".env.local"), "utf8"),
      "LOCAL_SECRET=source\n",
    );
    await assertSameFile(
      join(root, ".env.local"),
      join(worktree, ".env.local"),
    );
    assert.equal(
      await readFile(join(worktree, "apps", "backend", ".env"), "utf8"),
      "BACKEND_SECRET=source\n",
    );
    await writeFile(join(worktree, ".env"), "ROOT_SECRET=edited\n");
    assert.equal(
      await readFile(join(root, ".env"), "utf8"),
      "ROOT_SECRET=edited\n",
    );
    await assert.rejects(
      () => stat(join(worktree, "apps", "extension", "dist", ".env")),
      /ENOENT/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(worktree, { force: true, recursive: true });
  }
});

test("creates main runtime env files from templates before linking", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-env-template-source-"));
  const worktree = await mkdtemp(
    join(tmpdir(), "blame-env-template-worktree-"),
  );

  try {
    await writeFile(join(root, ".env.example"), "SECRET=template\n");
    await writeFile(join(root, ".env.local.example"), "LOCAL=template\n");

    await syncProjectEnvFiles(root, worktree);

    assert.equal(
      await readFile(join(root, ".env"), "utf8"),
      "SECRET=template\n",
    );
    assert.equal(
      await readFile(join(root, ".env.local"), "utf8"),
      "LOCAL=template\n",
    );
    await assertSameFile(join(root, ".env"), join(worktree, ".env"));
    await assertSameFile(
      join(root, ".env.local"),
      join(worktree, ".env.local"),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(worktree, { force: true, recursive: true });
  }
});

test("merges env values without replacing existing non-empty values", () => {
  const source = "A=source\nB=source\nC=source\n";
  const destination = "A=worktree\nB=\nD=worktree\n";

  assert.equal(
    mergeEnvValues(source, destination),
    "A=worktree\nB=source\nD=worktree\nC=source\n",
  );
});

test("materializes preview public env values", () => {
  assert.equal(
    materializePreviewEnvValues(
      [
        "APP_URL=http://localhost:3000",
        'BETTER_AUTH_URL="http://127.0.0.1:3000"',
        "DATABASE_URL=mysql://database:3306/app",
      ].join("\n"),
      "http://localhost:42251",
    ),
    [
      "APP_URL=http://localhost:42251",
      'BETTER_AUTH_URL="http://localhost:42251"',
      "DATABASE_URL=mysql://database:3306/app",
      "NEXT_PUBLIC_APP_URL=http://localhost:42251",
      "",
    ].join("\n"),
  );
});

test("materializes typed binding values without framework-specific keys", () => {
  assert.equal(
    materializePreviewEnvValues(
      "PRIVATE_BACKEND_ORIGIN=http://localhost:3333\nUNCHANGED=value\n",
      "http://localhost:42251",
      {
        PRIVATE_BACKEND_ORIGIN: "http://backend:3333",
        BROWSER_ORIGIN: "http://localhost:42251",
      },
    ),
    [
      "PRIVATE_BACKEND_ORIGIN=http://backend:3333",
      "UNCHANGED=value",
      "BROWSER_ORIGIN=http://localhost:42251",
      "",
    ].join("\n"),
  );
});

test("detects stale materialized preview env files", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-env-preview-"));
  try {
    await writeFile(join(root, ".env"), "APP_URL=http://localhost:3000\n");
    await mkdir(join(root, ".blame", "env-overrides"), { recursive: true });
    await writeFile(
      join(root, ".blame", "env-overrides", ".env"),
      "APP_URL=http://localhost:11111\nNEXT_PUBLIC_APP_URL=http://localhost:11111\n",
    );

    assert.equal(
      await materializedPreviewEnvFilesMatch(root, "http://localhost:22222"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves materialized env file modification time when unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-env-unchanged-"));
  const overridePath = join(root, ".blame", "env-overrides", ".env");
  const preservedTime = new Date("2020-01-02T03:04:05.000Z");
  try {
    await writeFile(join(root, ".env"), "APP_URL=http://localhost:3000\n");
    await materializedPreviewEnvHostFileMounts(root, "http://localhost:42251");
    await utimes(overridePath, preservedTime, preservedTime);

    await materializedPreviewEnvHostFileMounts(root, "http://localhost:42251");

    assert.equal((await stat(overridePath)).mtimeMs, preservedTime.getTime());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detects cross-device hardlink failures", () => {
  assert.equal(crossDeviceLinkError({ code: "EXDEV" }), true);
  assert.equal(crossDeviceLinkError({ code: "EACCES" }), false);
  assert.equal(crossDeviceLinkError(new Error("EXDEV")), false);
});

test("falls back to symlinked env files across devices", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-env-link-source-"));
  const worktree = await mkdtemp(join(tmpdir(), "blame-env-link-worktree-"));
  const source = join(root, ".env");
  const destination = join(worktree, ".env");

  try {
    await writeFile(source, "SECRET=source\n");
    await linkEnvFile(source, destination, async () => {
      throw { code: "EXDEV" };
    });
    await writeFile(destination, "SECRET=worktree\n");

    assert.equal(await readFile(source, "utf8"), "SECRET=worktree\n");
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(worktree, { force: true, recursive: true });
  }
});

test("detects symlinked env files as host file mounts", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-env-mount-source-"));
  const worktree = await mkdtemp(join(tmpdir(), "blame-env-mount-worktree-"));

  try {
    await mkdir(join(root, "apps", "backend"), { recursive: true });
    await mkdir(join(worktree, "apps", "backend"), { recursive: true });
    const source = join(root, "apps", "backend", ".env");
    const destination = join(worktree, "apps", "backend", ".env");
    await writeFile(source, "DB_HOST=postgres\n");
    await symlink(source, destination);

    assert.deepEqual(await envHostFileMounts(worktree), [
      {
        containerPath: "apps/backend/.env",
        hostPath: source,
      },
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(worktree, { force: true, recursive: true });
  }
});

async function assertSameFile(left: string, right: string) {
  const [leftStat, rightStat] = await Promise.all([stat(left), stat(right)]);
  assert.equal(leftStat.dev, rightStat.dev);
  assert.equal(leftStat.ino, rightStat.ino);
}
