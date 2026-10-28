import type { PreviewManifest, ProjectRunConfiguration } from "./types.js";
import type { PreviewSurfaceInfo } from "./preview-surface-tools.js";
export type PreviewInitialization = { previewManifest: PreviewManifest; runConfigurations: ProjectRunConfiguration[]; runConfigurationId?: string };
export function selectedInitializationConfiguration(initialization?: PreviewInitialization, scope?: string) {
  const configurations = initialization?.runConfigurations ?? [];
  const selected = initialization?.runConfigurationId ?? (scope?.startsWith("runner:") ? scope.split(":").at(-1) : undefined);
  return configurations.find((c) => c.id === selected) ?? configurations.find((c) => c.default) ?? configurations[0];
}
export function initializationSurface(initialization?: PreviewInitialization, scope?: string): PreviewSurfaceInfo | undefined {
  const configuration = selectedInitializationConfiguration(initialization,scope);
  if (!configuration) return;
  if (configuration.previewTarget) return { type: "device", targetId: configuration.previewTarget };
  const service = initialization?.previewManifest.services.find((s) => s.id === configuration.previewService);
  if (service?.surface?.type === "terminal") return { type: "terminal", serviceId: service.id };
  if (service?.surface?.type === "display") return { type: "display", serviceId: `${service.id}__display` };
  if (configuration.category === "desktop" && !configuration.services.length) return { type: "host-window" };
}
