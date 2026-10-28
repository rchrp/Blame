export type ContainerBuildPlan = {
  context: string;
  dockerfile: string;
  target?: string;
};

export type ContainerPlan = {
  image?: string;
  build?: ContainerBuildPlan;
};

export type RuntimeEnvironment = Record<string, string>;

export type SetupTaskPlan = {
  id: string;
  container: ContainerPlan;
  workingDir: string;
  command: string;
  entrypoint?: string[];
  runAs: "host" | "root";
  environment: RuntimeEnvironment;
  dependsOn: string[];
};

export type ServiceEndpointPlan = {
  id: string;
  protocol: "http" | "https" | "tcp";
  port: number;
  healthcheck?: {
    type: "http" | "tcp";
    path?: string;
    timeoutMs: number;
  };
};

export type ServiceBindingPlan = {
  targetKey: string;
  sourceServiceId: string;
  sourceEndpointId: string;
  exposure: "server" | "browser";
  format: "url" | "host" | "port" | "host-port";
  path: string;
};

export type ServiceLaunchPlan = {
  id: string;
  kind: "preview" | "dependency" | "worker";
  container: ContainerPlan;
  workingDir: string;
  command?: string;
  entrypoint?: string[];
  user?: string;
  environment: RuntimeEnvironment;
  dependsOn: string[];
  endpoints: ServiceEndpointPlan[];
  bindings: ServiceBindingPlan[];
  surface?: ServiceSurfacePlan;
};

export type ServiceSurfacePlan =
  | { type: "web"; device?: "phone" | "tablet" }
  | { type: "terminal"; columns: number; rows: number; endpointId: "terminal" }
  | {
      type: "display";
      width: number;
      height: number;
      endpointId: "display";
      sidecarServiceId: string;
    };

export type CachePlan = { name: string; target: string };

export type ProbePlan = {
  id: string;
  from: "host" | string;
  target: { serviceId: string; endpointId: string; path: string };
  type: "http" | "tcp";
  acceptedStatuses: number[];
  timeoutMs: number;
  required: boolean;
};

export type GatewayListenerPlan = {
  routeKey: string;
  serviceId: string;
  endpointId: string;
  logicalPort: number;
  sandboxPort: number;
  targetHost: string;
  targetPort: number;
  basePathMode: "root" | "explicit-prefix";
};

export type LoopbackGroupPlan = {
  id: string;
  serviceIds: string[];
  logicalPorts: number[];
};

export type NetworkPlan = {
  gatewayListeners: GatewayListenerPlan[];
  loopbackGroups: LoopbackGroupPlan[];
  publishedPortCount: number;
  browserBindingCount: number;
  requiresSharedLoopback: boolean;
  requiresWebSockets: boolean;
  integratedPreviewRequired: boolean;
  incompatibilityReasons: string[];
};

export type CompatibilityRequirement =
  | { type: "shared-loopback"; serviceIds: string[] }
  | { type: "integrated-preview"; reason: string }
  | { type: "websocket" }
  | { type: "bidirectional-sync" }
  | { type: "container-engine" };

export type PreviewExecutionPlan = {
  version: 2 | 3;
  workspaceRoot: "/workspace";
  setup: SetupTaskPlan[];
  services: ServiceLaunchPlan[];
  caches: CachePlan[];
  probes: ProbePlan[];
  environmentPlan: import("./environment-plan.js").SecretPlan;
  networking: NetworkPlan;
  detectedCompatibility: CompatibilityRequirement[];
  tools?: { ttyd?: true };
};

export type RuntimeSelection = {
  configurationId: string;
  serviceIds?: string[];
  primaryRoute?: {
    serviceId: string;
    endpointId: string;
  };
};
