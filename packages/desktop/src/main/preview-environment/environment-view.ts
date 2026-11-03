import type {
  PreviewEnvironmentKeyStatus,
  PreviewEnvironmentServiceView,
  PreviewEnvironmentView,
  PreviewVariableView,
  SetPreviewVariableInput,
} from "@blame/agent-runtime";
import { renderCompose } from "@blame/preview-runtime/compose";
import { previewComposeProjectName } from "../preview-readiness.ts";
import { rememberedHostPorts } from "../preview-runtime/local/local-preview-ports.ts";
import { previewOrigin } from "../preview-runtime/local/local-preview-render.ts";
import { readLocalDatabaseMode } from "../preview-runtime/local/local-preview-files.ts";
import {
  currentHostGateway,
  localPreviewContext,
  localPreviewEnvironmentLabels,
} from "../preview-runtime/local/local-preview-runner.ts";
import type { PreviewDatabaseMode } from "./database-environment.ts";
import { maskedEnvValue } from "./dotenv.ts";
import { worktreeRepositoryRoot } from "./env-file-sources.ts";
import type { ResolvedItem } from "./environment-resolver.ts";
import {
  environmentFingerprints,
  renderedBindingValues,
  resolveWorktreeEnvironment,
} from "./worktree-environment.ts";
import { previewVariablesStore } from "./variables-store.ts";

// What the Variables tab shows: the environment the next start gives each
// service, read without writing anything, with secrets masked, and whether
// a running service started with something else.

// A port stands in for one never allocated yet; values show it as <port>.
const unknownPort = 65_535;

export async function describePreviewEnvironment(input: {
  worktree: string;
  databaseMode?: PreviewDatabaseMode | null;
}): Promise<PreviewEnvironmentView> {
  const resolved = await resolveForView(input);
  const labels = await localPreviewEnvironmentLabels(input.worktree).catch(
    () => ({}) as Record<string, string>,
  );
  const fingerprints = environmentFingerprints(resolved.environment.resolved);
  const store = previewVariablesStore();
  const services = resolved.environment.resolved.items
    .sort((left, right) =>
      left.kind === right.kind ? 0 : left.kind === "service" ? -1 : 1,
    )
    .map((item): PreviewEnvironmentServiceView => ({
      id: item.id,
      kind: item.kind,
      directory: item.directory ?? "",
      variables: item.variables.map(variableView),
      changedSinceStart: Boolean(
        labels[item.id] && labels[item.id] !== fingerprints[item.id],
      ),
    }));
  return {
    databaseMode: resolved.environment.databaseMode,
    services,
    warnings: [
      ...resolved.environment.warnings,
      ...missingVariableWarnings(resolved.environment.resolved.items),
    ],
    requests: (await store?.requests(input.worktree)) ?? [],
    encrypted: (await store?.encrypted()) ?? false,
  };
}

async function resolveForView(input: {
  worktree: string;
  databaseMode?: PreviewDatabaseMode | null;
}) {
  const context = await localPreviewContext(input.worktree);
  const remembered = await rememberedHostPorts(input.worktree);
  const hostPorts = Object.fromEntries(
    context.plan.services.flatMap((service) =>
      service.endpoints.map((endpoint) => {
        const key = `${service.id}:${endpoint.id}`;
        return [key, remembered[key] ?? unknownPort];
      }),
    ),
  );
  const draft = renderCompose(context.plan, {
    kind: "local",
    projectName: previewComposeProjectName(input.worktree),
    workspacePath: input.worktree,
    projectUser: "0:0",
    hostPorts,
    dependencyKey: "view",
  });
  const origin = previewOrigin(context.plan, hostPorts, context.selected);
  const environment = await resolveWorktreeEnvironment({
    worktree: input.worktree,
    plan: context.plan,
    bindings: renderedBindingValues(context.plan, draft.yaml),
    previewOrigin: origin?.endsWith(`:${unknownPort}`) ? undefined : origin,
    databaseMode:
      input.databaseMode ?? (await readLocalDatabaseMode(input.worktree)),
    hostGateway: await currentHostGateway(),
  });
  return { context, environment };
}

function variableView(
  variable: ResolvedItem["variables"][number],
): PreviewVariableView {
  const shown = maskedEnvValue(variable.key, variable.value);
  return {
    key: variable.key,
    value: shown.value.replaceAll(`:${unknownPort}`, ":<port>"),
    masked: shown.masked,
    source: variable.source,
    ...(variable.file ? { file: variable.file } : {}),
    ...(variable.note ? { note: variable.note } : {}),
    locked: variable.locked,
    status: variable.status,
    ...(variable.required === undefined ? {} : { required: variable.required }),
  };
}

function missingVariableWarnings(items: ResolvedItem[]) {
  return items.flatMap((item) => {
    const missing = item.variables.filter(
      ({ required, status }) =>
        required && ["missing", "empty", "placeholder"].includes(status),
    );
    return missing.length
      ? [
          `${item.id} needs ${missing.map(({ key }) => key).join(", ")}, which ${missing.length > 1 ? "are" : "is"} not set in this preview.`,
        ]
      : [];
  });
}

/** Key names and statuses only, for the development agent. */
export async function previewEnvironmentKeyStatuses(input: {
  worktree: string;
  databaseMode?: PreviewDatabaseMode | null;
}): Promise<PreviewEnvironmentKeyStatus[]> {
  const { environment } = await resolveForView(input);
  const statuses = new Map<string, PreviewEnvironmentKeyStatus>();
  for (const item of environment.resolved.items) {
    for (const variable of item.variables) {
      const status =
        variable.status === "set"
          ? "set"
          : variable.status === "placeholder"
            ? "placeholder"
            : "missing";
      const current = statuses.get(variable.key);
      statuses.set(variable.key, {
        key: variable.key,
        status: current && current.status !== status ? "missing" : status,
        services: [...(current?.services ?? []), item.id],
        ...(variable.required || current?.required ? { required: true } : {}),
      });
    }
  }
  return [...statuses.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export async function setPreviewVariable(input: SetPreviewVariableInput) {
  const store = previewVariablesStore();
  if (!store) throw new Error("Preview variables are not available yet.");
  const owner =
    input.scope === "project"
      ? await worktreeRepositoryRoot(input.worktree)
      : input.worktree;
  await store.set(input.scope, owner, {
    key: input.key,
    value: input.value,
    serviceId: input.serviceId,
  });
}
