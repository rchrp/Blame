import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { liveLogErrors, readLiveLog } from "./live-log-reader.ts";

const now = Date.parse("2026-11-23T12:00:00Z");
const log = [
  "[2026-11-22T10:00:00.000Z] [error] old failure",
  "[2026-11-23T09:00:00.000Z] [info] started",
  "[2026-11-23T10:00:00.000Z] [error] preview failed GH_TOKEN=secret",
  "[2026-11-23T11:00:00.000Z] [unhandledRejection] Error: boom",
  "[2026-11-23T11:30:00.000Z] [warn] slow",
].join("\n");

test("reads the last lines, searched, through the redaction", async () => {
  const folder = await mkdtemp(join(tmpdir(), "blame-log-"));
  try {
    const path = join(folder, "blame-live.log");
    await writeFile(path, `${log}\n`);
    const redact = (line: string) =>
      line.replace(/GH_TOKEN=\S+/g, "GH_TOKEN=<redacted>");
    const recent = await readLiveLog(path, { lines: 2 }, redact);
    assert.equal(recent.total, 5);
    assert.deepEqual(
      recent.lines.map((line) => line.slice(1, 11)),
      ["2026-11-23", "2026-11-23"],
    );
    const found = await readLiveLog(
      path,
      { lines: 10, search: "PREVIEW" },
      redact,
    );
    assert.equal(found.total, 1);
    assert.match(found.lines[0]!, /GH_TOKEN=<redacted>/);
    assert.doesNotMatch(found.lines[0]!, /secret/);
    assert.deepEqual(
      await readLiveLog(join(folder, "missing.log"), { lines: 5 }),
      { total: 0, lines: [] },
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("counts the errors of the last day", async () => {
  const folder = await mkdtemp(join(tmpdir(), "blame-log-"));
  try {
    const path = join(folder, "blame-live.log");
    await writeFile(path, `${log}\n`);
    const errors = await liveLogErrors(path, (line) => line, now);
    assert.equal(errors.errors, 2);
    assert.match(errors.lastError!, /unhandledRejection/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
