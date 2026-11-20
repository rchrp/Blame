import { createWriteStream, type WriteStream } from "node:fs";
import type { BenchmarkEvent } from "./engine-events.js";
import { BenchmarkMetricsCollector } from "./benchmark-metrics.js";
import type { BenchmarkEventRecorder } from "./contracts.js";

const secretKey = /^(?:access|apiKey|authorization|headers|refresh|token)$/i;

export class JsonlEventRecorder implements BenchmarkEventRecorder {
  private error: Error | undefined;
  private readonly collector = new BenchmarkMetricsCollector();
  private readonly stream: WriteStream;
  eventCount = 0;
  toolEventCount = 0;

  constructor(path: string) {
    this.stream = createWriteStream(path, { encoding: "utf8" });
    this.stream.on("error", (error) => {
      this.error = error;
    });
  }

  record(event: BenchmarkEvent, at = Date.now()) {
    const recordedAt = new Date(at);
    this.eventCount += 1;
    if (event.type === "tool") this.toolEventCount += 1;
    this.collector.record(event, recordedAt.getTime());
    const entry = {
      event: sanitizeValue(event),
      kind: "agent_event",
      recordedAt: recordedAt.toISOString(),
      schemaVersion: 1,
    };
    this.stream.write(`${JSON.stringify(entry)}\n`);
  }

  metrics(startedAt: Date, finishedAt: Date) {
    return this.collector.summary(startedAt, finishedAt);
  }

  close() {
    return new Promise<void>((resolve, reject) => {
      if (this.error) {
        reject(this.error);
        return;
      }
      this.stream.once("error", reject);
      this.stream.end(resolve);
    });
  }
}

export function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (!value || typeof value !== "object") return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "raw") continue;
    sanitized[key] = secretKey.test(key) ? "[REDACTED]" : sanitizeValue(entry);
  }
  return sanitized;
}
