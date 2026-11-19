export type SemanticReferenceRequest = {
  root: string;
  renameTo?: string;
  target: {
    path: string;
    name: string;
    start: number;
    end: number;
    hash: string;
  };
};

export type SemanticReferenceLocation = {
  path: string;
  range: [number, number];
  lines: [number, number];
  snippet: string;
  isWrite: boolean;
  replacement?: string;
};

export type ReferenceFootprint = {
  reads: Array<{ path: string; hash: string }>;
  existence: Array<{ path: string; exists: boolean }>;
  realpaths?: Array<{ path: string; resolved: string }>;
};

export type DependencyDeclarationRequest = {
  root: string;
  declaration: true;
  target: { path: string; name: string; hash: string };
  offset?: number;
};

export type CompilerProject = Extract<SemanticReferenceReply, { status: "ok" }>["project"];

export type DependencyDeclarationReply =
  | { status: "unavailable"; reason: string }
  | {
      status: "ok";
      footprint: ReferenceFootprint;
      project: CompilerProject;
      declaration: {
        readOnly: true;
        content: string;
        offset: number;
        nextOffset?: number;
        totalBytes: number;
        exports?: string[];
        exportsTruncated?: boolean;
        sources: Array<{
          package: string;
          version: string;
          path: string;
          hash: string;
          packageHash: string;
          lines: [number, number];
        }>;
      };
    };

export type SemanticReferenceReply =
  | { status: "unavailable"; reason: string }
  | {
      status: "ok";
      locations: SemanticReferenceLocation[];
      footprint: ReferenceFootprint;
      project: {
        config: string;
        rootFiles: number;
        loadedFiles: number;
        compilerVersion: string;
        scope: "configured_project";
        warnings: string[];
      };
    };

export const semanticReferenceLimits = {
  timeoutMs: 8_000,
  renameTimeoutMs: 12_000,
  workerHeapMb: 512,
  // Of 1,178 gaps between an agent's successive search_code/read_code calls
  // (57 sessions, 2026-11-19), 91% were under 30 s and 94% under 60 s; the
  // longer ones are other work, often checks that need the memory.
  serviceIdleMs: 30_000,
  services: 3,
  rootFiles: 2_000,
  observedFiles: 6_000,
  observedExistence: 30_000,
  observedBytes: 64 * 1024 * 1024,
  locations: 10_000,
} as const;
