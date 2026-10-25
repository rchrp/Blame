import assert from "node:assert/strict";
import { test } from "node:test";
import { attachmentOpenInput } from "./attachment-open-input.ts";

test("opens only document/media extensions and sanitizes paths", () => {
  const content = new Uint8Array([1, 2, 3]);
  assert.deepEqual(attachmentOpenInput({ name: "../../recording.MP3", content }), { name: "recording.mp3", content });
  assert.equal(attachmentOpenInput({ name: "C:\\Users\\someone\\report.docx", content }).name, "report.docx");
  for (const name of ["setup.exe", "script.sh", "link.desktop", "song.mp3.exe", "file", "malware.app", "file.url"]) {
    assert.throws(() => attachmentOpenInput({ name, content }), /Download/);
  }
})

test("validates IPC payloads and size", () => {
  for (const input of [null, {}, { name: "audio.wav", content: "not bytes" }]) assert.throws(() => attachmentOpenInput(input), /Invalid/);
  assert.throws(() => attachmentOpenInput({ name: "audio.wav", content: new Uint8Array(100 * 1024 * 1024 + 1) }), /too large/);
})
