import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import {
  captureCompileCache,
  compileCacheDirectories,
  compileCacheVolume,
  kindsUsedBy,
  seedCompileCache,
  type CompileCacheTarget,
} from "./local-preview-compile-cache.ts";
import {
  dockerAvailable,
  hostShell,
  inBusybox,
  testDockerHost as host,
} from "./compile-cache-test-host.ts";

// The scripts run in a busybox container on the Docker host, so their
// tests need Docker: the local one, or BLAME_TEST_DOCKER_PREFIX. The
// Next.js exactness suite is local-preview-compile-cache-next.test.ts.

const cache = ".next/dev/cache/turbopack";
const owner = { uid: 4321, gid: 4322 };

test("finds the Turbopack cache of the services' Next.js packages", async () => {
  const files: Record<string, string> = {
    "/w/apps/web/package.json": JSON.stringify({
      dependencies: { next: "16.4.6", react: "19.3.1" },
    }),
    "/w/apps/api/package.json": JSON.stringify({
      dependencies: { fastify: "5.0.0" },
    }),
    "/w/package.json": JSON.stringify({ devDependencies: { next: "16.4.6" } }),
  };
  const plan = {
    services: [
      { id: "web", workingDir: "/workspace/apps/web/" },
      { id: "api", workingDir: "/workspace/apps/api" },
      { id: "root", workingDir: "/workspace" },
      { id: "db", workingDir: "/var/lib/postgresql" },
      { id: "escape", workingDir: "/workspace/../etc" },
    ],
  } as Parameters<typeof compileCacheDirectories>[2];
  const fake = { readFile: async (path: string) => files[path] };
  assert.deepEqual(
    await compileCacheDirectories(fake, "/w", plan, [
      "web",
      "api",
      "db",
      "escape",
    ]),
    ["apps/web/.next/dev/cache/turbopack", "apps/web/.next/cache/turbopack"],
  );
  assert.deepEqual(await compileCacheDirectories(fake, "/w", plan, ["root"]), [
    ".next/dev/cache/turbopack",
    ".next/cache/turbopack",
  ]);
  assert.deepEqual(
    await compileCacheDirectories(fake, "/w", plan, ["api"]),
    [],
  );
  assert.deepEqual(kindsUsedBy("{not json"), []);
  assert.deepEqual(kindsUsedBy(undefined), []);
});

test("refuses directories that leave the worktree", async () => {
  const target = {
    worktree: "/w",
    dependencyKey: "abc",
    directories: ["../other/.next/dev/cache/turbopack"],
    owner,
  };
  let ran = false;
  const fake = {
    ...host,
    run: async () => {
      ran = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  assert.equal((await seedCompileCache(fake, target)).state, "cold");
  assert.equal(await captureCompileCache(fake, target), false);
  assert.equal(ran, false);
});

let root = "";
let dependencyKey = "";
let docker = false;

before(async () => {
  docker = await dockerAvailable();
  if (!docker) return;
  root = (await hostShell("mktemp -d /tmp/blame-compile-cache.XXXXXX")).trim();
  dependencyKey = randomUUID().replace(/-/g, "").slice(0, 12);
});

after(async () => {
  if (!docker) return;
  await inBusybox(root, "rm -rf /r/* /r/.[!.]*").catch(() => undefined);
  await hostShell(
    'rmdir "$1"; docker volume rm -f "$2" >/dev/null',
    root,
    compileCacheVolume(dependencyKey),
  ).catch(() => undefined);
});

function target(name: string): CompileCacheTarget {
  return {
    worktree: `${root}/${name}`,
    dependencyKey,
    directories: [cache, ".next/cache/turbopack"],
    owner,
  };
}

// A cache whose files were last written a minute ago.
async function writeQuietCache(name: string, marker: string) {
  await inBusybox(
    root,
    `set -e
d="/r/$1/${cache}/v16"
mkdir -p "$d"
echo "$2" > "$d/CURRENT"
head -c 200000 /dev/urandom > "$d/00000001.sst"
touch -d "@$(( $(date +%s) - 60 ))" "$d/CURRENT" "$d/00000001.sst" "$d"
chown -R 1001:1001 "/r/$1"`,
    name,
    marker,
  );
}

test("captures a quiet cache and seeds an empty worktree with it", async (t) => {
  if (!docker) return t.skip("Docker is not available");
  await writeQuietCache("source", "first");
  assert.equal(
    await captureCompileCache(host, target("source"), { quietSeconds: 2 }),
    true,
  );

  const seeded = await seedCompileCache(host, target("story"));
  assert.equal(seeded.state, "seeded");
  const report = await inBusybox(
    root,
    `cmp "/r/source/${cache}/v16/00000001.sst" "/r/story/${cache}/v16/00000001.sst" && echo same
cat "/r/story/${cache}/v16/CURRENT"
for p in .next .next/dev .next/dev/cache "${cache}" "${cache}/v16/CURRENT"; do stat -c "%u:%g $p" "/r/story/$p"; done
ls -a "/r/story/.next/dev/cache"`,
  );
  assert.deepEqual(report.trim().split("\n"), [
    "same",
    "first",
    "4321:4322 .next",
    "4321:4322 .next/dev",
    "4321:4322 .next/dev/cache",
    `4321:4322 ${cache}`,
    `4321:4322 ${cache}/v16/CURRENT`,
    ".",
    "..",
    "turbopack",
  ]);

  // A worktree with any cache of its own keeps it.
  assert.deepEqual(await seedCompileCache(host, target("story")), {
    state: "warm",
  });
  await writeQuietCache("own", "own");
  assert.deepEqual(await seedCompileCache(host, target("own")), {
    state: "warm",
  });
  assert.equal(
    (await inBusybox(root, `cat "/r/own/${cache}/v16/CURRENT"`)).trim(),
    "own",
  );
});

test("does not capture a cache its compiler keeps writing", async (t) => {
  if (!docker) return t.skip("Docker is not available");
  await writeQuietCache("busy", "busy");
  const writer = `blame-compile-cache-writer-${dependencyKey}`;
  await hostShell(
    `docker run -d --rm --name "$2" -v "$1/busy:/w" busybox:1.37.0 sh -c 'while :; do date >> /w/${cache}/v16/LOG; sleep 1; done' >/dev/null`,
    root,
    writer,
  );
  try {
    assert.equal(
      await captureCompileCache(host, target("busy"), {
        quietSeconds: 3,
        timeoutSeconds: 8,
      }),
      false,
    );
  } finally {
    await hostShell('docker rm -f "$1" >/dev/null', writer);
  }
  // The snapshot is still the first one.
  await hostShell('rm -rf "$1/fresh"', root).catch(() => undefined);
  assert.equal((await seedCompileCache(host, target("fresh"))).state, "seeded");
  assert.equal(
    (await inBusybox(root, `cat "/r/fresh/${cache}/v16/CURRENT"`)).trim(),
    "first",
  );
  // Quiet again, it becomes the snapshot.
  assert.equal(
    await captureCompileCache(host, target("busy"), {
      quietSeconds: 2,
      timeoutSeconds: 20,
    }),
    true,
  );
  assert.equal((await seedCompileCache(host, target("next"))).state, "seeded");
  assert.equal(
    (await inBusybox(root, `cat "/r/next/${cache}/v16/CURRENT"`)).trim(),
    "busy",
  );
});

test("keeps the published snapshot and the previous one only", async (t) => {
  if (!docker) return t.skip("Docker is not available");
  await writeQuietCache("third", "third");
  assert.equal(
    await captureCompileCache(host, target("third"), { quietSeconds: 2 }),
    true,
  );
  const volume = compileCacheVolume(dependencyKey);
  const listing = await hostShell(
    'docker run --rm -v "$1:/c" busybox:1.37.0 sh -c "cat /c/current; ls -A /c"',
    volume,
  );
  const [current, ...lines] = listing.trim().split("\n");
  assert.equal(lines.filter((line) => line.startsWith("snapshot-")).length, 2);
  assert.ok(lines.includes(current!));
  assert.ok(!lines.some((line) => line.startsWith(".incoming")));
});

test("starts cold without a snapshot or a cache to seed", async (t) => {
  if (!docker) return t.skip("Docker is not available");
  const other = { ...target("lonely"), dependencyKey: `${dependencyKey}x` };
  assert.deepEqual(await seedCompileCache(host, other), {
    state: "cold",
    reason: "no snapshot",
  });
  assert.deepEqual(
    await seedCompileCache(host, { ...target("lonely"), directories: [] }),
    { state: "cold", reason: "no compiler cache" },
  );
  // A snapshot taken for other packages has nothing for this worktree.
  await inBusybox(root, "mkdir -p /r/lonely");
  const elsewhere = {
    ...target("lonely"),
    directories: ["apps/site/.next/dev/cache/turbopack"],
  };
  assert.equal((await seedCompileCache(host, elsewhere)).state, "cold");
  assert.equal((await inBusybox(root, "ls -A /r/lonely | wc -l")).trim(), "0");
});
