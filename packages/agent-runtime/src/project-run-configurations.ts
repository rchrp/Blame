import type { ProjectRunConfiguration } from "./types.js";

// Run configurations as an initialization declares them. The desktop reads them
// back from the project files without the rest of the initialization.

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
  if (previewTarget && (category !== "mobile" || previewService))
    throw new Error(
      "A device preview needs category mobile and cannot select a previewService",
    );
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

export function assertOnlyKeys(
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}
