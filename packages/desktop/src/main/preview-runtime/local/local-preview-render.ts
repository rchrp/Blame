import { localPreviewToolsPath } from "./local-preview-tools.ts";
import { stat } from "node:fs/promises";
import type { ProjectRunConfiguration } from "@blame/agent-runtime";
import type { PreviewExecutionPlan } from "@blame/preview-runtime";
import { composeUnescape, renderCompose } from "@blame/preview-runtime/compose";
import { parse as parseYaml } from "yaml";
import { previewComposeProjectName } from "../../preview-readiness.ts";
import {
  envHostFileMounts,
  materializedPreviewEnvHostFileMounts,
} from "../../workspace-env.ts";
import {
  joinWorkspacePath,
  mkdir,
  run,
  runtimeManagedPath,
} from "../../workspace-runtime.ts";
import { dependencyInputs } from "./local-preview-dependency-files.ts";
import { allocatePreviewHostPorts } from "./local-preview-ports.ts";
import {
  previewDatabaseMode,
  type PreviewDatabaseMode,
} from "../../preview-environment/database-environment.ts";
import {
  previewExtraHosts,
  type PreviewHostGateway,
} from "../../preview-environment/host-gateway.ts";
import { worktreeEnvDeclarations } from "../../preview-environment/env-declarations.ts";
import {
  environmentFingerprints,
  environmentLabel,
  planWithResolvedEnvironment,
  renderedBindingValues,
  resolveWorktreeEnvironment,
} from "../../preview-environment/worktree-environment.ts";

// Renders a worktree's plan for the Blame Runtime: the worktree is mounted
// at /workspace, every endpoint gets a port on this computer, worktrees with
// the same dependency manifests share their node_modules volumes, and env
// variables are resolved from their layers (see preview-environment/), and
// env files are materialized for the preview and mounted over the
// originals, with the stronger values written in. Every container reaches
// the developer's computer at the host gateway's alias.

export type LocalRender = Awaited<ReturnType<typeof renderLocalPreview>>;

export async function renderLocalPreview(input: {
  worktree: string;
  plan: PreviewExecutionPlan;
  selected?: ProjectRunConfiguration;
  ownPorts?: ReadonlySet<number>;
  databaseMode?: PreviewDatabaseMode | null;
  hostGateway?: PreviewHostGateway;
  /** Dependencies that get development settings; see the renderer. */
  tunedDependencies?: string[];
}) {
  const { worktree, plan } = input;
  const databaseMode = previewDatabaseMode(plan, input.databaseMode);
  const [projectUser, hostPorts, dependencies, symlinkMounts, declarations] =
    await Promise.all([
      worktreeOwner(worktree),
      allocatePreviewHostPorts(worktree, plan, input.ownPorts),
      dependencyInputs(worktree, plan),
      envHostFileMounts(worktree),
      worktreeEnvDeclarations(worktree),
    ]);
  const dependencyKey = dependencies.key;
  const target = {
    kind: "local" as const,
    projectName: previewComposeProjectName(worktree),
    workspacePath: worktree,
    projectUser: `${projectUser.uid}:${projectUser.gid}`,
    hostPorts,
    dependencyKey,
    toolsPath: localPreviewToolsPath(),
    extraHosts: previewExtraHosts(input.hostGateway),
    tunedDependencies: input.tunedDependencies,
  };
  const draft = renderCompose(plan, target);
  const origin = previewOrigin(plan, hostPorts, input.selected);
  const environment = await resolveWorktreeEnvironment({
    worktree,
    plan,
    bindings: renderedBindingValues(plan, draft.yaml),
    previewOrigin: origin,
    databaseMode,
    hostGateway: input.hostGateway,
    declarations,
    write: true,
  });
  const materialized = await materializedPreviewEnvHostFileMounts(
    worktree,
    origin,
    Object.entries(environment.resolved.fileValues).map(
      ([directory, values]) => ({ directory, values }),
    ),
    { mode: databaseMode, hostAlias: input.hostGateway?.alias },
  );
  const fingerprints = environmentFingerprints(environment.resolved);
  const rendered = renderCompose(
    planWithResolvedEnvironment(plan, environment.resolved),
    {
      ...target,
      fileMounts: [...symlinkMounts, ...materialized].map((mount) => ({
        source: mount.hostPath,
        target: mount.containerPath,
      })),
      serviceLabels: Object.fromEntries(
        Object.entries(fingerprints).map(([id, hash]) => [
          id,
          { [environmentLabel]: hash },
        ]),
      ),
    },
  );
  await createMountTargets(worktree, rendered.yaml);
  return {
    rendered,
    owner: projectUser,
    hostPorts,
    dependencyKey,
    /** What an install reads beyond the key; see local-preview-dependency-files. */
    sharedInstall: dependencies.sharedInstall,
    previewOrigin: origin,
    databaseMode,
    environment,
  };
}

/** The origin of the selected configuration's browser preview. */
export function previewOrigin(
  plan: PreviewExecutionPlan,
  hostPorts: Record<string, number>,
  selected?: ProjectRunConfiguration,
) {
  const endpoint = previewEndpoint(plan, selected);
  if (!endpoint) return undefined;
  const port = hostPorts[`${endpoint.serviceId}:${endpoint.endpoint.id}`];
  if (!port) return undefined;
  const protocol = endpoint.endpoint.protocol === "https" ? "https" : "http";
  return `${protocol}://localhost:${port}`;
}

/**
 * The page a person lands on in the selected configuration's browser
 * preview: the path and query of its own `previewUrl`, else the root. The
 * endpoint's healthcheck path only tells readiness (often a JSON route),
 * so it never decides the landing page.
 */
export function previewLandingUrl(
  plan: PreviewExecutionPlan,
  hostPorts: Record<string, number>,
  selected?: ProjectRunConfiguration,
) {
  const origin = previewOrigin(plan, hostPorts, selected);
  const endpoint = previewEndpoint(plan, selected);
  if (!origin || !endpoint) return undefined;
  return `${origin}${landingPath(selected?.previewUrl, endpoint.endpoint.port)}`;
}

// A configuration's previewUrl names the page for the port it serves on;
// when it names another port it belongs to another endpoint of the service.
function landingPath(previewUrl: string | undefined, endpointPort: number) {
  const value = previewUrl?.trim();
  if (!value) return "/";
  try {
    const url = new URL(
      value.startsWith("/")
        ? `http://localhost${value}`
        : /^[a-z][a-z\d+.-]*:\/\//i.test(value)
          ? value
          : `http://${value}`,
    );
    if (url.protocol !== "http:" && url.protocol !== "https:") return "/";
    if (url.port && Number(url.port) !== endpointPort) return "/";
    return `${url.pathname}${url.search}`;
  } catch {
    return "/";
  }
}

export function previewEndpoint(
  plan: PreviewExecutionPlan,
  selected?: ProjectRunConfiguration,
) {
  const service =
    plan.services.find(({ id }) => id === selected?.previewService) ??
    (selected
      ? undefined
      : plan.services.find(({ kind }) => kind === "preview"));
  const endpoint = service?.endpoints.find(
    ({ protocol }) => protocol !== "tcp",
  );
  return service && endpoint ? { serviceId: service.id, endpoint } : undefined;
}

// Bind targets that do not exist yet would be created by Docker as root
// inside the worktree; create them as the worktree's user first.
async function createMountTargets(worktree: string, yaml: string) {
  const services = (parseYaml(yaml) as ComposeDocument).services ?? {};
  const directories = new Set<string>();
  for (const service of Object.values(services)) {
    for (const volume of service.volumes ?? []) {
      const [source, target] = volume.split(":");
      if (!source || source.startsWith("/") || !target) continue;
      // The file holds the target as Compose reads it: `$` doubled.
      if (target.startsWith("/workspace/"))
        directories.add(composeUnescape(target));
    }
  }
  await Promise.all(
    [...directories].map((target) =>
      mkdir(
        joinWorkspacePath(worktree, target.slice("/workspace/".length)),
      ).catch(() => undefined),
    ),
  );
}

type ComposeDocument = {
  services?: Record<
    string,
    {
      environment?: Record<string, string>;
      volumes?: string[];
      working_dir?: string;
    }
  >;
};

const owners = new Map<string, Promise<{ uid: number; gid: number }>>();

// Project code runs as the user that owns the worktree, so the files it
// writes stay editable by Blame and the agents.
function worktreeOwner(worktree: string) {
  const cached = owners.get(worktree);
  if (cached) return cached;
  const owner = (
    runtimeManagedPath(worktree)
      ? run("stat", ["-c", "%u:%g", worktree]).then(({ stdout }) =>
          stdout.trim().split(":").map(Number),
        )
      : stat(worktree).then(({ uid, gid }) => [uid, gid])
  )
    .then(([uid, gid]) => {
      if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid))
        throw new Error("Unable to read the worktree owner");
      return { uid: uid!, gid: gid! };
    })
    .catch((error) => {
      owners.delete(worktree);
      throw error;
    });
  owners.set(worktree, owner);
  return owner;
}
