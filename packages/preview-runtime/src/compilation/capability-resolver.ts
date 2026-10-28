import type { PreviewExecutionPlan } from "../domain/execution-plan.js";
import type {
  CapabilityIncompatibility,
  CapabilityRequirement,
  CapabilityReport,
  RuntimeCapabilities,
} from "../domain/runtime-capabilities.js";
import type { RuntimeProfileId } from "../domain/runtime-profile.js";

const profileCapabilities: Record<RuntimeProfileId, RuntimeCapabilities> = {
  "local-container": {
    terminalSurface: true,
    displaySurface: true,
    dockerCompose: true,
    sharedLoopback: false,
    snapshots: false,
    persistentFilesystem: true,
    publicHttpIngress: false,
    webSockets: true,
    networkPolicy: false,
    credentialBroker: false,
    bidirectionalSync: false,
  },
  "vercel-compose": {
    terminalSurface: false,
    displaySurface: false,
    dockerCompose: true,
    sharedLoopback: true,
    snapshots: true,
    persistentFilesystem: true,
    publicHttpIngress: true,
    webSockets: true,
    networkPolicy: true,
    credentialBroker: false,
    bidirectionalSync: true,
    maxPublishedPorts: 15,
  },
};

export function runtimeCapabilities(
  profile: RuntimeProfileId,
): RuntimeCapabilities {
  return { ...profileCapabilities[profile] };
}

export function resolveCapabilities(
  profile: RuntimeProfileId,
  plan: PreviewExecutionPlan,
  capabilities: RuntimeCapabilities = runtimeCapabilities(profile),
): CapabilityReport {
  const incompatibilities: CapabilityIncompatibility[] = [];
  for (const type of ["terminal", "display"] as const) {
    if (
      plan.services.some((service) => service.surface?.type === type) &&
      !capabilities[`${type}Surface`]
    ) {
      incompatibilities.push({
        code: "SURFACE_UNSUPPORTED",
        capability: `${type}Surface`,
        message: `${type === "terminal" ? "Terminal" : "Screen"} previews need an updated sandbox runner. Update the preview runtime and try again.`,
      });
    }
  }
  requireCapability(
    incompatibilities,
    capabilities,
    "persistentFilesystem",
    "A persistent workspace is required.",
  );
  if (profile !== "local-container") {
    requireCapability(
      incompatibilities,
      capabilities,
      "publicHttpIngress",
      "Cloud preview ingress is unavailable.",
    );
    requireCapability(
      incompatibilities,
      capabilities,
      "bidirectionalSync",
      "Durable cloud synchronization is unavailable.",
    );
    requireCapability(
      incompatibilities,
      capabilities,
      "networkPolicy",
      "An explicit egress policy is required.",
    );
  }
  requireCapability(
    incompatibilities,
    capabilities,
    "dockerCompose",
    "The plan requires Docker Compose.",
  );
  if (plan.networking.requiresSharedLoopback && !capabilities.sharedLoopback) {
    incompatibilities.push({
      code: "COMPOSE_LOOPBACK_UNSUPPORTED",
      capability: "sharedLoopback",
      message:
        "The selected runtime cannot preserve required server-side localhost routes.",
      serviceIds: plan.networking.loopbackGroups.flatMap(
        ({ serviceIds }) => serviceIds,
      ),
    });
  }
  if (plan.networking.requiresWebSockets) {
    requireCapability(
      incompatibilities,
      capabilities,
      "webSockets",
      "The preview requires WebSocket forwarding.",
    );
  }
  if (
    plan.environmentPlan.entries.some(
      ({ classification }) => classification === "secret",
    )
  ) {
    requireCapability(
      incompatibilities,
      capabilities,
      "credentialBroker",
      "The preview requires a credential broker for declared secrets.",
    );
  }
  if (
    capabilities.maxPublishedPorts !== undefined &&
    plan.networking.publishedPortCount > capabilities.maxPublishedPorts
  ) {
    incompatibilities.push({
      code: "PORT_LIMIT_EXCEEDED",
      message: `The plan publishes ${plan.networking.publishedPortCount} ports; the runtime limit is ${capabilities.maxPublishedPorts}.`,
    });
  }
  duplicateLoopbackPorts(plan, incompatibilities);
  return {
    compatible: incompatibilities.length === 0,
    capabilities: { ...capabilities },
    incompatibilities,
  };
}

function requireCapability(
  errors: CapabilityIncompatibility[],
  capabilities: RuntimeCapabilities,
  capability: CapabilityRequirement,
  message: string,
) {
  if (capabilities[capability]) return;
  errors.push({ code: "CAPABILITY_REQUIRED", capability, message });
}

function duplicateLoopbackPorts(
  plan: PreviewExecutionPlan,
  errors: CapabilityIncompatibility[],
) {
  for (const group of plan.networking.loopbackGroups) {
    const owners = new Map<number, string[]>();
    for (const service of plan.services.filter(({ id }) =>
      group.serviceIds.includes(id),
    )) {
      for (const endpoint of service.endpoints) {
        owners.set(endpoint.port, [
          ...(owners.get(endpoint.port) ?? []),
          service.id,
        ]);
      }
    }
    for (const [port, serviceIds] of owners) {
      if (serviceIds.length < 2) continue;
      errors.push({
        code: "DUPLICATE_LOGICAL_PORT",
        message: `Services ${serviceIds.join(", ")} claim loopback port ${port} in the same group.`,
        serviceIds,
      });
    }
  }
}
