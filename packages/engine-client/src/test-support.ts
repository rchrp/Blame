// Shared by the tests: how to start the fake engine, and small waiting helpers.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineCommand } from "./transport.js";
import type { SessionConfig } from "./protocol.js";

export const fakeEnginePath = fileURLToPath(
  new URL("../test/fake-engine.mjs", import.meta.url),
);

export interface FakeOptions {
  flags?: string[];
  store?: string;
  protocolVersion?: number;
}

export function fakeEngine(options: FakeOptions = {}): EngineCommand {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.FAKE_FLAGS = (options.flags ?? []).join(",");
  if (options.store) env.FAKE_STORE = options.store;
  if (options.protocolVersion !== undefined)
    env.FAKE_PROTOCOL_VERSION = String(options.protocolVersion);
  return { command: process.execPath, args: [fakeEnginePath], env };
}

/** A temporary directory removed when the test ends. */
export function scratchDirectory(): { path: string; remove(): void } {
  const path = mkdtempSync(join(tmpdir(), "engine-client-"));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}

export const sessionConfig: SessionConfig = {
  purpose: "development",
  workspace_root: "/work",
  model: { provider: "fake", model: "fake-1" },
  system_prompt: "system",
  engine_tools: [],
  client_tools: [],
  limits: {},
  checkpoints: true,
};

export const userText = (text: string) => [{ type: "text" as const, text }];

export function waitFor(
  condition: () => boolean,
  what = "a condition",
  timeoutMs = 5_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      if (condition()) return resolve();
      if (Date.now() - started > timeoutMs)
        return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(check, 5);
    };
    check();
  });
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
