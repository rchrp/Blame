import { localPreviewToolsPath } from "./local-preview-tools.ts";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { posix, relative, sep } from "node:path";
import type { ProjectRunConfiguration } from "@blame/agent-runtime";
import type { PreviewExecutionPlan } from "@blame/preview-runtime";
import { renderCompose } from "@blame/preview-runtime/compose";
import { parse as parseYaml } from "yaml";
import { previewComposeProjectName } from "../../preview-readiness.ts";
import {
  envHostFileMounts,
  materializedPreviewEnvHostFileMounts,
  type EnvFileOverride,
} from "../../workspace-env.ts";
import {
  findProjectFilesByName,
  joinWorkspacePath,
  mkdir,
  readExistingFiles,
  run,
  runtimeManagedPath,
} from "../../workspace-runtime.ts";
import { allocatePreviewHostPorts } from "./local-preview-ports.ts";

// Renders a worktree's plan for the Blame Runtime: the worktree is mounted
// at /workspace, every endpoint gets a port on this computer, worktrees with
// the same dependency manifests share their node_modules volumes, and env
// files that name the preview origin or a browser binding are materialized
// with the published values and mounted over the originals.

const dependencyManifestFiles = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
];

export type LocalRender = Awaited<ReturnType<typeof renderLocalPreview>>;

export async function renderLocalPreview(input: {
  worktree: string;
  plan: PreviewExecutionPlan;
  selected?: ProjectRunConfiguration;
  ownPorts?: ReadonlySet<number>;
}) {
  const { worktree, plan } = input;
  const [projectUser, hostPorts, dependencyKey, symlinkMounts] =
    await Promise.all([
      worktreeOwner(worktree),
      allocatePreviewHostPorts(worktree, plan, input.ownPorts),
      dependencyHash(worktree, plan),
      envHostFileMounts(worktree),
    ]);
  const target = {
    kind: "local" as const,
    projectName: previewComposeProjectName(worktree),
    workspacePath: worktree,
    projectUser: `${projectUser.uid}:${projectUser.gid}`,
    hostPorts,
    dependencyKey,
    toolsPath: localPreviewToolsPath(),
  };
  const draft = renderCompose(plan, target);
  const origin = previewOrigin(plan, hostPorts, input.selected);
  const overrides = environmentOverrides(plan, draft.yaml);
  const materialized = await materializedPreviewEnvHostFileMounts(
    worktree,
    origin,
    overrides,
  );
  const rendered = renderCompose(plan, {
    ...target,
    fileMounts: [...symlinkMounts, ...materialized].map((mount) => ({
      source: mount.hostPath,
      target: mount.containerPath,
    })),
  });
  await createMountTargets(worktree, rendered.yaml);
  return {
    rendered,
    owner: projectUser,
    hostPorts,
    dependencyKey,
    previewOrigin: origin,
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
      if (target.startsWith("/workspace/")) directories.add(target);
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

// The values bound for each directory, so an env file there names them too.
function environmentOverrides(
  plan: PreviewExecutionPlan,
  yaml: string,
): EnvFileOverride[] {
  const services = (parseYaml(yaml) as ComposeDocument).services ?? {};
  const byDirectory = new Map<string, Record<string, string>>();
  for (const service of plan.services) {
    const directory = workspaceDirectory(service.workingDir);
    if (!directory || !service.bindings.length) continue;
    const environment = services[service.id]?.environment ?? {};
    const values = byDirectory.get(directory) ?? {};
    for (const { targetKey } of service.bindings) {
      const value = environment[targetKey]?.replace(/\$\$/g, "$");
      if (value === undefined) continue;
      // Two services of one directory bound to different values: neither
      // can be written to their shared env file.
      values[targetKey] =
        targetKey in values && values[targetKey] !== value ? "" : value;
    }
    byDirectory.set(directory, values);
  }
  return [...byDirectory].map(([directory, values]) => ({
    directory,
    values: Object.fromEntries(
      Object.entries(values).filter(([, value]) => value),
    ),
  }));
}

function workspaceDirectory(workingDir: string) {
  if (workingDir === "/workspace") return ".";
  if (!workingDir.startsWith("/workspace/")) return undefined;
  return workingDir.slice("/workspace/".length).replace(/\/+$/g, "");
}

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

// Worktrees whose dependency manifests are identical share installs.
async function dependencyHash(worktree: string, plan: PreviewExecutionPlan) {
  const manifests = await findProjectFilesByName(worktree, "package.json", {
    run: (command, args) => run(command, args, { cwd: worktree }),
  });
  const paths = new Map<string, string>();
  for (const file of dependencyManifestFiles)
    paths.set(joinWorkspacePath(worktree, file), file);
  for (const path of manifests) paths.set(path, relativePath(worktree, path));
  const contents = await readExistingFiles([...paths.keys()]);
  const inputs = [...paths]
    .flatMap(([path, file]) =>
      typeof contents[path] === "string"
        ? [{ file, content: contents[path] as string }]
        : [],
    )
    .sort((left, right) => left.file.localeCompare(right.file));
  const hash = createHash("sha256");
  if (!inputs.length) hash.update(JSON.stringify(plan.setup));
  for (const { file, content } of inputs) {
    hash.update(file).update("\0").update(content).update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

function relativePath(root: string, path: string) {
  return root.startsWith("/")
    ? posix.relative(root, path)
    : relative(root, path).split(sep).join("/");
}
