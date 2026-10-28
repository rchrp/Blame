import type {
  PreviewManifest,
  PreviewManifestService,
  PreviewLifecycleState,
  ProjectRunConfiguration,
  ProjectRunConfigurationStatus,
} from "@blame/agent-runtime";

export type PreviewRuntimeSelectionState = {
  desiredStatus: "running" | "stopped";
  lifecycle?: PreviewLifecycleState;
  selectedConfigurationId?: string;
};

export type PreviewRuntimeContainerState = {
  exitCode?: number;
  health?: string;
  service: string;
  status?: string;
};

export function initialPreviewRuntimeSelection(
  configurations: ProjectRunConfiguration[],
  requestedId: string | null | undefined,
): PreviewRuntimeSelectionState {
  const requested = configurations.find(({ id }) => id === requestedId);
  const selected =
    requested ??
    configurations.find(({ default: isDefault }) => isDefault) ??
    configurations[0];
  return {
    desiredStatus: requested ? "running" : "stopped",
    ...(selected ? { selectedConfigurationId: selected.id } : {}),
  };
}

export function selectedPreviewRunConfiguration(
  configurations: ProjectRunConfiguration[],
  state: PreviewRuntimeSelectionState,
) {
  return (
    configurations.find(({ id }) => id === state.selectedConfigurationId) ??
    configurations.find(({ default: isDefault }) => isDefault) ??
    configurations[0]
  );
}

export function shouldStartBrowserPreview(
  configurations: ProjectRunConfiguration[],
  state: PreviewRuntimeSelectionState,
  manifest: PreviewManifest | undefined,
) {
  if (state.desiredStatus !== "running") return false;
  const selected = selectedPreviewRunConfiguration(configurations, state);
  if (!manifest || !selected) return false;
  if (selected.category !== "web" && selected.category !== "mobile") return false;
  return manifest.services.some(
    (service) =>
      service.id === selected.previewService && browserPreviewService(service),
  );
}

export function selectedPreviewRuntimeServiceIds(
  configurations: ProjectRunConfiguration[],
  state: PreviewRuntimeSelectionState,
  runtimeServiceIds: string[],
  manifest?: PreviewManifest,
) {
  const selected = selectedPreviewRunConfiguration(configurations, state);
  if (!selected) return [];
  const runtimeServices = new Set(runtimeServiceIds);
  if (selected && hostOnlyRunConfiguration(selected)) return [];
  const selectedServices = manifest
    ? previewRunConfigurationServiceIds(selected, manifest)
    : selected.services;
  return selectedServices.filter((service) => runtimeServices.has(service));
}

export function previewRunConfigurationStatus(
  configuration: ProjectRunConfiguration,
  containers: PreviewRuntimeContainerState[],
  runtimeState: PreviewRuntimeSelectionState,
): ProjectRunConfigurationStatus {
  const services = configuration.services;
  if (hostOnlyRunConfiguration(configuration)) return "stopped";
  const matching = containers.filter(({ service }) =>
    services.includes(service),
  );
  const selected =
    runtimeState.desiredStatus === "running" &&
    runtimeState.selectedConfigurationId === configuration.id;
  // A stop is expected unless this configuration should be running and no
  // start, restart or stop is under way.
  const stopExpected =
    !selected || runtimeState.lifecycle?.status === "pending";
  if (
    matching.some((container) =>
      runtimeContainerFailed(container, stopExpected),
    )
  )
    return "error";
  if (!stopExpected && matching.some(({ status }) => status === "exited")) {
    return "error";
  }
  if (
    services.length > 0 &&
    services.every((service) => serviceRunning(service, matching))
  ) {
    return "running";
  }
  if (selected) return "starting";
  return "stopped";
}

function hostOnlyRunConfiguration(configuration: ProjectRunConfiguration) {
  if (configuration.services.length) return false;
  return (
    configuration.category === "desktop" ||
    configuration.category === "mobile" ||
    configuration.category === "terminal" ||
    configuration.category === "other"
  );
}

export function previewRunConfigurationServiceIds(
  configuration: ProjectRunConfiguration,
  manifest: PreviewManifest,
) {
  const runtimeServices = new Set(manifest.services.map(({ id }) => id));
  const active = new Set(configuration.services);
  const pending = Array.from(active);
  while (pending.length) {
    const serviceId = pending.shift();
    const service = manifest.services.find(({ id }) => id === serviceId);
    if (!service) continue;
    for (const dependency of previewServiceDependencies(service)) {
      if (!runtimeServices.has(dependency) || active.has(dependency)) continue;
      active.add(dependency);
      pending.push(dependency);
    }
  }
  return Array.from(active);
}

function previewServiceDependencies(service: PreviewManifestService) {
  return Array.from(
    new Set([
      ...(service.dependsOn ?? []),
      ...(service.bindings ?? []).map(({ source }) => source.service),
    ]),
  );
}

function browserPreviewService(service: PreviewManifestService) {
  return (
    service.kind === "preview" &&
    service.endpoints.some(({ protocol }) => protocol !== "tcp")
  );
}

function serviceRunning(
  service: string,
  containers: PreviewRuntimeContainerState[],
) {
  return containers.some(
    (container) =>
      container.service === service && container.status === "running",
  );
}

// Exit codes of a container stopped by a signal: Docker stops containers
// with SIGTERM, then SIGKILL after the grace period.
const stoppedExitCodes = new Set([0, 130, 137, 143]);

function runtimeContainerFailed(
  container: PreviewRuntimeContainerState,
  stopExpected: boolean,
) {
  if (container.health === "unhealthy" || container.status === "dead")
    return true;
  if (container.status === "removing") return !stopExpected;
  if (container.status !== "exited") return false;
  return !(stopExpected && stoppedExitCodes.has(container.exitCode ?? -1));
}
