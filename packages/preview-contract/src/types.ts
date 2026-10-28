export type PreviewManifestConfidence = "low" | "medium" | "high";

export type PreviewManifestEnvironment = Record<string, string>;

export type PreviewManifestProject = {
  root?: string;
  detectedStack?: string[];
  confidence?: PreviewManifestConfidence;
};

export type PreviewManifestContainerBuild = {
  context: string;
  dockerfile: string;
  target?: string;
};

/** Exactly one of image or build is accepted by the parser. */
export type PreviewManifestContainer = {
  image?: string;
  build?: PreviewManifestContainerBuild;
};

export type PreviewManifestSetupTask = {
  id: string;
  container: PreviewManifestContainer;
  workingDir?: string;
  command: string;
  entrypoint?: string[];
  runAs?: "host" | "root";
  environment?: PreviewManifestEnvironment;
  dependsOn?: string[];
};

export type PreviewManifestServiceKind = "preview" | "dependency" | "worker";

/** What a preview shows; omitted means a web page. */
export type PreviewManifestSurface =
  | { type: "web"; device?: "phone" | "tablet" }
  | { type: "terminal"; columns?: number; rows?: number }
  | { type: "display"; width?: number; height?: number };

export type PreviewManifestEndpointHealthcheck = {
  type: "http" | "tcp";
  path?: string;
  timeoutMs: number;
};

export type PreviewManifestEndpoint = {
  id: string;
  protocol: "http" | "https" | "tcp";
  port: number;
  healthcheck?: PreviewManifestEndpointHealthcheck;
};

export type PreviewManifestBindingTarget = {
  type: "environment";
  key: string;
};

export type PreviewManifestBindingSource = {
  service: string;
  endpoint: string;
};

export type PreviewManifestBinding = {
  target: PreviewManifestBindingTarget;
  source: PreviewManifestBindingSource;
  exposure: "server" | "browser";
  format?: "url" | "host" | "port" | "host-port";
  path?: string;
};

export type PreviewManifestService = {
  id: string;
  kind: PreviewManifestServiceKind;
  container: PreviewManifestContainer;
  workingDir?: string;
  command?: string;
  entrypoint?: string[];
  user?: string;
  environment?: PreviewManifestEnvironment;
  dependsOn?: string[];
  endpoints: PreviewManifestEndpoint[];
  bindings?: PreviewManifestBinding[];
  surface?: PreviewManifestSurface;
};

export type PreviewManifestProbeTarget = {
  service: string;
  endpoint: string;
  path?: string;
};

export type PreviewManifestProbe = {
  id: string;
  from: "host" | string;
  target: PreviewManifestProbeTarget;
  type: "http" | "tcp";
  acceptedStatuses?: number[];
  timeoutMs?: number;
  required?: boolean;
};

export type PreviewManifestCache = {
  name: string;
  target: string;
};

export type PreviewManifestRisk = {
  level: "low" | "medium" | "high";
  message: string;
};

/** Canonical, unversioned preview manifest. */
export type PreviewManifest = {
  confidence: PreviewManifestConfidence;
  project: PreviewManifestProject;
  setup: PreviewManifestSetupTask[];
  services: PreviewManifestService[];
  caches: PreviewManifestCache[];
  risks: PreviewManifestRisk[];
  probes: PreviewManifestProbe[];
};
