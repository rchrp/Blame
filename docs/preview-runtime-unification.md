# Unifying the preview runtime across local, cloud and direct modes

Status: proposal for review, 2026-10-24. Nothing here is implemented yet.

## Why

Blame runs a story preview in one of three modes:

- **Local Container**: the story worktree lives in the Blame Runtime VM (Lima on
  macOS, WSL2 on Windows) and its services run with `nerdctl compose` there.
- **Cloud Preview**: the worktree stays on the host, its source is synchronized
  to a Vercel sandbox, and the sandbox runner (`packages/sandbox-runner`) runs
  the services with Docker.
- **Direct**: the project runs its own command in the project folder.

Local and cloud previews start from the same `previewManifest`, but they
compile, run and observe it with two separate implementations. Each fix lands
in one mode only (this month's examples: the snapshot rule, the drift layer,
the stale setup preflight, start steps), and the modes slowly disagree on what
a valid project is. Unifying them means one set of rules, one engine and one
lifecycle, with mode differences reduced to where code runs and how source
reaches it.

## Today

| Stage | Local Container | Cloud Preview |
| --- | --- | --- |
| Manifest normalization | `agent-runtime/preview-manifest.ts` | same file, through the manifest written in the worktree |
| Compilation | `agent-runtime/preview-compose-yaml.ts` writes `docker-compose.yml` directly from the manifest | `preview-runtime/compilation/manifest-compiler.ts` builds a typed `PreviewExecutionPlan` |
| Compose rendering | desktop rewrites the file: `workspace-compose.ts`, `workspace-compose-volumes.ts` (~1,500 lines: ports, dependency volumes, env file mounts, corepack, webpack fallback, numeric `su`) | `sandbox-runner/supervisor/compose-renderer.ts` from the plan |
| Engine | `nerdctl compose` driven from `desktop/workspace-ipc.ts` (~5,000 lines) | sandbox runner driving `docker compose`, controlled by the API through `blame-runnerctl` |
| Orchestration | ad hoc start/stop/recovery in `workspace-ipc.ts`, state in `.blame/initialization/preview-runtime-state.json` | `preview-runtime` `PreviewOrchestrator` + `PreviewReconciler` in the API, state in `preview_sessions` |
| Source | worktree bind mount | full or delta artifacts, live deltas, change journal |
| Lifecycle for the UI | `PreviewLifecycleState` projected from the local state (now with `step`) | `PreviewLifecycleState` projected from the session |

Direct mode shares neither pipeline: it starts the project's own command
through the project runner.

## Divergences found

These are behavior differences between local and cloud for the same manifest,
found while reading both pipelines. Phase 1 removes them.

1. **Functional probes.** Local runs `previewManifest.probes`
   (`runPreviewProbes` in `workspace-ipc.ts`) and a failing required probe
   fails the start. An empty `acceptedStatuses` accepts any status below 500.
   The cloud compiler copies the probes into the plan with a different default
   (`[200, 204, 301, 302, 304]`), and nothing ever executes them: the runner
   only checks endpoint readiness.
2. **Secret-looking environment keys.** The cloud compiler rejects a manifest
   whose environment has a key ending in `TOKEN`, `SECRET`, `PASSWORD`,
   `API_KEY`... (`assertLiteralEnvironmentKey`), except local database values.
   Local accepts it. A project with `NEXTAUTH_SECRET: "dev"` previews locally
   and fails in the cloud.
   **Decision (2026-10-24): accept literal values everywhere.** Manifest values
   are development values already committed with the project; real secrets
   stay out of the manifest.
3. **Two compose generators.** The same manifest is translated twice, so every
   translation detail (dependency order, binding values, cache volumes,
   healthchecks) can drift.
4. **Normalization that only one side applies.** The desktop's compose rewrites
   (corepack shims for bare `pnpm`, `npm install --no-package-lock`, removal of
   numeric `su` users, the Next.js webpack fallback) only run for local
   previews, after compilation, instead of in the shared normalization.
5. **Readiness** is consistent (status below 500 on both sides) and is listed
   here only so it stays that way.

Differences that are by design and stay: where containers run, how source
reaches them (bind mount versus artifacts and deltas), and how the browser
reaches a service (local host port versus the preview edge and gateway).

## Target architecture

- **One compiler.** `compilePreviewManifest` turns a normalized manifest into a
  `PreviewExecutionPlan` for every containerized mode. Manifest-level
  rewrites move into normalization so both modes get them.
- **One compose renderer.** A pure renderer in `preview-runtime` turns a plan
  and a *target* into a compose model. Targets differ only in workspace source,
  port publication and cache naming.
- **One engine.** The sandbox runner runs wherever containers run: in a Vercel
  sandbox for Cloud Preview, in the Blame Runtime VM for Local Container.
- **One orchestration.** `PreviewOrchestrator` and `PreviewReconciler` drive
  every containerized preview through the `PreviewRuntimeDriver` port:
  `VercelSandboxDriver` in the API, a new `LocalVmDriver` in the desktop.
- **One lifecycle.** The UI reads `PreviewSessionView` (or its
  `PreviewLifecycleState` projection) for every mode, Direct included.

## Phase 1: the same rules everywhere

Low risk, no change to how containers run. Roughly one working session.

1. **Secret-looking keys** (`preview-runtime/compilation/manifest-compiler.ts`):
   accept literal values, keep classifying them in the environment plan.
2. **One probe rule.** Add `probeStatusAccepted(status, acceptedStatuses)` to
   `preview-runtime`: listed statuses when given, otherwise any status below
   500. The desktop probe scripts and the runner use it; the compiler stops
   injecting its own default list.
3. **Cloud runs functional probes.** The runner executes `plan.probes` after
   readiness (service-origin probes inside the compose network, host probes
   through the gateway). A failing required probe fails the start with the
   probe id and target, as local does.
4. **Local validates through the shared compiler.** `prepareProjectPreviewArtifacts`
   also calls `compilePreviewManifest`, so a manifest is accepted or refused
   with the same message in both modes.
5. **Parity corpus.** A test compiles a corpus of manifests (contract fixtures,
   initialization test results, anonymized real manifests such as
   Portfolio-V4's) and asserts both pipelines agree on services, dependency
   closure, setup order, environment including binding values, endpoints and
   probes.

Acceptance: corpus green, existing suites green, and the local
`docker-compose.yml` of every corpus manifest byte-identical to today's.

## Phase 2: one compose renderer

Medium risk: it changes how local compose files are produced.

1. Move `sandbox-runner/supervisor/compose-renderer.ts` into `preview-runtime`
   as a pure function `renderCompose(plan, target)`. The runner imports it.
2. Define the targets:
   - `sandbox`: `/workspace` owned by the runner, gateway listeners, runner
     cache volumes.
   - `local-vm`: the worktree path as bind mount, published ports on
     `127.0.0.1` (with the remembered ports), dependency volumes keyed by the
     lockfile hash, env file mounts.
3. Move the manifest-level rewrites listed in divergence 4 into
   normalization. What stays desktop-only is what depends on the host: port
   allocation and memory, env file materialization, the VM path mapping.
4. Golden tests: for the parity corpus, the `local-vm` target must reproduce
   today's local compose (compared as parsed YAML), and the `sandbox` target
   today's runner output.
5. Rollout behind a desktop flag (shared renderer off by default), then on
   for new stories, then default, then the old generator is deleted.

## Phase 3: the sandbox runner in the local VM

High effort and an infrastructure change. Several weeks, with a runtime
release.

1. **Container engine.** The runner drives the `docker` CLI; the VM uses
   containerd with `nerdctl`, which already ignores compose
   `depends_on` conditions (visible in local setup logs). Options:
   - Install Docker Engine in the Blame Runtime image: same engine as the
     sandbox, exact compose semantics, larger image and a second daemon.
   - Teach the runner a `nerdctl` engine: smaller change to the VM, but every
     compose difference has to be handled twice.
   Recommendation: Docker Engine in the VM, because engine parity is the point
   of this phase.
2. **Attached workspace mode in the runner.** Locally `/workspace` is the
   worktree bind mount, not an imported artifact: no source import, no change
   journal, no exports. The runner gets an `attached` workspace mode.
3. **`LocalVmDriver`** in the desktop implements `PreviewRuntimeDriver` by
   calling `blame-runnerctl` through the runtime agent: provision means
   bootstrap the runner in the VM, sync means attach, start and stop map to
   runner operations, logs and inspection come from the runner.
4. **Local orchestration.** Run `PreviewOrchestrator` and `PreviewReconciler`
   in the desktop with a file-backed session repository. Local previews then
   get the cloud's desired-versus-observed reconciliation, leases and
   lifecycle. The local start, recovery and readiness code in
   `workspace-ipc.ts` is retired step by step.
5. **Browser access.** Map the runner's gateway listeners to published ports
   on `127.0.0.1` through Lima and WSL2 forwarding, keeping the remembered
   ports.
6. **Release.** Version the runner with the runtime bundle, build the macOS
   (Lima) and Windows (WSL2) images, and keep the legacy engine as a per-project
   fallback until the new one has soaked.

## Direct mode

Direct keeps running the project's own command on the host, outside the
runner: no isolation is its purpose. It joins the unified model for
observation only: lifecycle, logs, failure panel and reload behavior through
the same `PreviewSessionView` projection.

## Risks

- **Local regressions** across many projects when the compose generator
  changes (phase 2). Mitigated by the golden corpus and the flag.
- **VM resources** (phase 3): a Docker daemon next to containerd in a 4 GiB VM.
  Measure, and consider raising the default VM memory.
- **Release coupling** (phase 3): desktop, runtime bundle and runner versions
  must move together, like the API and the runner today.
- **Probe enforcement in the cloud** (phase 1) can turn previews that load
  today into failures when a required probe was wrong. Ship it with a clear
  failure message and the repair action.

## Open questions

1. Docker Engine in the VM, or a `nerdctl` engine in the runner?
2. Should a failing functional probe in the cloud block readiness from day
   one, or only warn for a release?
3. Is raising the Blame Runtime VM memory acceptable for phase 3?
4. Should Direct move to the shared lifecycle in phase 1 or with phase 3?
