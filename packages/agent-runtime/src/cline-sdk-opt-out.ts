import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// The Cline SDK carries telemetry, feature flags and Langfuse tracing of its
// own. Blame keeps them off for its agents, whatever the user's environment or
// Cline install says: agents read Cline's global settings from Blame's own
// file, with Cline's telemetry opt-out set, and never see the variables that
// switch those services on.

const clineReportingVariable =
  /^(?:OTEL_TELEMETRY_ENABLED|TELEMETRY_SERVICE_API_KEY|LANGFUSE_\w+|CLINE_LANGFUSE_\w+|CLINE_TRACE_\w+)$/;

export function clineAgentEnvironment(
  env: NodeJS.ProcessEnv,
  settingsPath: string,
): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(([key]) => !clineReportingVariable.test(key)),
    ),
    CLINE_GLOBAL_SETTINGS_PATH: settingsPath,
  };
}

// Keeps the other settings the SDK stored in the file.
export function writeClineTelemetryOptOut(settingsPath: string) {
  const settings = { ...readSettings(settingsPath), telemetryOptOut: true };
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function readSettings(path: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
