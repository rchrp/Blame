import type {
  PreviewExecutionPlan,
  RuntimeSelection,
} from "../domain/execution-plan.js";
import { ComposeEngineError } from "./docker-host.js";

export function normalizeRuntimeSelection(
  plan: PreviewExecutionPlan,
  requested: RuntimeSelection,
): RuntimeSelection {
  if (!requested.configurationId?.trim()) {
    throw new ComposeEngineError(
      "INVALID_SELECTION",
      "A preview configuration ID is required.",
    );
  }
  const services = new Map(
    plan.services.map((service) => [service.id, service]),
  );
  const selected = new Set(
    requested.serviceIds === undefined ? services.keys() : requested.serviceIds,
  );
  const unknown = [...selected].filter((id) => !services.has(id));
  if (unknown.length) {
    throw new ComposeEngineError(
      "INVALID_SELECTION",
      `Unknown selected services: ${unknown.join(", ")}.`,
    );
  }
  for (const id of selected) {
    for (const dependency of services.get(id)!.dependsOn)
      selected.add(dependency);
  }
  assertLogicalPortsUnambiguous(plan, selected);
  assertPrimaryRoute(plan, selected, requested.primaryRoute);
  return {
    configurationId: requested.configurationId,
    serviceIds: [...selected],
    ...(requested.primaryRoute
      ? { primaryRoute: { ...requested.primaryRoute } }
      : {}),
  };
}

function assertPrimaryRoute(
  plan: PreviewExecutionPlan,
  selected: Set<string>,
  primaryRoute: RuntimeSelection["primaryRoute"],
) {
  if (!primaryRoute) return;
  const listener = plan.networking.gatewayListeners.find(
    ({ serviceId, endpointId }) =>
      serviceId === primaryRoute.serviceId &&
      endpointId === primaryRoute.endpointId,
  );
  if (!listener || !selected.has(primaryRoute.serviceId)) {
    throw new ComposeEngineError(
      "INVALID_SELECTION",
      "The primary route must identify a published endpoint in the selected service set.",
    );
  }
}

export function selectedSetupTasks(
  plan: PreviewExecutionPlan,
  selectedServiceIds: string[],
) {
  const serviceIds = new Set(plan.services.map(({ id }) => id));
  const setupIds = new Set(plan.setup.map(({ id }) => id));
  const selectedServices = new Set(selectedServiceIds);
  const selectedSetup = new Set<string>();
  return plan.setup.filter((task) => {
    const eligible = task.dependsOn.every((dependency) =>
      serviceIds.has(dependency)
        ? selectedServices.has(dependency)
        : !setupIds.has(dependency) || selectedSetup.has(dependency),
    );
    if (eligible) selectedSetup.add(task.id);
    return eligible;
  });
}

function assertLogicalPortsUnambiguous(
  plan: PreviewExecutionPlan,
  selected: Set<string>,
) {
  const ports = new Map<number, string>();
  for (const listener of plan.networking.gatewayListeners) {
    if (!selected.has(listener.serviceId)) continue;
    const owner = ports.get(listener.logicalPort);
    if (owner && owner !== listener.serviceId) {
      throw new ComposeEngineError(
        "DUPLICATE_LOGICAL_PORT",
        `Selected services ${owner} and ${listener.serviceId} both publish localhost:${listener.logicalPort}.`,
      );
    }
    ports.set(listener.logicalPort, listener.serviceId);
  }
}
