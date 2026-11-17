import type {
  PreviewManifestEnvironment,
  PreviewManifestProduction,
  PreviewManifestService,
} from "./types.js";

// A service's production build, served instead of its development server
// while its story is in review. It is optional: a manifest without it, or a
// service that cannot build, keeps the development server.

type ProductionParsers = {
  environment(
    value: unknown,
    field: string,
  ): PreviewManifestEnvironment | undefined;
  command(command: string, context: string): void;
};

export function parseProduction(
  value: unknown,
  parsers: ProductionParsers,
): PreviewManifestProduction {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("previewManifest service.production must be an object");
  const production = value as Record<string, unknown>;
  const unknown = Object.keys(production).find(
    (key) => !["build", "command", "environment"].includes(key),
  );
  if (unknown)
    throw new Error(
      `previewManifest service.production contains unsupported field ${unknown}`,
    );
  const command = commandValue(production.command, "command", true)!;
  const build = commandValue(production.build, "build", false);
  parsers.command(command, "service.production");
  if (build) parsers.command(build, "service.production.build");
  const environment = parsers.environment(
    production.environment,
    "service.production.environment",
  );
  return {
    ...(build ? { build } : {}),
    command,
    ...(environment ? { environment } : {}),
  };
}

// Only a web service that runs project code can serve a build; terminals,
// app windows and dependencies keep their single command.
export function validateProduction(service: PreviewManifestService) {
  if (!service.production) return;
  if (service.kind === "dependency" || !service.command)
    throw new Error(
      `previewManifest service ${service.id} production needs a project service with a command`,
    );
  if (service.surface && service.surface.type !== "web")
    throw new Error(
      `previewManifest service ${service.id} production is only for web surfaces`,
    );
}

function commandValue(value: unknown, field: string, required: boolean) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim())
    throw new Error(`previewManifest service.production.${field} is required`);
  return value;
}
