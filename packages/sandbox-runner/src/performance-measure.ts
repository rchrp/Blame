import { appendFile, mkdir } from "node:fs/promises";

const performanceLog = "/var/log/blame/runtime-performance.jsonl";

export async function measureRunnerPhase<T>(
  phase:
    | "dockerd.start"
    | "compose.prepare"
    | "compose.prepare.cached"
    | "compose.pull"
    | "compose.build"
    | "dependencies.install"
    | "services.start"
    | "baseline.readiness"
    | "preview.readiness"
    | "preview.functional-probes",
  operation: () => Promise<T>,
) {
  const startedAt = performance.now();
  let outcome: "succeeded" | "failed" = "succeeded";
  try {
    return await operation();
  } catch (error) {
    outcome = "failed";
    throw error;
  } finally {
    await recordRunnerMeasure({
      timestamp: new Date().toISOString(),
      phase,
      outcome,
      durationMs: Math.round(Math.max(0, performance.now() - startedAt)),
    }).catch(() => undefined);
  }
}

async function recordRunnerMeasure(value: {
  timestamp: string;
  phase: string;
  outcome: "succeeded" | "failed";
  durationMs: number;
}) {
  await mkdir("/var/log/blame", { recursive: true, mode: 0o700 });
  await appendFile(performanceLog, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
