export type PreviewEndpointProtocol = "http" | "https" | "ws" | "wss";

export type PreviewEndpointRoute = {
  surface?: "web" | "terminal" | "display";
  routeId: string;
  serviceId: string;
  endpointId: string;
  protocol: PreviewEndpointProtocol;
  logicalHost: "localhost";
  logicalPort: number;
  targetHost: string;
  targetPort: number;
  sandboxPort: number;
  publicUrl: string;
  basePathMode: "root" | "explicit-prefix";
  externallyCompatible: boolean;
};

export type EndpointMap = {
  revision: number;
  primaryRouteId: string;
  primaryPublicUrl: string;
  routes: PreviewEndpointRoute[];
  supportsWebSocket: boolean;
  integratedPreviewRequired: boolean;
  incompatibilityReasons: string[];
};

export type PreviewEndpointRef = { serviceId: string; endpointId: string };

export function endpointRouteKey(serviceId: string, endpointId: string) {
  return `${serviceId}:${endpointId}`;
}

export function publicEndpointMap(map: EndpointMap): EndpointMap {
  return {
    ...map,
    routes: map.routes.map((route) => ({ ...route })),
  };
}
