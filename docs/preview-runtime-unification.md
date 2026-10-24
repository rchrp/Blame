# Unifying the preview runtime across local, cloud and direct modes

Status: phase 1 implemented on 2026-10-24. Phases 2 and 3 implemented on
branch `preview-runtime-unification` (no flag: the old local system is
removed), see "Phases 2 and 3 as built" below. Not yet done: a test of the
upgrade on a real Blame Runtime VM, the runner release (0.2.20) and the
API pin, and running PreviewOrchestrator locally.

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
found while reading both pipelines. Phase 1 removed 1, 2 and the readiness
difference in 5; 3 and 4 are phase 2.

1. **Functional probes.** Local runs `previewManifest.probes`
   (`runPreviewProbes` in `workspace-ipc.ts`) and a failing required probe
   fails the start. An empty `acceptedStatuses` accepts any status below 500.
   The cloud compiler copies the probes into the plan with a different default
   (`[200, 204, 301, 302, 304]`), and nothing ever executes them: the runner
   only checks endpoint readiness.
2. **Secret-looking environment keys.** The shared parser and the cloud
   compiler reject a manifest whose environment has a key ending in `TOKEN`,
   `SECRET`, `PASSWORD`, `API_KEY`..., except local database values, so
   `NEXTAUTH_SECRET: "dev"` fails in both modes. The runner was stricter still:
   it refused to save its state for any such key, so a plan holding the public
   `MYSQL_ROOT_PASSWORD: "blame"` could not start in the cloud.
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
5. **Readiness.** The desktop readiness check and the runner accept any status
   below 500, but the local compose healthchecks (Node `r.ok`, Python
   `urlopen`) required a 2xx, and an unhealthy container fails a local start.
   The cloud compose healthcheck (`wget -q`) also fails on 4xx and needs `wget`
   in the image; it is informational today (the runner probes readiness
   itself and uses no health conditions).

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

## Phase 1: the same rules everywhere (done)

1. **Environment values.** `previewEnvironmentValueRejection` in
   `preview-contract` replaces the key-name rule in the parser, the compiler,
   the runner's plan check and its state guard. Any key is accepted; a value
   is refused when it contains a private key or a provider live key (AWS,
   GitHub, GitLab, OpenAI, Slack, Stripe) or a URL with credentials for a host
   outside the preview. The runner's `exec` operation keeps refusing
   secret-looking keys: those come from agent commands, not from the manifest.
2. **One probe rule.** `preview-runtime/domain/functional-probes.ts` owns
   `probeStatusAccepted` (listed statuses, otherwise below 500), the defaults
   (10 s timeout, the endpoint healthcheck path when the probe gives none), the
   scripts run inside containers (tested against a real server) and the
   failure message. The compiler emits an empty status list instead of its own
   default.
3. **Cloud runs functional probes.** Once every selected service is ready, the
   runner runs the plan's probes once per start (`probedEndpointRevision`).
   Host probes reach the service target directly from the runner rather than
   through the gateway, which needs a capability token; service probes run
   inside the origin container with `docker compose exec`. A failing required
   probe fails the start with `FUNCTIONAL_PROBE_FAILED`, reported by the API as
   a healthcheck failure. Open question 2 was settled as "block", like local.
4. **Local validates through the shared compiler.**
   `prepareProjectPreviewArtifacts` compiles the manifest, and local probes run
   from the compiled plan with the shared helpers.
5. **Local readiness.** Node and Python compose healthchecks accept any status
   below 500.
6. **Parity corpus.** `desktop/src/main/preview-parity.test.ts` checks four
   manifests (Next.js + Prisma + MySQL, Django + Postgres + Redis, web + API
   with server and browser bindings): the local compose and the plan agree on
   services, setup tasks and order, dependencies, environment (binding values
   included), endpoints and probe targets. The local compose is kept as golden
   files. Add anonymized real manifests there as they come up.

Shipping: the parser, compiler and local changes ship with the desktop and the
API. Cloud probe execution and the relaxed runner checks need the next
sandbox runner release (and the API's pinned runner version bumped with it).
Changing the compiled probes changes the plan hash, so existing cloud sessions
are recreated once on their next start.

## Phases 2 and 3 as built

- `@blame/preview-runtime/compose`: `renderCompose(plan, target)` with a
  `sandbox` and a `local` target, one healthcheck rule, setup tasks as
  one-shot services of the `setup` profile, health-conditioned
  `depends_on`, `init` and a 5 s stop grace. `ComposeEngine` runs a
  rendered project on any `DockerHost` (prepare, fingerprinted setup,
  images, `up --wait`, inspect, logs, exec); readiness and functional
  probes live there too. The sandbox runner uses both.
- Launch commands are normalized by the compiler (corepack pnpm, npm
  install without lockfile writes, no numeric su, CI for installs).
- Instead of shipping the runner binary into the VM, the desktop runs the
  same engine against the VM's Docker through the runtime agent
  (`desktop/src/main/preview-runtime/local/`). `LocalPreviewDriver` drives
  it behind `PreviewRuntimeDriver`; the local lifecycle file still feeds
  the UI.
- Runtime 11: Docker Engine 29.9.1, Compose 5.6.0 and Buildx 0.38.0 replace
  containerd/nerdctl/BuildKit/CNI; bounded logs and build cache, overlay2,
  small address pools; upgrade migrates live worktrees' data volumes and
  deletes the old state; unneeded Ubuntu services masked; a cleanup removes
  deleted worktrees' previews, unused node_modules volumes and old images.
- Initialization no longer produces a Compose file or setup script; its
  checks read the manifest.

## Phase 2: one compose renderer (original proposal)

Medium risk: it changes how local compose files are produced.

1. Move `sandbox-runner/supervisor/compose-renderer.ts` into `preview-runtime`
   as a pure function `renderCompose(plan, target)`. The runner imports it.
2. Define the targets:
   - `sandbox`: `/workspace` owned by the runner, gateway listeners, runner
     cache volumes.
   - `local-vm`: the worktree path as bind mount, published ports on
     `127.0.0.1` (with the remembered ports), dependency volumes keyed by the
     lockfile hash, env file mounts.
3. Render one healthcheck rule for both targets (divergence 5: the cloud
   `wget -q` check still fails on 4xx and needs `wget` in the image).
4. Move the manifest-level rewrites listed in divergence 4 into
   normalization. What stays desktop-only is what depends on the host: port
   allocation and memory, env file materialization, the VM path mapping.
5. Golden tests: for the parity corpus, the `local-vm` target must reproduce
   today's local compose (compared as parsed YAML), and the `sandbox` target
   today's runner output.
6. Rollout behind a desktop flag (shared renderer off by default), then on
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
  today into failures when a required probe was wrong. The failure names the
  probe, its target and the reason; the preview's repair action fixes the
  manifest.

## Open questions

1. Docker Engine in the VM, or a `nerdctl` engine in the runner?
2. Is raising the Blame Runtime VM memory acceptable for phase 3?
3. Should Direct move to the shared lifecycle in phase 1 or with phase 3?
