import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  betaFeedUrl,
  compareVersions,
  newestRelease,
  readUpdateChannel,
  updateMetadataFile,
  writeUpdateChannel,
} from "./desktop-update-channel.ts";

const mac = [{ name: "latest-mac.yml" }];

test("orders release tags by semantic version", () => {
  const ordered = [
    "v1.1.44",
    "v1.1.45-beta.1",
    "v1.1.45-beta.2",
    "v1.1.45-beta.10",
    "v1.1.45-rc.1",
    "v1.1.45",
    "v1.2.0-beta.1",
    "v1.10.0",
  ];
  const shuffled = [...ordered].reverse();
  assert.deepEqual(shuffled.sort(compareVersions), ordered);
});

test("the beta channel follows the newest published release with metadata", () => {
  const releases = [
    { tag_name: "runtime-v11", draft: false, assets: mac },
    { tag_name: "v1.1.46", draft: true, assets: mac },
    { tag_name: "v1.1.45-beta.2", draft: false, assets: [] },
    { tag_name: "v1.1.45-beta.1", draft: false, assets: mac },
    { tag_name: "v1.1.44", draft: false, assets: mac },
  ];
  assert.equal(
    newestRelease(releases, "latest-mac.yml")?.tag_name,
    "v1.1.45-beta.1",
  );

  releases.push({ tag_name: "v1.1.45", draft: false, assets: mac });
  assert.equal(newestRelease(releases, "latest-mac.yml")?.tag_name, "v1.1.45");
  assert.equal(newestRelease(releases, "latest.yml"), undefined);
});

test("builds the beta feed from the GitHub releases API", async () => {
  const requests: string[] = [];
  const feed = await betaFeedUrl(
    async (url) => {
      requests.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => [
          { tag_name: "v1.1.45-beta.1", draft: false, assets: mac },
        ],
      };
    },
    "latest-mac.yml",
    "owner/repo",
  );
  assert.equal(
    feed,
    "https://github.com/owner/repo/releases/download/v1.1.45-beta.1",
  );
  assert.deepEqual(requests, [
    "https://api.github.com/repos/owner/repo/releases?per_page=30",
  ]);

  await assert.rejects(
    betaFeedUrl(
      async () => ({ ok: false, status: 403, json: async () => ({}) }),
      "latest-mac.yml",
    ),
    /HTTP 403/,
  );
});

test("names the update metadata of each packaged platform", () => {
  assert.equal(updateMetadataFile("darwin", "arm64"), "latest-mac.yml");
  assert.equal(updateMetadataFile("win32", "x64"), "latest.yml");
  assert.equal(updateMetadataFile("linux", "x64"), "latest-linux.yml");
  assert.equal(updateMetadataFile("linux", "arm64"), "latest-linux-arm64.yml");
});

test("persists the channel and defaults to stable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blame-update-channel-"));
  const file = join(directory, "nested", "update-channel.json");
  try {
    assert.equal(await readUpdateChannel(file), "stable");
    await writeUpdateChannel(file, "beta");
    assert.equal(await readUpdateChannel(file), "beta");
    await writeFile(file, '{"channel":"nightly"}');
    assert.equal(await readUpdateChannel(file), "stable");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
