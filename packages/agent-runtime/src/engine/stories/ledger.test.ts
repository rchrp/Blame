import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { StoryLedger } from "./ledger.js";

const turns = (...ids: string[]) => ids.map((turn) => ({ turn }));

test("a turn undone and brought back is not told again; a new one is", async () => {
  const ledger = new StoryLedger();
  await ledger.begin("s");
  assert.deepEqual(
    await ledger.untold("s", turns("t1", "t2")),
    turns("t1", "t2"),
  );
  await ledger.told("s", "t1");
  await ledger.told("s", "t2");
  // The last message undone, then the undo undone.
  assert.deepEqual(await ledger.untold("s", turns("t1")), []);
  assert.deepEqual(await ledger.untold("s", turns("t1", "t2")), []);
  // Undone, and the conversation goes on with a new turn.
  assert.deepEqual(await ledger.untold("s", turns("t1", "t3")), turns("t3"));
});

test("every turn ended while nothing could be written is told, not only the latest", async () => {
  const ledger = new StoryLedger();
  await ledger.begin("s");
  const ended = turns(...Array.from({ length: 30 }, (_, index) => `t${index}`));
  assert.equal((await ledger.untold("s", ended)).length, 30);
});

test("a session the ledger never saw starts from where it is", async () => {
  const ledger = new StoryLedger();
  assert.deepEqual(await ledger.untold("old", turns("t1", "t2")), []);
  assert.deepEqual(
    await ledger.untold("old", turns("t1", "t2", "t3")),
    turns("t3"),
  );
});

test("what this computer runs and told survives a restart; a corrupt file is kept aside", async () => {
  const directory = await mkdtemp(join(tmpdir(), "story-ledger-"));
  const file = join(directory, "stories.json");
  try {
    const first = new StoryLedger(file);
    await first.own("story", { projectId: "p", path: "/p", session: "s" });
    await first.begin("s");
    await first.told("s", "t1");
    const second = new StoryLedger(file);
    assert.equal(await second.owns("story"), true);
    assert.deepEqual(await second.untold("s", turns("t1", "t2")), turns("t2"));
    await second.release("story");
    assert.equal(await new StoryLedger(file).owns("story"), false);

    await writeFile(file, "{ not json");
    const third = new StoryLedger(file);
    assert.equal(await third.owns("story"), false);
    const kept = (await readdir(directory)).filter((name) =>
      name.includes(".corrupt-"),
    );
    assert.equal(kept.length, 1, "the unreadable file is kept aside");
    assert.equal(
      await readFile(join(directory, kept[0]!), "utf8"),
      "{ not json",
    );
    await third.own("next", { projectId: "p", path: "/p" });
    assert.equal(await new StoryLedger(file).owns("next"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
