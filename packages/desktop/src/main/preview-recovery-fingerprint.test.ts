import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectRunConfiguration } from "@blame/agent-runtime";
import { previewRecoveryFailureFingerprint } from "./preview-recovery-fingerprint.ts";

const configurations: ProjectRunConfiguration[] = [
  {
    id: "web",
    name: "Web",
    command: "pnpm dev",
    cwd: ".",
    category: "web",
    default: true,
    previewService: "web",
    services: ["web", "api"],
    scopes: ["web"],
  },
];
const runtimeState = {
  desiredStatus: "running" as const,
  selectedConfigurationId: "web",
};

function fingerprint(message: string) {
  return previewRecoveryFailureFingerprint(
    "config",
    configurations,
    runtimeState,
    new Error(message),
    "preview_start_failed",
  );
}

test("a failure that quotes fresh log lines each time still repeats", () => {
  const quoted = (time: number, id: string) =>
    `Service api failed its healthcheck. Its last lines: {"level":50,"time":${time},"request_id":"${id}","msg":"connect ECONNREFUSED 192.168.5.2:13307"}`;
  assert.equal(
    fingerprint(quoted(1793914916581, "8fbfd59f-2cd2-4577-913c-7ec043b2804d")),
    fingerprint(quoted(1793914977272, "a39f3b10-0324-4412-93d0-2e1a18c4094f")),
  );
  assert.equal(
    fingerprint("Timed out after 600000ms at 2026-11-05T21:42:21.241Z"),
    fingerprint("Timed out after 600000ms at 2026-11-05T21:43:22.093Z"),
  );
});

test("different failures stay apart", () => {
  assert.notEqual(
    fingerprint("Service api failed its healthcheck. Its last lines: boom"),
    fingerprint("Service web failed its healthcheck. Its last lines: boom"),
  );
  assert.notEqual(
    fingerprint("Service api exited"),
    fingerprint("Service api failed its healthcheck"),
  );
});
