import type {
  PreviewManifest,
  ProjectInitializationPreferences,
  ProjectRunConfiguration,
} from "./types.js";
import { previewDevicesSchema } from "./preview-device-schema.js";
import { validateRunConfigurationPreview } from "./project-preview-validation.js";
import {
  isDatabaseEnvironmentKey,
  normalizeLocalPreviewDatabaseEnvironmentValue,
} from "@blame/preview-contract";
import {
  parsePreviewManifest,
  normalizePreviewManifestWithPreferences,
  validatePreviewManifest,
} from "./preview-manifest.js";
import { jsonPayload } from "./json-payload.js";
import {
  manifestWithProjectPackageManager,
  projectPackageManager,
} from "./preview-package-manager.js";
import type { ProjectInitializationScan } from "./project-initialization-scan.js";
import {
  validatePreviewSetup,
  type PreviewSetupIssue,
} from "./project-preview-validation.js";

export {
  scanProjectForInitialization,
  scanProjectWorkspace,
  type ProjectInitializationScan,
  type ProjectScanRootProvider,
} from "./project-initialization-scan.js";

const maxCorrectionPayloadLength = 24_000;

type ParsedProjectInitialization = {
  previewManifest: PreviewManifest;
  runConfigurations: ProjectRunConfiguration[];
};

type ProjectInitializationCorrection = {
  validationError: string;
  previousResult: string;
};

const previewManifestContainerSchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  maxProperties: 1,
  properties: {
    image: { type: "string" },
    build: {
      type: "object",
      additionalProperties: false,
      required: ["context", "dockerfile"],
      properties: {
        context: { type: "string" },
        dockerfile: { type: "string" },
        target: { type: "string" },
      },
    },
  },
} as const;

export const projectInitializationResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["previewManifest", "runConfigurations"],
  properties: {
    previewManifest: {
      type: "object",
      additionalProperties: false,
      required: [
        "confidence",
        "project",
        "setup",
        "services",
        "caches",
        "risks",
        "probes",
      ],
      properties: {
        confidence: { enum: ["low", "medium", "high"] },
        project: {
          type: "object",
          additionalProperties: false,
          properties: {
            root: { type: "string" },
            detectedStack: { type: "array", items: { type: "string" } },
            confidence: { enum: ["low", "medium", "high"] },
          },
        },
        setup: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "container", "workingDir", "command"],
            properties: {
              id: { type: "string" },
              container: previewManifestContainerSchema,
              workingDir: { type: "string" },
              command: { type: "string" },
              entrypoint: { type: "array", items: { type: "string" } },
              runAs: { enum: ["host", "root"] },
              environment: {
                type: "object",
                additionalProperties: { type: "string" },
              },
              dependsOn: { type: "array", items: { type: "string" } },
            },
          },
        },
        services: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "kind", "container", "endpoints"],
            properties: {
              id: { type: "string" },
              kind: { enum: ["preview", "dependency", "worker"] },
              container: previewManifestContainerSchema,
              workingDir: { type: "string" },
              command: { type: "string" },
              entrypoint: { type: "array", items: { type: "string" } },
              user: { type: "string" },
              environment: {
                type: "object",
                additionalProperties: { type: "string" },
              },
              dependsOn: { type: "array", items: { type: "string" } },
              surface: {
                type: "object",
                additionalProperties: false,
                required: ["type"],
                properties: {
                  type: { enum: ["web", "terminal", "display"] },
                  device: { enum: ["phone", "tablet"] },
                  columns: { type: "integer", minimum: 40, maximum: 300 },
                  rows: { type: "integer", minimum: 10, maximum: 100 },
                  width: { type: "integer", minimum: 640, maximum: 3840 },
                  height: { type: "integer", minimum: 480, maximum: 2160 },
                },
              },
              endpoints: {
                type: "array",
                minItems: 0,
                maxItems: 20,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id", "protocol", "port"],
                  properties: {
                    id: { type: "string" },
                    protocol: { enum: ["http", "https", "tcp"] },
                    port: { type: "integer", minimum: 1, maximum: 65535 },
                    healthcheck: {
                      type: "object",
                      additionalProperties: false,
                      required: ["type", "timeoutMs"],
                      properties: {
                        type: { enum: ["http", "tcp"] },
                        path: { type: "string" },
                        timeoutMs: {
                          type: "integer",
                          minimum: 1000,
                          maximum: 300000,
                        },
                      },
                    },
                  },
                },
              },
              bindings: {
                type: "array",
                description:
                  "Bindings belong inside their consuming service, never at the previewManifest root.",
                maxItems: 50,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["target", "source", "exposure"],
                  properties: {
                    target: {
                      type: "object",
                      additionalProperties: false,
                      required: ["type", "key"],
                      properties: {
                        type: { const: "environment" },
                        key: { type: "string" },
                      },
                    },
                    source: {
                      type: "object",
                      additionalProperties: false,
                      required: ["service", "endpoint"],
                      properties: {
                        service: { type: "string" },
                        endpoint: { type: "string" },
                      },
                    },
                    exposure: { enum: ["server", "browser"] },
                    format: {
                      enum: ["url", "host", "port", "host-port"],
                      description:
                        "url (the default) is only for HTTP/HTTPS endpoints. TCP endpoints require host, port or host-port. Complete database URIs belong in environment with dependsOn, not in bindings.",
                    },
                    path: { type: "string" },
                  },
                },
              },
            },
          },
        },
        devices: previewDevicesSchema,
        caches: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name", "target"],
            properties: {
              name: { type: "string" },
              target: { type: "string" },
            },
          },
        },
        risks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["level", "message"],
            properties: {
              level: { enum: ["low", "medium", "high"] },
              message: { type: "string" },
            },
          },
        },
        probes: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "from", "target", "type"],
            properties: {
              id: { type: "string" },
              from: {
                type: "string",
                description:
                  'Use "host" or an exact service id from previewManifest.services.',
              },
              target: {
                type: "object",
                additionalProperties: false,
                required: ["service", "endpoint"],
                properties: {
                  service: { type: "string" },
                  endpoint: { type: "string" },
                  path: { type: "string" },
                },
              },
              type: { enum: ["http", "tcp"] },
              acceptedStatuses: {
                type: "array",
                maxItems: 20,
                items: { type: "integer", minimum: 100, maximum: 499 },
              },
              timeoutMs: { type: "integer", minimum: 1000, maximum: 300000 },
              required: { type: "boolean" },
            },
          },
        },
      },
    },
    runConfigurations: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "name",
          "command",
          "cwd",
          "default",
          "category",
          "services",
          "scopes",
        ],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          command: { type: "string" },
          cwd: { type: "string" },
          default: { type: "boolean" },
          category: {
            enum: ["web", "mobile", "desktop", "terminal", "service", "other"],
          },
          services: {
            type: "array",
            items: { type: "string" },
            minItems: 0,
            maxItems: 20,
          },
          previewService: { type: "string" },
          previewTarget: { type: "string" },
          scopes: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 50,
          },
          previewUrl: { type: "string" },
        },
      },
    },
  },
} as const;

export function projectInitializationPrompt(
  scan: ProjectInitializationScan,
  preferences?: ProjectInitializationPreferences,
) {
  return [
    "Analyze this project scan according to your system instructions.",
    "Call submit_project_initialization with the complete result. Blame checks it immediately; fix any rejected problems and submit again.",
    "Do not answer with JSON text.",
    "Use read_files or search_codebase only when a required runtime fact is absent from this evidence.",
    ...databasePreferencePrompt(preferences),
    `Project evidence: ${JSON.stringify(scan)}`,
  ].join("\n");
}

export function projectInitializationCorrectionPrompt(
  scan: ProjectInitializationScan,
  correction: ProjectInitializationCorrection,
  preferences?: ProjectInitializationPreferences,
) {
  return [
    projectInitializationPrompt(scan, preferences),
    "A previous result for this project was not accepted.",
    "Call submit_project_initialization with a complete corrected input.",
    "Read more files only when the problem below needs a fact you do not have.",
    `Last problem: ${correction.validationError}`,
    `Previous rejected input: ${truncateCorrectionPayload(correction.previousResult)}`,
  ].join("\n");
}

export type ProjectInitializationParseOptions = {
  /** Save a setup that keeps heuristic warnings, listing them as risks. */
  acceptWarnings?: boolean;
};

export function parseProjectInitializationResult(
  text: string,
  scan?: ProjectInitializationScan,
  preferences?: ProjectInitializationPreferences,
  options: ProjectInitializationParseOptions = {},
): ParsedProjectInitialization {
  const parsed = JSON.parse(jsonPayload(text)) as unknown;
  return parseProjectInitializationPayload(parsed, scan, preferences, options);
}

export function parseProjectInitializationPayload(
  parsed: unknown,
  scan?: ProjectInitializationScan,
  preferences?: ProjectInitializationPreferences,
  options: ProjectInitializationParseOptions = {},
): ParsedProjectInitialization {
  if (!isRecord(parsed))
    throw new Error("Initialization result must be an object");
  assertOnlyKeys(parsed, ["previewManifest", "runConfigurations"], "result");
  if (!parsed.previewManifest) {
    throw new Error("Initialization result is missing previewManifest");
  }
  const parsedManifest = parsePreviewManifest(
    previewManifestWithDatabasePreference(parsed.previewManifest, preferences),
  );
  const manifest = manifestWithProjectPackageManager(
    normalizePreviewManifestWithPreferences(parsedManifest, preferences),
    projectPackageManager(projectRootPackageJson(scan, parsedManifest)),
  );
  validatePreviewManifest(manifest);
  const runConfigurations = parseRunConfigurations(parsed.runConfigurations);
  const warnings = validateProjectInitializationOutput(
    runConfigurations,
    scan,
    manifest,
    options,
  );
  return {
    previewManifest: manifestWithWarnings(manifest, warnings),
    runConfigurations,
  };
}

function manifestWithWarnings(
  manifest: PreviewManifest,
  warnings: PreviewSetupIssue[],
): PreviewManifest {
  const known = new Set(manifest.risks.map(({ message }) => message));
  const risks = warnings
    .filter(({ warning }) => !known.has(warning))
    .map(({ warning }) => ({ level: "medium" as const, message: warning }));
  return risks.length
    ? { ...manifest, risks: [...manifest.risks, ...risks] }
    : manifest;
}

function validateRunConfigurationTopology(
  configurations: ProjectRunConfiguration[],
  manifest: PreviewManifest,
) {
  const services = new Set(manifest.services.map(({ id }) => id));
  for (const configuration of configurations) {
    validateRunConfigurationPreview(configuration, manifest);
    validateRunConfigurationServices(configuration, manifest, services);
  }
}

function validateRunConfigurationServices(
  configuration: ProjectRunConfiguration,
  manifest: PreviewManifest,
  services: Set<string>,
) {
  if (
    configuration.category !== "web" &&
    configuration.category !== "mobile" &&
    configuration.category !== "terminal" &&
    configuration.category !== "desktop" &&
    configuration.previewService
  ) {
    throw new Error(
      `Initialization run configuration ${configuration.id} exposes a browser preview outside the web category`,
    );
  }
  for (const service of configuration.services) {
    if (!services.has(service)) {
      throw new Error(
        `Initialization run configuration ${configuration.id} references unknown service ${service}`,
      );
    }
    const manifestService = manifest.services.find(({ id }) => id === service);
    if (
      configuration.category !== "web" &&
      !configuration.previewService &&
      manifestService?.kind === "preview"
    ) {
      throw new Error(
        `Initialization run configuration ${configuration.id} directly starts a browser preview outside the web category`,
      );
    }
  }
  if (!configuration.previewService) return;
  if (!services.has(configuration.previewService)) {
    throw new Error(
      `Initialization run configuration ${configuration.id} previewService is unknown`,
    );
  }
  const preview = manifest.services.find(
    ({ id }) => id === configuration.previewService,
  );
  if (
    configuration.previewUrl &&
    preview?.surface &&
    preview.surface.type !== "web"
  ) {
    throw new Error(
      "Initialization run configuration previewUrl is only available for web surfaces",
    );
  }
  if (preview?.kind !== "preview") {
    throw new Error(
      `Initialization run configuration ${configuration.id} previewService is not browser-facing`,
    );
  }
}

export function parseRunConfigurations(value: unknown) {
  if (!Array.isArray(value))
    throw new Error("Initialization result is missing runConfigurations");
  if (value.length > 20)
    throw new Error("Initialization result has too many runConfigurations");
  const configurations = value.map(parseRunConfiguration);
  const ids = new Set(configurations.map((configuration) => configuration.id));
  if (ids.size !== configurations.length)
    throw new Error(
      "Initialization result run configuration ids must be unique",
    );
  if (
    configurations.filter((configuration) => configuration.default).length > 1
  )
    throw new Error(
      "Initialization result must have at most one default run configuration",
    );
  return configurations;
}

function parseRunConfiguration(value: unknown): ProjectRunConfiguration {
  if (!isRecord(value))
    throw new Error("Initialization run configuration must be an object");
  assertOnlyKeys(
    value,
    [
      "id",
      "name",
      "command",
      "cwd",
      "default",
      "category",
      "services",
      "previewService",
      "previewTarget",
      "scopes",
      "previewUrl",
    ],
    "run configuration",
  );
  return {
    ...parseRunConfigurationBase(value),
    ...parseRunConfigurationTopology(value),
  };
}

function parseRunConfigurationBase(value: Record<string, unknown>) {
  const id = stringValue(value.id);
  const name = stringValue(value.name);
  const command = stringValue(value.command);
  const cwd = stringValue(value.cwd);
  const previewUrl = stringValue(value.previewUrl);
  if (!id || !/^[a-zA-Z0-9_-]{1,80}$/.test(id))
    throw new Error("Initialization run configuration id is invalid");
  if (!name || name.length > 120)
    throw new Error("Initialization run configuration name is invalid");
  if (!command || command.length > 2_000 || /[\r\n]/.test(command))
    throw new Error("Initialization run configuration command is invalid");
  if (!cwd || cwd.length > 500 || unsafeRunConfigurationCwd(cwd))
    throw new Error(
      "Initialization run configuration cwd must stay inside the project",
    );
  if (typeof value.default !== "boolean")
    throw new Error("Initialization run configuration default must be boolean");
  if (previewUrl && invalidRunConfigurationPreviewUrl(previewUrl))
    throw new Error("Initialization run configuration previewUrl is invalid");
  return {
    id,
    name,
    command,
    cwd,
    default: value.default,
    ...(previewUrl ? { previewUrl } : {}),
  };
}

function parseRunConfigurationTopology(value: Record<string, unknown>) {
  const category = parseRunConfigurationCategory(value.category);
  const services = parseRunConfigurationStrings(value.services, "services", 20);
  const scopes = parseRunConfigurationStrings(value.scopes, "scopes", 50);
  const previewService = stringValue(value.previewService);
  const previewTarget = stringValue(value.previewTarget);
  if (previewTarget && (category !== "mobile" || previewService)) throw new Error("A device preview needs category mobile and cannot select a previewService");
  if (requiresContainerServices(category) && !services.length) {
    throw new Error(
      "Initialization run configuration services must not be empty",
    );
  }
  if (!scopes.length) {
    throw new Error(
      "Initialization run configuration scopes must not be empty",
    );
  }
  if (category === "web" && !previewService) {
    throw new Error(
      "Initialization web run configuration requires previewService",
    );
  }
  if (previewService && !services.includes(previewService)) {
    throw new Error(
      "Initialization run configuration previewService must be a configured service",
    );
  }
  return {
    category,
    services,
    ...(previewService ? { previewService } : {}),
    ...(previewTarget ? { previewTarget } : {}),
    scopes,
  };
}

function requiresContainerServices(
  category: ProjectRunConfiguration["category"],
) {
  return category === "web" || category === "service";
}

function parseRunConfigurationCategory(
  value: unknown,
): ProjectRunConfiguration["category"] {
  if (
    value !== "web" &&
    value !== "mobile" &&
    value !== "desktop" &&
    value !== "terminal" &&
    value !== "service" &&
    value !== "other"
  ) {
    throw new Error("Initialization run configuration category is required");
  }
  return value;
}

function parseRunConfigurationStrings(
  value: unknown,
  field: string,
  maximum: number,
) {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    value.some(
      (entry) =>
        typeof entry !== "string" || !entry.trim() || entry.length > 500,
    )
  ) {
    throw new Error(`Initialization run configuration ${field} is invalid`);
  }
  return Array.from(new Set((value as string[]).map((entry) => entry.trim())));
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: string[],
  context: string,
) {
  const keys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) {
    throw new Error(
      `Initialization ${context} contains unsupported field ${unknown}`,
    );
  }
}

function unsafeRunConfigurationCwd(cwd: string) {
  return (
    cwd.startsWith("/") ||
    cwd.startsWith("\\") ||
    /^[a-zA-Z]:/.test(cwd) ||
    cwd.split(/[\\/]/).includes("..")
  );
}

function invalidRunConfigurationPreviewUrl(previewUrl: string) {
  return previewUrl.length > 2_048 || /[\r\n]/.test(previewUrl);
}

export function validateProjectInitializationOutput(
  configurations: ProjectRunConfiguration[],
  scan: ProjectInitializationScan | undefined,
  manifest: PreviewManifest,
  options: ProjectInitializationParseOptions = {},
) {
  validateRunConfigurationTopology(configurations, manifest);
  return validatePreviewSetup(manifest, scan, options);
}

function truncateCorrectionPayload(value: string) {
  if (value.length <= maxCorrectionPayloadLength) return value;
  return value.slice(0, maxCorrectionPayloadLength);
}

function databasePreferencePrompt(
  preferences: ProjectInitializationPreferences | undefined,
) {
  if (preferences?.database?.mode === "compose") {
    return [
      "Database preference: create an isolated Compose database compatible with the detected project.",
      'Use the fixed public throwaway value "blame" for every database password variable and embedded database URL password. Never copy credentials from project environment files.',
    ];
  }
  if (preferences?.database?.mode === "existing") {
    return [
      "Database preference: use the project's configured database. Do not declare a database dependency service or copy database credentials into the manifest.",
    ];
  }
  return [];
}

function previewManifestWithDatabasePreference(
  value: unknown,
  preferences: ProjectInitializationPreferences | undefined,
) {
  const mode = preferences?.database?.mode;
  if (!mode || !isRecord(value)) return value;
  return {
    ...value,
    setup: adjustedManifestItems(value.setup, mode),
    services: adjustedManifestItems(value.services, mode),
  };
}

function adjustedManifestItems(
  value: unknown,
  mode: NonNullable<ProjectInitializationPreferences["database"]>["mode"],
) {
  if (!Array.isArray(value)) return value;
  return value.map((item) => {
    if (!isRecord(item)) return item;
    return {
      ...item,
      environment: adjustedDatabaseEnvironment(item.environment, mode),
    };
  });
}

function adjustedDatabaseEnvironment(
  value: unknown,
  mode: NonNullable<ProjectInitializationPreferences["database"]>["mode"],
) {
  if (!isRecord(value) || Array.isArray(value)) return value;
  const environment: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (mode === "existing" && isDatabaseEnvironmentKey(key)) continue;
    environment[key] =
      mode === "compose" && typeof entry === "string"
        ? normalizeLocalPreviewDatabaseEnvironmentValue(key, entry)
        : entry;
  }
  return environment;
}

function projectRootPackageJson(
  scan: ProjectInitializationScan | undefined,
  manifest: PreviewManifest,
) {
  const declared = (manifest.project.root || ".")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "");
  const root = declared === "." ? "" : declared;
  return scan?.files[root ? `${root}/package.json` : "package.json"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}
