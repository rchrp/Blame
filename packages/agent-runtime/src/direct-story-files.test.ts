import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { findDirectStoryFiles, writtenFiles } from "./direct-story-files.js";
import { sha256 } from "./harness/light-identity.js";
import { SessionJournal } from "./harness/session-journal.js";

const execFileAsync = promisify(execFile);

test("lists the files the story wrote and flags those that also hold someone else's changes", async () => {
  const root = await repository();
  try {
    // Work of the person, already there when the story starts.
    await writeFile(join(root, "mine.txt"), "mine, edited\n");
    await writeFile(join(root, "shared.txt"), "shared, edited by the person\n");
    const story = storySession(root, "session-1");
    await story.write("story.txt", "story, edited\n");
    await story.write("shared.txt", "shared, edited by both\n");
    await story.write("created.txt", "created\n");
    await story.write("ignored.log", "ignored\n");
    await story.write("touched.txt", "touched, edited\n");
    // Changed by someone else after the story's last write.
    await writeFile(join(root, "touched.txt"), "touched, edited twice\n");

    const { files } = await findDirectStoryFiles({
      root,
      sessionIds: ["session-1"],
    });

    assert.deepEqual(files, [
      { path: "created.txt", shared: false },
      { path: "shared.txt", shared: true },
      { path: "story.txt", shared: false },
      { path: "touched.txt", shared: true },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("includes a file the story deleted", async () => {
  const root = await repository();
  try {
    const story = storySession(root, "session-1");
    await story.remove("story.txt");

    const { files } = await findDirectStoryFiles({
      root,
      sessionIds: ["session-1"],
    });

    assert.deepEqual(files, [{ path: "story.txt", shared: false }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("leaves out files that were put back or are already committed", async () => {
  const root = await repository();
  try {
    const story = storySession(root, "session-1");
    await story.write("reverted.txt", "changed\n");
    await story.write("reverted.txt", "reverted\n");
    await story.write("committed.txt", "committed by the person\n");
    await git(root, ["add", "committed.txt"]);
    await git(root, ["commit", "-m", "person commit"]);

    const { files } = await findDirectStoryFiles({
      root,
      sessionIds: ["session-1"],
    });

    assert.deepEqual(files, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("follows a story across its sessions", async () => {
  const root = await repository();
  try {
    const first = storySession(root, "session-1");
    const second = storySession(root, "session-2");
    await first.write("story.txt", "first run\n");
    await first.write("shared.txt", "first run\n");
    // Edited by someone else between the two runs.
    await writeFile(join(root, "shared.txt"), "someone else\n");
    await second.write("story.txt", "second run\n");
    await second.write("shared.txt", "second run\n");

    const { files } = await findDirectStoryFiles({
      root,
      sessionIds: ["session-1", "session-2"],
    });

    assert.deepEqual(files, [
      { path: "shared.txt", shared: true },
      { path: "story.txt", shared: false },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not take a CRLF checkout for someone else's changes", async () => {
  const root = await repository();
  try {
    await git(root, ["config", "core.autocrlf", "true"]);
    await writeFile(join(root, "crlf.txt"), "line one\r\nline two\r\n");
    await git(root, ["add", "crlf.txt"]);
    await git(root, ["commit", "-m", "crlf file"]);
    const story = storySession(root, "session-1");
    await story.write("crlf.txt", "line one\r\nline two, edited\r\n");

    const { files } = await findDirectStoryFiles({
      root,
      sessionIds: ["session-1"],
    });

    assert.deepEqual(files, [{ path: "crlf.txt", shared: false }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("orders the writes of all sessions and spots a change between two of them", () => {
  const at = (second: number) => `2026-01-01T00:00:0${second}.000Z`;

  assert.deepEqual(
    writtenFiles([
      { path: "a", before: "h1", after: "h2", timestamp: at(3) },
      { path: "b", before: "g0", after: "g1", timestamp: at(1) },
      { path: "a", before: "h0", after: "h1", timestamp: at(2) },
      { path: "b", before: "gX", after: "g2", timestamp: at(4) },
    ]),
    [
      { path: "b", initial: "g0", final: "g2", interleaved: true },
      { path: "a", initial: "h0", final: "h2", interleaved: false },
    ],
  );
});

// A session of the story: each write is journaled with the file's hash before
// and after it, as the agent's edits and commands are.
function storySession(root: string, sessionId: string) {
  const journal = new SessionJournal(root, sessionId);
  let receipts = 0;
  const record = async (path: string, change: () => Promise<void>) => {
    const before = await contentHash(root, path);
    await change();
    await journal.recordChange({
      beforeFiles: [{ path, hash: before }],
      parse: "not_supported",
      paths: [path],
      receipt: `c${++receipts}`,
      sourceRevisionId: "test",
      symbols: [],
    });
  };
  return {
    remove: (path: string) => record(path, () => unlink(join(root, path))),
    write: (path: string, content: string) =>
      record(path, async () => {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), content);
      }),
  };
}

async function contentHash(root: string, path: string) {
  try {
    return sha256(await readFile(join(root, path)));
  } catch {
    return "absent";
  }
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "blame-direct-story-"));
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "test@blame.local"]);
  await git(root, ["config", "user.name", "Blame Test"]);
  await writeFile(join(root, ".gitignore"), "ignored.log\n.blame/\n");
  for (const name of ["mine", "reverted", "shared", "story", "touched"])
    await writeFile(join(root, `${name}.txt`), `${name}\n`);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "base"]);
  return root;
}

function git(cwd: string, args: string[]) {
  return execFileAsync("git", args, { cwd });
}
