import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isTelemetryOptedOutGlobally } from "@cline/sdk";
import {
  clineAgentEnvironment,
  writeClineTelemetryOptOut,
} from "./cline-sdk-opt-out.js";

function withSettingsPath(run: (path: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "blame-cline-settings-"));
  try {
    run(join(directory, "cline", "global-settings.json"));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

test("agents never see the variables that switch on the Cline SDK's reporting", () => {
  const env = clineAgentEnvironment(
    {
      CLINE_LANGFUSE_ALL_PROVIDERS: "1",
      CLINE_TRACE_RECORD_CONTENT: "true",
      LANGFUSE_PUBLIC_KEY: "pk",
      LANGFUSE_SECRET_KEY: "sk",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.test",
      OTEL_TELEMETRY_ENABLED: "1",
      PATH: "/usr/bin",
      TELEMETRY_SERVICE_API_KEY: "key",
    },
    "/blame/cline/global-settings.json",
  );

  assert.deepEqual(env, {
    CLINE_GLOBAL_SETTINGS_PATH: "/blame/cline/global-settings.json",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.test",
    PATH: "/usr/bin",
  });
});

test("the opt-out keeps the other settings in the file", () => {
  withSettingsPath((path) => {
    writeClineTelemetryOptOut(path);
    writeFileSync(path, '{"planActMode":"act","telemetryOptOut":false}');
    writeClineTelemetryOptOut(path);

    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      planActMode: "act",
      telemetryOptOut: true,
    });
  });
});

test("the Cline SDK reads the opt-out from the agents' settings file", () => {
  withSettingsPath((path) => {
    const previous = process.env.CLINE_GLOBAL_SETTINGS_PATH;
    process.env.CLINE_GLOBAL_SETTINGS_PATH = path;
    try {
      assert.equal(isTelemetryOptedOutGlobally(), false);
      writeClineTelemetryOptOut(path);
      assert.equal(isTelemetryOptedOutGlobally(), true);
    } finally {
      if (previous === undefined) delete process.env.CLINE_GLOBAL_SETTINGS_PATH;
      else process.env.CLINE_GLOBAL_SETTINGS_PATH = previous;
    }
  });
});
