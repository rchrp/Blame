import type {
  PreviewManifest,
  PreviewManifestDeviceTarget,
} from "@blame/preview-contract";
export type DeviceEndpoint = {
  serviceId: string;
  endpointId: string;
  port: number;
};
export function deviceBindings(
  target: PreviewManifestDeviceTarget,
  manifest: PreviewManifest,
  published: DeviceEndpoint[],
) {
  const environment = { ...target.environment };
  const reverse = new Map<number, number>();
  const needed = new Set([
    ...(target.dependsOn ?? []),
    ...(target.bindings ?? []).map((b) => b.source.service),
  ]);
  for (const service of manifest.services.filter((s) => needed.has(s.id))) {
    for (const endpoint of service.endpoints) {
      const route = published.find(
        (r) => r.serviceId === service.id && r.endpointId === endpoint.id,
      );
      if (!route)
        throw new Error(
          `The ${service.id} service is not ready. Start its preview and try again.`,
        );
      if (target.platform === "android") {
        if (
          reverse.has(endpoint.port) &&
          reverse.get(endpoint.port) !== route.port
        )
          throw new Error(
            `Two device dependencies use port ${endpoint.port}. Choose distinct service ports.`,
          );
        reverse.set(endpoint.port, route.port);
      }
      if (
        (target.toolchain === "expo" || target.toolchain === "react-native") &&
        endpoint.port === 8081
      )
        environment.RCT_METRO_PORT = String(
          target.platform === "ios" ? route.port : 8081,
        );
    }
  }
  for (const binding of target.bindings ?? []) {
    const endpoint = manifest.services
      .find((s) => s.id === binding.source.service)
      ?.endpoints.find((e) => e.id === binding.source.endpoint);
    const route = published.find(
      (r) =>
        r.serviceId === binding.source.service &&
        r.endpointId === binding.source.endpoint,
    );
    if (!route || !endpoint)
      throw new Error("A service needed by this device is not ready.");
    const host = target.platform === "ios" ? "127.0.0.1" : "localhost",
      port = target.platform === "ios" ? route.port : endpoint.port;
    environment[binding.target.key] =
      binding.format === "host"
        ? host
        : binding.format === "port"
          ? String(port)
          : binding.format === "host-port"
            ? `${host}:${port}`
            : `${endpoint.protocol}://${host}:${port}${binding.path ?? ""}`;
  }
  return {
    environment,
    reverse: [...reverse].map(([devicePort, hostPort]) => ({
      devicePort,
      hostPort,
    })),
  };
}
