import { createHash } from "node:crypto";
import type { PreviewExecutionPlan } from "@blame/preview-runtime";
import { parse as parseYaml } from "yaml";
import {
  previewDatabaseMode,
  type PreviewDatabaseMode,
} from "./database-environment.ts";
import { liveStoryEnvFiles } from "./env-file-sources.ts";
import {
  resolvePreviewEnvironment,
  type EnvDeclaration,
  type ResolvedEnvironment,
} from "./environment-resolver.ts";
import { hostGatewayNote, type PreviewHostGateway } from "./host-gateway.ts";
import { previewVariablesStore } from "./variables-store.ts";

// The environment of a story's preview, gathered from its sources: the
// setup, Blame's bindings, the env files read live, and the variables people
// set for the project or the story.

export type WorktreeEnvironment = {
  resolved: ResolvedEnvironment;
  databaseMode: PreviewDatabaseMode;
  repositoryRoot: string;
  /** Env files whose content came fresh from the project. */
  fromProject: string[];
  warnings: string[];
};

export async function resolveWorktreeEnvironment(input: {
  worktree: string;
  plan: Pick<PreviewExecutionPlan, "services" | "setup">;
  bindings: Record<string, Record<string, string>>;
  previewOrigin?: string;
  databaseMode?: PreviewDatabaseMode | null;
  hostGateway?: PreviewHostGateway;
  declarations?: Record<string, EnvDeclaration[]>;
  /** Copy the project's changed env files into the story, as a start does. */
  write?: boolean;
}): Promise<WorktreeEnvironment> {
  const sources = await liveStoryEnvFiles(input.worktree, {
    write: input.write,
  });
  const warnings: string[] = [];
  const store = previewVariablesStore();
  const stored = async (scope: "project" | "story", owner: string) => {
    try {
      return (await store?.variables(scope, owner)) ?? [];
    } catch {
      warnings.push(
        `Blame could not read the ${scope} variables from the system keychain; the preview starts without them.`,
      );
      return [];
    }
  };
  const databaseMode = previewDatabaseMode(input.plan, input.databaseMode);
  const resolved = resolvePreviewEnvironment({
    plan: input.plan,
    bindings: input.bindings,
    previewOrigin: input.previewOrigin,
    databaseMode,
    hostAlias: input.hostGateway?.alias,
    envFiles: sources.files,
    project: await stored("project", sources.repositoryRoot),
    story: await stored("story", input.worktree),
    declarations: input.declarations,
  });
  const pointsAtComputer = resolved.items.some((item) =>
    item.variables.some(({ note }) =>
      note?.startsWith("Points at your computer"),
    ),
  );
  if (
    pointsAtComputer &&
    input.hostGateway &&
    !input.hostGateway.reachesLoopback
  )
    warnings.push(
      `Your database settings name your computer: ${hostGatewayNote(input.hostGateway)}.`,
    );
  return {
    resolved,
    databaseMode,
    repositoryRoot: sources.repositoryRoot,
    fromProject: sources.fromProject,
    warnings,
  };
}

/** The plan with each task's environment replaced by its resolved one. */
export function planWithResolvedEnvironment<
  Plan extends Pick<PreviewExecutionPlan, "services" | "setup">,
>(plan: Plan, resolved: ResolvedEnvironment): Plan {
  const environments = new Map(
    resolved.items.map((item) => [`${item.kind}:${item.id}`, item.environment]),
  );
  return {
    ...plan,
    setup: plan.setup.map((task) => ({
      ...task,
      environment: environments.get(`setup:${task.id}`) ?? task.environment,
    })),
    services: plan.services.map((service) => ({
      ...service,
      environment:
        environments.get(`service:${service.id}`) ?? service.environment,
    })),
  };
}

export const environmentLabel = "blame.environment";

/** A hash of what each service reads, files included, to label it with. */
export function environmentFingerprints(resolved: ResolvedEnvironment) {
  return Object.fromEntries(
    resolved.items
      .filter((item) => item.kind === "service")
      .map((item) => [
        item.id,
        createHash("sha256")
          .update(
            JSON.stringify(
              item.variables.map(({ key, value, status }) => [
                key,
                value,
                status,
              ]),
            ),
          )
          .digest("hex")
          .slice(0, 16),
      ]),
  );
}

type ComposeDocument = {
  services?: Record<string, { environment?: Record<string, string> }>;
};

/** The value Compose gives each binding, read from a rendered file. */
export function renderedBindingValues(
  plan: Pick<PreviewExecutionPlan, "services">,
  yaml: string,
) {
  const services = (parseYaml(yaml) as ComposeDocument).services ?? {};
  return Object.fromEntries(
    plan.services.map((service) => {
      const environment = services[service.id]?.environment ?? {};
      return [
        service.id,
        Object.fromEntries(
          service.bindings.flatMap(({ targetKey }) => {
            const value = environment[targetKey];
            return value === undefined
              ? []
              : [[targetKey, value.replace(/\$\$/g, "$")]];
          }),
        ),
      ];
    }),
  );
}
