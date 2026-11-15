import type { PreviewManifestService } from "@blame/preview-contract";
import type { ServiceLaunchPlan } from "../domain/execution-plan.js";
import {
  launchEnvironment,
  normalizedLaunchCommand,
} from "./command-normalization.js";

// The production variant of a plan serves each service's declared build
// instead of its development server, for stories in review. Only the
// services that declare `production` change: their serve command replaces
// the development command and their environment gains the production
// values. A development NODE_ENV would make the build and server behave as
// in development, so it becomes `production` unless the production
// environment says otherwise. The build command travels with the service;
// the host runs it in the service's container before serving.

export type PreviewServing = "development" | "production";

export function productionService(
  manifest: PreviewManifestService,
  compiled: ServiceLaunchPlan,
): ServiceLaunchPlan {
  const production = manifest.production;
  if (!production) return compiled;
  const environment: Record<string, string> = {
    ...compiled.environment,
    ...("NODE_ENV" in compiled.environment ? { NODE_ENV: "production" } : {}),
    ...(production.environment ?? {}),
  };
  return {
    ...compiled,
    command: normalizedLaunchCommand(production.command),
    environment: launchEnvironment(production.command, environment),
    ...(production.build
      ? { build: { command: normalizedLaunchCommand(production.build) } }
      : {}),
  };
}

/** The services of a plan that serve a production build. */
export function productionServiceIds(manifest: {
  services: PreviewManifestService[];
}) {
  return manifest.services
    .filter(({ production }) => production)
    .map(({ id }) => id);
}
