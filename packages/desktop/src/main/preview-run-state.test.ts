import assert from "node:assert/strict";
import test from "node:test";
import type { PreviewManifest } from "@blame/agent-runtime";

import {
  initialPreviewRuntimeSelection,
  previewRunConfigurationStatus,
  previewRunConfigurationServiceIds,
  selectedPreviewRuntimeServiceIds,
  selectedPreviewRunConfiguration,
  shouldStartBrowserPreview,
} from "./preview-run-state.ts";

const configurations = [
  {
    id: "marketing",
    name: "Marketing",
    command: "pnpm dev",
    cwd: "apps/marketing",
    default: true,
    category: "web" as const,
    previewService: "marketing",
    scopes: ["apps/marketing"],
    services: ["marketing"],
  },
  {
    id: "app",
    name: "App",
    command: "pnpm dev",
    cwd: "apps/app",
    default: false,
    category: "web" as const,
    previewService: "app",
    scopes: ["apps/app"],
    services: ["app"],
  },
];
const browserPreviewManifest = {
  confidence: "high",
  project: {},
  setup: [],
  services: [
    {
      id: "web",
      kind: "preview",
      container: { image: "node:24" },
      command: "node web.js",
      endpoints: [
        {
          id: "http",
          protocol: "http",
          port: 3000,
          healthcheck: { type: "http", path: "/", timeoutMs: 30_000 },
        },
      ],
    },
  ],
  caches: [],
  risks: [],
  probes: [],
} as PreviewManifest;

test("selects the story recommendation before the project default", () => {
  const state = initialPreviewRuntimeSelection(configurations, "app");
  assert.equal(
    selectedPreviewRunConfiguration(configurations, state)?.id,
    "app",
  );
});

test("keeps preview stopped when no run configuration was requested", () => {
  for (const requestedId of [null, undefined]) {
    assert.deepEqual(
      initialPreviewRuntimeSelection(configurations, requestedId),
      {
        desiredStatus: "stopped",
        selectedConfigurationId: "marketing",
      },
    );
  }
});

test("reports a selected configuration as running from its target service", () => {
  const state = initialPreviewRuntimeSelection(configurations, "app");
  assert.equal(
    previewRunConfigurationStatus(
      configurations[1],
      [{ service: "app", status: "running" }],
      state,
    ),
    "running",
  );
});

test("treats an intentional clean stop as stopped", () => {
  assert.equal(
    previewRunConfigurationStatus(
      configurations[1],
      [{ exitCode: 0, service: "app", status: "exited" }],
      { desiredStatus: "stopped", selectedConfigurationId: "app" },
    ),
    "stopped",
  );
});

test("treats a container stopped by a signal as stopped, not failed", () => {
  for (const exitCode of [130, 137, 143]) {
    assert.equal(
      previewRunConfigurationStatus(
        configurations[1],
        [{ exitCode, service: "app", status: "exited" }],
        { desiredStatus: "stopped", selectedConfigurationId: "app" },
      ),
      "stopped",
    );
  }
});

test("keeps a restarting configuration starting while its services are stopped", () => {
  assert.equal(
    previewRunConfigurationStatus(
      configurations[1],
      [{ exitCode: 143, service: "app", status: "exited" }],
      {
        desiredStatus: "running",
        selectedConfigurationId: "app",
        lifecycle: {
          phase: "starting",
          status: "pending",
          since: new Date().toISOString(),
        },
      },
    ),
    "starting",
  );
});

test("reports a crash as an error even while starting", () => {
  assert.equal(
    previewRunConfigurationStatus(
      configurations[1],
      [{ exitCode: 1, service: "app", status: "exited" }],
      {
        desiredStatus: "running",
        selectedConfigurationId: "app",
        lifecycle: {
          phase: "starting",
          status: "pending",
          since: new Date().toISOString(),
        },
      },
    ),
    "error",
  );
});

test("reports an unexpected clean exit from the selected service", () => {
  assert.equal(
    previewRunConfigurationStatus(
      configurations[1],
      [{ exitCode: 0, service: "app", status: "exited" }],
      { desiredStatus: "running", selectedConfigurationId: "app" },
    ),
    "error",
  );
});

test("reports unhealthy target services as errors", () => {
  assert.equal(
    previewRunConfigurationStatus(
      configurations[0],
      [{ health: "unhealthy", service: "marketing", status: "running" }],
      { desiredStatus: "running", selectedConfigurationId: "marketing" },
    ),
    "error",
  );
});

test("includes backend dependencies in a web run configuration", () => {
  const manifest = {
    services: [
      { id: "database", kind: "dependency" },
      { id: "backend", kind: "worker", dependsOn: ["database"] },
      {
        id: "app",
        kind: "preview",
        bindings: [
          {
            exposure: "server",
            source: { endpoint: "http", service: "backend" },
            target: { key: "API_URL", type: "environment" },
          },
        ],
      },
    ],
  } as PreviewManifest;
  assert.deepEqual(
    previewRunConfigurationServiceIds(configurations[1], manifest),
    ["app", "backend", "database"],
  );
});

test("starts browser binding sources for a selected web configuration", () => {
  const manifest = {
    services: [
      { id: "database", kind: "dependency" },
      { id: "backend", kind: "worker", dependsOn: ["database"] },
      {
        id: "app",
        kind: "preview",
        bindings: [
          {
            exposure: "browser",
            source: { endpoint: "http", service: "backend" },
            target: { key: "PUBLIC_API_URL", type: "environment" },
          },
        ],
      },
    ],
  } as PreviewManifest;

  assert.deepEqual(
    selectedPreviewRuntimeServiceIds(
      configurations,
      { desiredStatus: "running", selectedConfigurationId: "app" },
      ["database", "backend", "app"],
      manifest,
    ),
    ["app", "backend", "database"],
  );
});

test("does not start a browser for a manifest without a preview service", () => {
  const manifest = {
    services: [{ id: "worker", kind: "worker" }],
  } as PreviewManifest;
  assert.equal(
    shouldStartBrowserPreview([], { desiredStatus: "running" }, manifest),
    false,
  );
});

test("does not start a browser for selected service or terminal runs", () => {
  for (const category of ["service", "terminal"] as const) {
    const configuration = {
      ...configurations[0],
      category,
      previewService: "web",
      services: ["web"],
    };
    assert.equal(
      shouldStartBrowserPreview(
        [configuration],
        initialPreviewRuntimeSelection([configuration], undefined),
        browserPreviewManifest,
      ),
      false,
    );
  }
});

test("starts a browser for the selected web preview", () => {
  const configuration = {
    ...configurations[0],
    category: "web" as const,
    previewService: "web",
    services: ["web"],
  };
  assert.equal(
    shouldStartBrowserPreview(
      [configuration],
      initialPreviewRuntimeSelection([configuration], configuration.id),
      browserPreviewManifest,
    ),
    true,
  );
});

test("does not start a browser when the agent selected no preview", () => {
  const configuration = {
    ...configurations[0],
    category: "web" as const,
    previewService: "web",
    services: ["web"],
  };
  assert.equal(
    shouldStartBrowserPreview(
      [configuration],
      { desiredStatus: "stopped" },
      browserPreviewManifest,
    ),
    false,
  );
});

test("does not infer a browser launch without a selected configuration", () => {
  assert.equal(
    shouldStartBrowserPreview(
      [],
      { desiredStatus: "running" },
      browserPreviewManifest,
    ),
    false,
  );
});

test("does not infer browser previews without a canonical manifest", () => {
  assert.equal(
    shouldStartBrowserPreview([], { desiredStatus: "running" }, undefined),
    false,
  );
  assert.equal(
    shouldStartBrowserPreview(
      configurations,
      initialPreviewRuntimeSelection(configurations, undefined),
      undefined,
    ),
    false,
  );
  const untrustedPreview = {
    ...configurations[0],
    previewService: "marketing",
  };
  assert.equal(
    shouldStartBrowserPreview(
      [untrustedPreview],
      initialPreviewRuntimeSelection([untrustedPreview], undefined),
      undefined,
    ),
    false,
  );
});

test("returns no compose targets when setup has no runtime services", () => {
  assert.deepEqual(
    selectedPreviewRuntimeServiceIds(
      configurations,
      initialPreviewRuntimeSelection(configurations, undefined),
      [],
    ),
    [],
  );
});

test("does not start unrelated compose services for a host-only desktop configuration", () => {
  const desktopConfiguration = {
    id: "desktop",
    name: "Desktop development",
    command: "pnpm dev",
    cwd: ".",
    default: true,
    category: "desktop" as const,
    services: [],
    scopes: ["desktop", "backend"],
  };
  const state = initialPreviewRuntimeSelection(
    [desktopConfiguration],
    undefined,
  );

  assert.deepEqual(
    selectedPreviewRuntimeServiceIds([desktopConfiguration], state, [
      "vitrine",
      "api",
    ]),
    [],
  );
  assert.equal(
    previewRunConfigurationStatus(desktopConfiguration, [], state),
    "stopped",
  );
});

test("selects only explicitly configured runtime services", () => {
  const state = initialPreviewRuntimeSelection(configurations, "app");
  assert.deepEqual(
    selectedPreviewRuntimeServiceIds(configurations, state, [
      "marketing",
      "app",
    ]),
    ["app"],
  );
  assert.deepEqual(
    selectedPreviewRuntimeServiceIds([], state, ["marketing", "app"]),
    [],
  );
});
