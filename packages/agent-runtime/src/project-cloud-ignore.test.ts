import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  mergeProjectCloudIgnore,
  parseCloudPreviewIgnore,
  readProjectCloudIgnore,
  updateProjectCloudIgnore,
} from "./project-cloud-ignore.js";
import { scanProjectForInitialization } from "./project-initialization-scan.js";
import { saveProjectInitialization } from "./cline-initialization.js";

const generated = [
  {
    pattern: "/archives/**",
    reason: "Historical results unused by the app's build and runtime.",
  },
];

test("regeneration keeps manual comments, rules and exceptions byte for byte", () => {
  const manual =
    "# My exclusions\r\n/recordings/\r\n!/archives/keep.json\r\n# No final newline";
  const first = mergeProjectCloudIgnore(manual, generated);
  assert.ok(first.endsWith(manual));
  assert.equal(mergeProjectCloudIgnore(first, generated), first);
  const next = mergeProjectCloudIgnore(first, [
    { pattern: "/reports/old.zip", reason: "Historical export" },
  ]);
  assert.ok(next.endsWith(manual));
  assert.equal(next.includes("/archives/**"), false);
  assert.equal(mergeProjectCloudIgnore(next, []), manual);
});

test("ambiguous generated markers cannot erase manual rules", () => {
  for (const content of [
    "# BEGIN BLAME GENERATED CLOUD EXCLUSIONS\n/manual/\n",
    "# END BLAME GENERATED CLOUD EXCLUSIONS\n/manual/\n",
    "# END BLAME GENERATED CLOUD EXCLUSIONS\n# BEGIN BLAME GENERATED CLOUD EXCLUSIONS\n",
  ])
    assert.throws(
      () => mergeProjectCloudIgnore(content, generated),
      /malformed generated block/,
    );
});

test("generated exclusions cannot express broad, escaping or multiline rules", () => {
  for (const pattern of [
    "*",
    "/**",
    "/",
    "/../outside",
    "/a/../b",
    "/a//b",
    "/a\nb",
    "/a\\b",
    "!/archives/**",
    "/**/src",
    "/.blameignore",
    "/.git",
    "/.gitignore",
    "/path/*",
  ]) {
    assert.throws(
      () => parseCloudPreviewIgnore([{ pattern, reason: "Reason" }]),
      /exact rooted paths/,
    );
  }
  assert.throws(
    () =>
      parseCloudPreviewIgnore([
        { pattern: "/archives/**", reason: "Reason\n/source/**" },
      ]),
    /single-line/,
  );
  assert.throws(
    () => parseCloudPreviewIgnore([...generated, ...generated]),
    /Duplicate/,
  );
  assert.equal(parseCloudPreviewIgnore(undefined), undefined);
});

test("accepted analysis merges the latest manual edits and retains local excluded files", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "blame-cloud-ignore-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "archives"));
  await writeFile(join(root, "archives/results.zip"), Buffer.alloc(2048));
  await writeFile(
    join(root, "package.json"),
    '{"scripts":{"dev":"node server.js"}}',
  );
  await writeFile(join(root, ".blameignore"), "# User rules\n/personal/\n");
  const scan = await scanProjectForInitialization(root);
  assert.equal(
    scan.cloudTransfer?.existingBlameignore,
    "# User rules\n/personal/\n",
  );
  assert.deepEqual(scan.cloudTransfer?.largestFiles[0], {
    path: "archives/results.zip",
    bytes: 2048,
  });
  assert.deepEqual(scan.cloudTransfer?.largestDirectories[0], {
    path: "archives",
    bytes: 2048,
    files: 1,
  });
  const manual = "# User rules\n/personal/\n!/archives/keep.json\n";
  await writeFile(join(root, ".blameignore"), manual);
  const result = await saveProjectInitialization(
    root,
    {
      sessionId: "submitted",
      previewManifest: {
        confidence: "high",
        project: { root: ".", detectedStack: [], confidence: "high" },
        setup: [],
        services: [],
        caches: [],
        risks: [],
        probes: [],
      },
      runConfigurations: [],
      cloudPreviewIgnore: generated,
    },
    "completed",
  );
  assert.equal(result.sessionId, "completed");
  assert.equal("cloudPreviewIgnore" in result, false);
  const first = await readProjectCloudIgnore(root);
  assert.equal(first, mergeProjectCloudIgnore(manual, generated));
  await updateProjectCloudIgnore(root, undefined);
  assert.equal(await readProjectCloudIgnore(root), first);
  assert.equal(
    (await readFile(join(root, "archives/results.zip"))).length,
    2048,
  );
  await updateProjectCloudIgnore(root, []);
  assert.equal(await readProjectCloudIgnore(root), manual);
});

test("does not follow linked control files or replace them", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "blame-cloud-ignore-link-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "manual.txt"), "# Keep me\n");
  await symlink("manual.txt", join(root, ".blameignore"));
  await assert.rejects(
    () => updateProjectCloudIgnore(root, []),
    /regular file/,
  );
  assert.equal(await readFile(join(root, "manual.txt"), "utf8"), "# Keep me\n");
});

test("generated paths must exist with the stated type before writing the control file", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "blame-cloud-ignore-path-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "archive.zip"), "archive");
  await assert.rejects(
    () =>
      updateProjectCloudIgnore(root, [
        { pattern: "/archive.zip/**", reason: "Archive" },
      ]),
    /existing directory/,
  );
  await assert.rejects(
    () => updateProjectCloudIgnore(root, generated),
    /ENOENT/,
  );
  assert.equal(await readProjectCloudIgnore(root), undefined);
});
