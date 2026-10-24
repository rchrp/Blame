import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PreviewExecutionPlan } from "../domain/execution-plan.js";
import {
  normalizeRuntimeSelection,
  selectedSetupTasks,
} from "./service-selection.js";

const plan = {
  version: 2,
  workspaceRoot: "/workspace",
  setup: [],
  caches: [],
  probes: [],
  environmentPlan: { entries: [], cleanupRequired: true },
  networking: {
    gatewayListeners: [listener("web", 43_000), listener("admin", 43_001)],
    loopbackGroups: [],
    publishedPortCount: 2,
    browserBindingCount: 0,
    requiresSharedLoopback: false,
    requiresWebSockets: false,
    integratedPreviewRequired: false,
    incompatibilityReasons: [],
  },
  detectedCompatibility: [],
  services: [
    service("database"),
    service("api", ["database"]),
    service("web", ["api"]),
    service("admin"),
  ],
} satisfies PreviewExecutionPlan;

describe("runtime service selection", () => {
  it("adds the complete dependency closure", () => {
    assert.deepEqual(
      normalizeRuntimeSelection(plan, {
        configurationId: "web",
        serviceIds: ["web"],
      }),
      {
        configurationId: "web",
        serviceIds: ["web", "api", "database"],
      },
    );
  });

  it("rejects an unknown service", () => {
    assert.throws(
      () =>
        normalizeRuntimeSelection(plan, {
          configurationId: "invalid",
          serviceIds: ["other"],
        }),
      /Unknown selected services/,
    );
  });

  it("keeps an explicitly empty host-only service selection empty", () => {
    assert.deepEqual(
      normalizeRuntimeSelection(plan, {
        configurationId: "desktop",
        serviceIds: [],
      }).serviceIds,
      [],
    );
  });

  it("keeps an explicit primary service and endpoint pair", () => {
    const selection = normalizeRuntimeSelection(plan, {
      configurationId: "web",
      serviceIds: ["web"],
      primaryRoute: { serviceId: "web", endpointId: "http" },
    });
    assert.deepEqual(selection.primaryRoute, {
      serviceId: "web",
      endpointId: "http",
    });
    assert.throws(
      () =>
        normalizeRuntimeSelection(plan, {
          configurationId: "web",
          serviceIds: ["web"],
          primaryRoute: { serviceId: "admin", endpointId: "http" },
        }),
      /primary route must identify a published endpoint in the selected service set/,
    );
  });

  it("checks logical port collisions only in the selected service set", () => {
    assert.doesNotThrow(() =>
      normalizeRuntimeSelection(plan, {
        configurationId: "web",
        serviceIds: ["web"],
      }),
    );
    assert.throws(
      () =>
        normalizeRuntimeSelection(plan, {
          configurationId: "combined",
          serviceIds: ["web", "admin"],
        }),
      /both publish localhost:3000/,
    );
  });

  it("runs only setup tasks compatible with the selected service closure", () => {
    const setupPlan = {
      ...plan,
      setup: [
        setup("common"),
        setup("api-schema", ["database"]),
        setup("admin-seed", ["admin"]),
        setup("admin-assets", ["admin-seed"]),
      ],
    } satisfies PreviewExecutionPlan;

    assert.deepEqual(
      selectedSetupTasks(setupPlan, ["web", "api", "database"]).map(
        ({ id }) => id,
      ),
      ["common", "api-schema"],
    );
  });
});

function listener(serviceId: string, sandboxPort: number) {
  return {
    routeKey: `${serviceId}:http`,
    serviceId,
    endpointId: "http",
    logicalPort: 3000,
    sandboxPort,
    targetHost: serviceId,
    targetPort: 3000,
    basePathMode: "root" as const,
  };
}

function service(id: string, dependsOn: string[] = []) {
  return {
    id,
    kind: "preview" as const,
    container: { image: "node:24" },
    workingDir: "/workspace",
    command: "true",
    environment: {},
    dependsOn,
    endpoints: [],
    bindings: [],
  };
}

function setup(id: string, dependsOn: string[] = []) {
  return {
    id,
    container: { image: "node:24" },
    workingDir: "/workspace",
    command: "true",
    runAs: "host" as const,
    environment: {},
    dependsOn,
  };
}
