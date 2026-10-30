import type { ServiceLaunchPlan } from "../domain/execution-plan.js";
import { previewDisplayImage } from "../compose/blame-images.js";

export function displaySurfaceServices(
  service: ServiceLaunchPlan,
  dimensions: { width?: number; height?: number },
  image?: string,
): ServiceLaunchPlan[] {
  const width = dimensions.width ?? 1280,
    height = dimensions.height ?? 800;
  const sidecarServiceId = `${service.id}__display`;
  const surface = {
    type: "display" as const,
    width,
    height,
    endpointId: "display" as const,
    sidecarServiceId,
  };
  return [
    {
      ...service,
      surface,
      environment: { ...service.environment, DISPLAY: ":99" },
      dependsOn: [...service.dependsOn, sidecarServiceId],
    },
    {
      id: sidecarServiceId,
      kind: "dependency",
      container: { image: previewDisplayImage(image) },
      workingDir: "/",
      // A restart reuses the container and its X11 volume: the lock and
      // socket of the previous X server would stop the new one at once.
      command: `rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 && blame-display serve --display :99 --geometry ${width}x${height} --port 6080`,
      environment: { DISPLAY: ":99" },
      dependsOn: [],
      endpoints: [
        {
          id: "display",
          protocol: "http",
          port: 6080,
          healthcheck: { type: "tcp", timeoutMs: 30000 },
        },
      ],
      bindings: [],
      surface,
    },
  ];
}
