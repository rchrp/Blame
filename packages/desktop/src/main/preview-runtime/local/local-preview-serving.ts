import { createHash } from "node:crypto";
import { normalize, resolve } from "node:path";
import {
  productionServiceIds,
  type PreviewServing,
} from "@blame/preview-runtime";
import { ComposeEngine } from "@blame/preview-runtime/compose";
import { parse as parseYaml } from "yaml";
import { runtimeBackground } from "../../runtime-power.ts";
import {
  joinWorkspacePath,
  pathExists,
  readFile,
  run,
  writeFileAtomic,
} from "../../workspace-runtime.ts";
import { runtimeHeavyWork } from "../../runtime-heavy-work.ts";
import { errorText, localPreviewPaths } from "./local-preview-files.ts";
import {
  localPreviewContext,
  localDockerHost,
  localPreviewEngine,
  renderLocalPreviewForStart,
  selectedServiceIds,
  startLocalPreview,
  type LocalPreviewContext,
  type LocalPreviewRunOptions,
} from "./local-preview-runner.ts";

// Review builds. A development server keeps a compiler, its caches and file
// watchers in memory (Next.js: ~600-800 MiB against ~180 MiB for `next
// start`). Once no agent works on a story, a service that declares
// `production` commands is built in the background, in a one-off container
// next to the running development server, and the preview then serves the
// build: Compose recreates only that service, on the same port. A build is
// done once per source revision and environment. The preview goes back to
// the development server as soon as an agent works on the story or a
// message is sent to it, falls back to it when a build or the production
// start fails, and a failed build is not retried for the same revision.

const reviewGraceMs = 3 * 60_000;
const sweepIntervalMs = 60_000;
const buildTimeoutMs = 15 * 60_000;

type ServingState = {
  mode: PreviewServing;
  /** Build key of each built service; see buildKeys. */
  builds: Record<string, string>;
  /** Source revision whose build failed. */
  failed?: string;
  /** Source revision of the builds being served. */
  revision?: string;
};

type ServingDependencies = {
  /** Worktrees whose local preview runs. */
  runningWorktrees(): Promise<string[]>;
  /** Starts the selected configuration again, as the app would. */
  restart(worktree: string): Promise<unknown>;
  log(worktree: string, chunk: string): void;
};

let agentWorksIn: (worktree: string) => boolean = () => false;
let reviewBuildsEnabled: (worktree: string) => Promise<boolean> = async () =>
  true;
let dependencies: ServingDependencies | undefined;
const lastAgentWork = new Map<string, number>();
let sweeper: NodeJS.Timeout | undefined;
let sweeping = false;

/** Tells whether an agent session currently runs in a worktree. */
export function useServingAgentCheck(check: (worktree: string) => boolean) {
  agentWorksIn = check;
}

/** Whether the project of a worktree serves review builds. */
export function useReviewBuildSetting(
  enabled: (worktree: string) => Promise<boolean>,
) {
  reviewBuildsEnabled = enabled;
}

/**
 * The story is being changed again: the next start serves the development
 * server, and a preview serving a build goes back to it now.
 */
export async function requestDevelopmentServing(worktree: string) {
  lastAgentWork.set(key(worktree), Date.now());
  const state = await readServingState(worktree);
  if (state.mode !== "production" || !dependencies) return;
  await dependencies.restart(worktree);
}

/** Starts a local preview in the mode its story calls for. */
export async function startLocalPreviewServing(
  worktree: string,
  options: LocalPreviewRunOptions = {},
) {
  const state = await readServingState(worktree);
  if (await servesBuild(worktree, state)) {
    try {
      const url = await startLocalPreview(worktree, {
        ...options,
        serving: "production",
      });
      await writeServingState(worktree, { ...state, mode: "production" });
      return url;
    } catch (error) {
      if (options.wanted && !(await options.wanted())) throw error;
      options.log?.(
        `Serving the review build failed (${errorText(error)}). Starting the development server instead.\n`,
      );
      await writeServingState(worktree, {
        ...state,
        mode: "development",
        builds: {},
        failed: state.revision,
        revision: undefined,
      });
    }
  }
  const url = await startLocalPreview(worktree, {
    ...options,
    serving: "development",
  });
  const current = await readServingState(worktree);
  if (current.mode !== "development")
    await writeServingState(worktree, {
      ...current,
      mode: "development",
      revision: undefined,
    });
  return url;
}

/** Checks the running previews every minute for review builds to make. */
export function startReviewBuildSweeper(input: ServingDependencies) {
  dependencies = input;
  if (sweeper) return;
  // Not a use of the Blame Runtime: an awake preview keeps it running.
  sweeper = setInterval(() => void runtimeBackground(sweep), sweepIntervalMs);
  sweeper.unref?.();
}

async function sweep() {
  if (sweeping || !dependencies) return;
  sweeping = true;
  try {
    const running = await dependencies.runningWorktrees().catch(() => []);
    for (const worktree of running) {
      if (agentWorksIn(worktree)) {
        lastAgentWork.set(key(worktree), Date.now());
        continue;
      }
      // One build at a time: builds are the CPU peaks this avoids stacking.
      await reviewBuild(worktree, dependencies).catch((error) =>
        dependencies?.log(
          worktree,
          `Preparing the review build failed: ${errorText(error)}\n`,
        ),
      );
    }
  } finally {
    sweeping = false;
  }
}

/** Builds a running development preview for review, then serves the build. */
export async function reviewBuild(
  worktree: string,
  deps: ServingDependencies,
  now = Date.now(),
) {
  if (!inReview(worktree, now) || !(await reviewBuildsEnabled(worktree)))
    return "development";
  const state = await readServingState(worktree);
  if (state.mode === "production") {
    // The source changed under the build: serve it in development again,
    // and build that revision on a later pass.
    if (state.revision === (await sourceRevision(worktree)))
      return "production";
    await deps.restart(worktree);
    return "development";
  }
  const context = await localPreviewContext(worktree, "production");
  const services = productionServices(context);
  if (!services.length) return "development";
  const revision = await sourceRevision(worktree);
  if (state.failed === revision) return "development";
  if (!(await allRunning(worktree, context, services))) return "development";
  const render = await renderLocalPreviewForStart(worktree, context);
  const target = {
    context,
    services,
    revision,
    render,
    keys: buildKeys(context, render.rendered.yaml, services, revision),
  };
  const fresh = services.every((id) => state.builds[id] === target.keys[id]);
  if (!fresh && !(await buildServices(worktree, target, state, deps)))
    return "development";
  if (!inReview(worktree, Date.now())) return "development";
  await deps.restart(worktree);
  return "production";
}

// A paused (hibernated) or stopped preview is not built: its dependencies
// would not answer the build.
async function allRunning(
  worktree: string,
  context: LocalPreviewContext,
  services: string[],
) {
  const states = await localPreviewEngine(worktree)
    .inspect(context.plan)
    .catch(() => []);
  return services.every((id) =>
    states.some(
      (state) => state.id === id && state.running && state.state !== "paused",
    ),
  );
}

function productionServices(context: LocalPreviewContext) {
  const declared = new Set(productionServiceIds(context.manifest));
  return selectedServiceIds(context).filter((id) => declared.has(id));
}

async function buildServices(
  worktree: string,
  target: {
    context: LocalPreviewContext;
    services: string[];
    revision: string;
    render: Awaited<ReturnType<typeof renderLocalPreviewForStart>>;
    keys: Record<string, string>;
  },
  state: ServingState,
  deps: ServingDependencies,
) {
  const engine = new ComposeEngine({
    host: localDockerHost(),
    stateDirectory: joinWorkspacePath(
      localPreviewPaths(worktree).engineState,
      "review-build",
    ),
    log: (chunk) => deps.log(worktree, chunk),
  });
  await engine.prepare(target.render.rendered, target.render.owner);
  const builds = { ...state.builds };
  for (const id of target.services) {
    if (builds[id] === target.keys[id]) continue;
    const command = target.context.plan.services.find(
      (service) => service.id === id,
    )?.build?.command;
    if (command) {
      // A build takes its turn of the Runtime's heavy work.
      const leave = await runtimeHeavyWork.enter("build", {
        owner: worktree,
        onWait: (reason) =>
          deps.log(
            worktree,
            `Waiting for ${reason} before building ${id} for review.\n`,
          ),
      });
      // An agent may have taken the story back meanwhile.
      if (!inReview(worktree, Date.now())) {
        leave();
        return false;
      }
      deps.log(worktree, `Building ${id} for review.\n`);
      const startedAt = Date.now();
      // The development server keeps serving meanwhile, and its
      // dependencies are already running.
      const result = await engine
        .compose(
          ["run", "--rm", "--no-deps", "-T", id, "/bin/sh", "-lc", command],
          {
            timeoutMs: buildTimeoutMs,
            onOutput: (chunk) => deps.log(worktree, chunk),
          },
          true,
        )
        .finally(leave);
      if (result.exitCode !== 0) {
        deps.log(
          worktree,
          `The review build of ${id} failed (exit code ${result.exitCode}); the development server stays.\n`,
        );
        await writeServingState(worktree, {
          ...state,
          builds,
          failed: target.revision,
        });
        // A build may rewrite files the development server reads, such as
        // Nuxt's .nuxt folder.
        await localPreviewEngine(worktree)
          .compose(["restart", id], { timeoutMs: 120_000 }, true)
          .catch(() => undefined);
        return false;
      }
      deps.log(
        worktree,
        `Built ${id} for review in ${Math.round((Date.now() - startedAt) / 1_000)} s.\n`,
      );
    }
    builds[id] = target.keys[id]!;
  }
  // An edit during the build makes it stale; the next pass builds again.
  if ((await sourceRevision(worktree)) !== target.revision) return false;
  await writeServingState(worktree, { ...state, builds, failed: undefined });
  return true;
}

async function servesBuild(worktree: string, state: ServingState) {
  if (!inReview(worktree, Date.now())) return false;
  if (!(await reviewBuildsEnabled(worktree))) return false;
  try {
    const revision = await sourceRevision(worktree);
    const context = await localPreviewContext(worktree, "production");
    const services = productionServices(context);
    if (!services.length || revision === state.failed) return false;
    const render = await renderLocalPreviewForStart(worktree, context);
    const keys = buildKeys(context, render.rendered.yaml, services, revision);
    if (!services.every((id) => state.builds[id] === keys[id])) return false;
    state.revision = revision;
    return true;
  } catch {
    return false;
  }
}

// What a build must match to be served: the source revision and what the
// build reads from its container, browser bindings included.
export function buildKeys(
  context: Pick<LocalPreviewContext, "plan">,
  yaml: string,
  services: string[],
  revision: string,
) {
  const compose = parseYaml(yaml) as {
    services?: Record<string, Record<string, unknown>>;
  };
  return Object.fromEntries(
    services.map((id) => {
      const service = context.plan.services.find((item) => item.id === id);
      const rendered = compose.services?.[id] ?? {};
      return [
        id,
        createHash("sha256")
          .update(revision)
          .update("\0")
          .update(
            JSON.stringify([
              service?.build?.command ?? "",
              rendered.image ?? rendered.build ?? "",
              rendered.working_dir ?? "",
              rendered.environment ?? {},
            ]),
          )
          .digest("hex")
          .slice(0, 24),
      ];
    }),
  );
}

// The tree Git would commit from the worktree, untracked files included and
// ignored ones (build output, node_modules) left out, written with a copy
// of the index so the story's own index is untouched.
const revisionScript = `set -e
index="$(git rev-parse --git-path index)"
copy="$(mktemp)"
trap 'rm -f "$copy"' EXIT
cp "$index" "$copy" 2>/dev/null || rm -f "$copy"
GIT_INDEX_FILE="$copy" git add -A >/dev/null 2>&1
GIT_INDEX_FILE="$copy" git rm -r -q --cached --ignore-unmatch .blame >/dev/null
GIT_INDEX_FILE="$copy" git write-tree`;

export async function sourceRevision(worktree: string) {
  const { stdout } = await run("sh", ["-c", revisionScript], { cwd: worktree });
  const tree = stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(tree))
    throw new Error("The story's source revision is unknown");
  return tree;
}

function inReview(worktree: string, now: number) {
  if (agentWorksIn(worktree)) return false;
  return now - (lastAgentWork.get(key(worktree)) ?? 0) >= reviewGraceMs;
}

function servingStatePath(worktree: string) {
  return joinWorkspacePath(
    localPreviewPaths(worktree).engineState,
    "serving.json",
  );
}

export async function readServingState(
  worktree: string,
): Promise<ServingState> {
  try {
    const value = JSON.parse(await readFile(servingStatePath(worktree))) as
      Partial<ServingState> | undefined;
    return {
      mode: value?.mode === "production" ? "production" : "development",
      builds:
        value?.builds && typeof value.builds === "object"
          ? Object.fromEntries(
              Object.entries(value.builds).filter(
                ([, build]) => typeof build === "string",
              ),
            )
          : {},
      ...(typeof value?.failed === "string" ? { failed: value.failed } : {}),
      ...(typeof value?.revision === "string"
        ? { revision: value.revision }
        : {}),
    };
  } catch {
    return { mode: "development", builds: {} };
  }
}

// Only next to the engine's own state: a worktree removed meanwhile, such
// as during a build, is not brought back.
async function writeServingState(worktree: string, state: ServingState) {
  if (!(await pathExists(localPreviewPaths(worktree).engineState))) return;
  await writeFileAtomic(
    servingStatePath(worktree),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

function key(worktree: string) {
  return normalize(resolve(worktree));
}

/** For tests: forgets the agent activity seen so far. */
export function resetServingActivity() {
  lastAgentWork.clear();
}
