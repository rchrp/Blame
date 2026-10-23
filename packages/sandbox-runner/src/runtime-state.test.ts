import assert from "node:assert/strict";
import test from "node:test";
import type { PreviewExecutionPlan } from "@blame/preview-runtime";
import {
  assertRuntimeStateSnapshotSafe,
  initialRuntimeState,
} from "./runtime-state.js";

test("never serializes real credentials or signed URLs into runner state", () => {
  const state = initialRuntimeState();
  state.plan = plan({ API_TOKEN: "literal", MYSQL_ROOT_PASSWORD: "blame" });
  assert.doesNotThrow(() => assertRuntimeStateSnapshotSafe(state));

  state.plan = plan({ SIGNING_KEY: "-----BEGIN PRIVATE KEY-----\nabc" });
  assert.throws(() => assertRuntimeStateSnapshotSafe(state), /Secret material/);

  state.plan = plan({ UPSTREAM: "https://user:pass@api.example.com" });
  assert.throws(() => assertRuntimeStateSnapshotSafe(state), /Secret material/);

  state.plan = plan({ PUBLIC_ORIGIN: "https://app.example" });
  state.browserBindingUrls = {
    "app:http": "https://app.example/?X-Amz-Signature=secret",
  };
  assert.throws(
    () => assertRuntimeStateSnapshotSafe(state),
    /credential-bearing URLs/,
  );
});

function plan(environment: Record<string, string>) {
  return {
    version: 2,
    workspaceRoot: "/workspace",
    setup: [],
    services: [
      {
        id: "app",
        kind: "preview",
        container: { image: "node:24" },
        workingDir: "/workspace",
        command: "node app.js",
        environment,
        dependsOn: [],
        endpoints: [],
        bindings: [],
      },
    ],
    caches: [],
    probes: [],
    environmentPlan: { entries: [], cleanupRequired: true },
    networking: {
      gatewayListeners: [],
      loopbackGroups: [],
      publishedPortCount: 0,
      browserBindingCount: 0,
      requiresSharedLoopback: false,
      requiresWebSockets: false,
      integratedPreviewRequired: false,
      incompatibilityReasons: [],
    },
    detectedCompatibility: [],
  } satisfies PreviewExecutionPlan;
}
