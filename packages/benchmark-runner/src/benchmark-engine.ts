// The engine a benchmark runs on: Blame's engine host in this process, with
// its own `blame-engine` (data in a scratch folder, kept on this machine)
// and the harness runner that the desktop app starts too.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FollowEvent, SessionRecord } from "@blame/engine-client";
import {
  EngineHost,
  harnessRunnerPath,
  type EngineHostEvent,
} from "@blame/agent-runtime/engine";
import type { BenchmarkConfig, BenchmarkEngine } from "./contracts.js";
import { ProjectMemoryFile } from "./project-memory-file.js";

export function benchmarkEngine(config: BenchmarkConfig): BenchmarkEngine {
  const dataDir = mkdtempSync(join(tmpdir(), "blame-benchmark-engine-"));
  const events: EngineHostEvent[] = [];
  const listeners = new Set<() => void>();
  const host = new EngineHost({
    binary: engineBinary(),
    dataDir,
    harnessCommand: [process.execPath, harnessRunnerPath(), "--serve"],
    clientVersion: "benchmark",
    env: {
      ...process.env,
      BLAME_ENGINE_LOG: process.env.BLAME_ENGINE_LOG ?? "warn",
      BLAME_HARNESS_TRACE_FILE: config.harnessTracePath,
    },
    emit: (event) => {
      events.push(event);
      for (const listener of listeners) listener();
    },
    ...(config.projectMemoryFile
      ? { projectMemory: new ProjectMemoryFile(config.projectMemoryFile) }
      : {}),
  });
  const connected = host.call("connect", {
    api: { url: config.apiUrl, token: config.apiToken },
  });
  return {
    async runStoryTask(input) {
      await connected;
      return host.runStoryTask(input);
    },
    async records(session) {
      const subscription = `benchmark-${session}`;
      const followed = () =>
        events.flatMap((event) =>
          event.type === "follow" && event.subscription === subscription
            ? [event.event]
            : [],
        );
      const live = new Promise<void>((resolve, reject) => {
        const check = () => {
          const state = followed()
            .filter(
              (event): event is Extract<FollowEvent, { type: "state" }> =>
                event.type === "state",
            )
            .at(-1);
          if (state?.state === "live") resolve();
          else if (state?.state === "stopped")
            reject(new Error(`The run's records could not be read: ${String(state.error ?? "")}`));
          else return;
          listeners.delete(check);
        };
        listeners.add(check);
        check();
      });
      await host.call("follow", { session, subscription });
      await live;
      await host.call("unfollow", { subscription });
      return followed().flatMap((event) =>
        event.type === "records" ? (event.records as SessionRecord[]) : [],
      );
    },
    async shutdown() {
      try {
        await host.shutdown();
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * `BLAME_ENGINE_BIN`, else the binary shipped in the benchmark payload
 * (`engine/<platform>-<arch>/`), else this checkout's debug build.
 */
export function engineBinary() {
  const configured = process.env.BLAME_ENGINE_BIN?.trim();
  if (configured) return configured;
  const executable = process.platform === "win32" ? "blame-engine.exe" : "blame-engine";
  const candidates = [
    fileURLToPath(
      new URL(`../engine/${process.platform}-${process.arch}/${executable}`, import.meta.url),
    ),
    fileURLToPath(new URL(`../../../target/debug/${executable}`, import.meta.url)),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found)
    throw new Error(
      "No blame-engine binary: set BLAME_ENGINE_BIN, ship one in the payload, or run `cargo build -p blame-engine`.",
    );
  return found;
}
