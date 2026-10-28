export type RuntimeCapabilities = {
  dockerCompose: boolean;
  sharedLoopback: boolean;
  snapshots: boolean;
  persistentFilesystem: boolean;
  publicHttpIngress: boolean;
  webSockets: boolean;
  networkPolicy: boolean;
  credentialBroker: boolean;
  bidirectionalSync: boolean;
  terminalSurface: boolean;
  displaySurface: boolean;
  maxPublishedPorts?: number;
  /** Workspace snapshot rules the runtime can apply (see workspace-ignore). */
  workspaceSnapshotPolicies?: readonly string[];
};

export type CapabilityRequirement = keyof Omit<
  RuntimeCapabilities,
  "maxPublishedPorts" | "workspaceSnapshotPolicies"
>;

export type CapabilityIncompatibility = {
  code:
    | "CAPABILITY_REQUIRED"
    | "SURFACE_UNSUPPORTED"
    | "PORT_LIMIT_EXCEEDED"
    | "DUPLICATE_LOGICAL_PORT"
    | "COMPOSE_LOOPBACK_UNSUPPORTED"
    | "EXTERNAL_PREVIEW_UNSUPPORTED";
  capability?: CapabilityRequirement;
  message: string;
  serviceIds?: string[];
};

export type CapabilityReport = {
  compatible: boolean;
  capabilities: RuntimeCapabilities;
  incompatibilities: CapabilityIncompatibility[];
};
