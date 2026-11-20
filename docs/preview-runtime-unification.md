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

### Resource use (2026-10-24, hibernation 2026-11-15)

- Preview containers run in `blame-previews.slice` (macOS runtime):
  MemoryHigh 80 %, MemoryMax 90 % of the VM, CPUWeight 50, so a runaway
  preview cannot starve the agent. The build cache keeps 3 GB.
- The desktop reads service states with `docker ps` and `docker inspect`
  (about 20 ms per call in the VM) instead of `docker compose ps` (58 to
  83 ms), since each open preview is polled every two seconds.
- A story whose run configuration is `null` starts nothing while the agent
  works, but the desktop prefetches its images and the setup tasks that
  need no service; the review auto-start respects `null`.
- Hibernation (2026-11-15, `local-preview-hibernation.ts`). A local
  preview unused for 5 minutes hibernates: one root command on the Docker
  host pauses its service containers (cgroup freezer) and writes their
  `memory.current` to their `memory.reclaim`, so anonymous memory goes to
  the swap file and file pages are dropped. Paused containers count as
  running, so the lifecycle stays `ready`: no state of its own, no start
  steps on resume. Unused for 2 hours (hibernated or not), it is stopped
  as before (`suspended`), which also frees its swap and file watchers.
- Use is a state read from a visible window, an agent preview tool, the
  in-app browser, a surface, a start request, or a client connecting to
  its port. An agent session in the worktree no longer keeps the preview
  awake; it only keeps it from the 2-hour stop, until 2 hours after the
  agent finished, since the user usually reviews it then.
- Every access goes through `ensureLocalPreviewAwake(worktree)`, which
  unpauses and waits until the preview URL answers: the harness (`inspect`,
  so devtools, screenshots, logs, `waitFor`), the agent host for surfaces
  and component previews, the in-app browser bridge (per request, without
  counting as use, since a hidden page may poll), screen and terminal
  sockets, screen actions, and `controlProjectPreview` start. The backlog's
  `ensureProjectPreviewUrl` poll returns the URL of a hibernated preview
  without probing it. Clients that reach the port directly (external
  browser, devices, an agent's `curl` or database client) are seen by a
  watcher on the Docker host: it reads each paused container's own
  `/proc/<pid>/net/tcp{,6}` every second and wakes the preview on a new
  connection to a listening port, or on unread bytes on an existing one
  (a request on a kept-alive connection).
- A wake restarts the preview instead of resuming it when its containers
  are gone (Docker or the VM restarted), a dependency input changed
  (lockfiles, `package.json`, Dockerfiles, Compose files), or more files
  changed than an eighth of `fs.inotify.max_queued_events` (2048), past
  which a dev server's watcher may lose events. Docker is the source of
  truth: paused previews left by an earlier Blame (crash, or Linux, where
  Docker outlives the app) are adopted on the first access. Docker stops
  paused containers cleanly (1.3 s instead of 0.8 s), and a Docker restart
  stops them like running ones.
- Measured in a throwaway VM (runtime v13, 6 vCPU, 4 GiB, swap file),
  three `next dev` 16.4 Turbopack previews of a 9-page app, single runs:
  - Memory: 360 to 500 MiB per warm preview, 7 to 10 MiB hibernated
    (hibernation 0.2 to 2.5 s, mostly writing swap). After a wake and all
    9 pages, 120 to 200 MiB is resident again; the rest stays in swap.
  - Resume: unpause 130 to 300 ms (once 790 ms); first page 0.1 to 1.5 s after the
    wake; all 9 pages 0.3 to 4 s; 0.6 to 1.6 CPU-s. The previous stop and
    start took 9.5 to 11.7 s and 13 to 17 CPU-s for the same pages.
  - Scenarios, each woken and answered: agent screenshot (page in 0.5 to
    1.5 s, headless capture of another page in 2.4 s), component preview
    container reaching the paused database (1.2 to 1.8 s), external
    `curl` on the host port (0.9 to 2.8 s, watcher), `psql` on the paused
    database's published port (0.7 to 1.5 s with the client container),
    an edit while asleep served after the wake, a lockfile change and
    6,000 changed files restart it, a Docker restart restarts it, a new
    desktop process adopts a paused preview.
  - CPU at rest: three awake idle previews use about 3 ms/s; asleep they
    use none, but the watcher costs the VM about 4 ms/s. Hibernation pays
    in memory and in resume cost, not in idle CPU.
- Not adopted, measured: zswap (lz4, 20 % pool) left 130 to 150 MiB per
  hibernated preview in RAM instead of 8 to 9, for a first page in 0.1 to
  0.2 s instead of 0.3 to 1.5 s and the same CPU. CPU weights by
  visibility (`docker update --cpu-shares`, 10000 against 1): a visible
  preview rebuilt 9 pages after a shared component edit in 0.24 to 1.2 s
  with equal weights and 0.31 to 0.62 s with priority while two others
  cold-started; the VM was not saturated (17 to 75 % busy), so no
  measurable gain. Turbopack also recovered from 6,000 files changed while
  paused (it served the last edit); the restart guards other watchers.
- Limits: a page left open whose dev client sends periodic messages
  (Next.js with webpack pings every 2.5 s; Turbopack does not) wakes its
  preview through the watcher. Writing `memory.reclaim` needs root: on
  Linux, where Docker commands run as the user, a preview is only paused.
  Windows (WSL2) and Linux were not tested; on a cgroup v1 or hybrid
  host the reclaim is skipped and the pause still applies. The vz memory
  balloon has no free page reporting, so the Mac does not get the freed
  memory back: other previews and agents in the VM reuse it instead of
  growing the VM.
- Lima attaches a memory balloon but never drives it, and the vz balloon
  has no free page reporting: the VM keeps every page it touched (4.1 GB
  on the Mac for 400 MB used in Linux). The VM therefore runs only while
  something uses it; see "The runtime on demand" below.
- Not done: sharing pnpm's store with node_modules by hard links. Links
  need one mount; putting the virtual store outside the project breaks
  Vite and Turbopack, and a per-install store loses the shared cache.

#### The runtime on demand (2026-11-19)

The Blame Runtime VM starts when something needs it and stops once
nothing used it for 10 minutes (`runtime-power.ts`).

- One place starts it: the runtime agent asks `ensureRuntimeRunning`
  before every request, and every command reaches the VM through it
  (git, files, Docker, terminals, previews, the Cline hub); the code
  graph, the only direct `blame-lima-runtime` caller, asks too. A start
  checks the runtime first: it boots an installed VM (and updates an
  outdated one, as `ensure` does) but never installs a missing one.
- The app no longer starts it at launch. A queued or interrupted local
  story, the drawer writing a new Local Container story, an open story's
  preview, a terminal or an agent start it; the agent prewarm follows each
  start. A start the desktop decides on shows the app's "Starting Blame
  Runtime" notice; stopped is a resting state in Settings.
- Background work never starts it and is not use: the idle and review
  build sweeps, the port watcher, adoption of paused previews, the run log
  follower (`docker compose logs -f`, which otherwise held it as long as a
  preview existed), the backlog's preview recovery poll, preview state
  reads from a hidden window, and the board's git polls (each local
  story's diff and pull request check, every 15 s while it shows). These
  fail at once while it is stopped; the board keeps the numbers it last
  showed.
- Use is any other request or open stream (a terminal, a log the user
  follows); an agent at work in the runtime and an awake preview count as
  use while they last. It never stops during an install, update, repair or
  reset, which go through `runtimeLifecycleOperation`. A stop takes the
  runtime's lifecycle lock (`blame-lima-runtime stop`, `wsl --terminate`
  on Windows, where the status read no longer starts the distribution).
- Hibernated previews do not keep it: a stop loses their pause, and their
  next use restarts them. Their state reads "pending", not "error", while
  that wake restarts them. A client outside Blame (a browser, a device)
  cannot reach a preview while the runtime is stopped.
- The delay: previews hibernate after 5 minutes unused, so by then the VM
  holds almost nothing in Linux but still 2 to 4 GB on the Mac. A stop
  costs the next use a boot of 14 to 23 s on a loaded Mac (`limactl start`
  is about 10 s of it, three status checks and `docker-ensure` the rest)
  and each hibernated preview a restart instead of a resume.

Measured in a throwaway VM (runtime v15, 6 vCPU, 4 GiB) with the dev
app, a `next dev` 16.4 preview per story; memory is the footprint of the
vz process on the Mac, the dev app's own processes stay at 0.7 to 1.4 GB
in both builds:

| Scenario | Before (`main`) | After |
|---|---|---|
| App open, project without local story | VM booted at launch: 1.3 GB within a minute, then constant | stopped: 0 |
| App open, three local stories in review on the visible board | — | stopped for 5 min: 0 |
| One story in review, preview, then idle | 2.1 GB, constant for 10 min (no stop) | 2.8–3.0 GB¹, preview hibernated at 5 min, VM stopped 10 min later: 0 |
| Three stories in review, previews, then idle, board visible | — | 4.0 GB, previews hibernated at 5 min, VM stopped 10 min later: 0 |

¹ an earlier run that also installed node_modules; `main` stays up
whatever it holds, since nothing stops it before Blame quits.

- First use with the VM stopped: creating a story's worktree took 14.9 s
  instead of 0.3 s; the boot itself 13 to 23 s. Opening a story whose
  preview hibernated before the stop: its state reads "pending" then
  "ready", and its first page answers 19 to 22 s after the open.
- Not possible without a stop: the vz balloon releases nothing to the
  Mac (Lima's balloon PR #4226 was closed for that reason; a 7 GiB
  deflation elsewhere returned nothing in 7 minutes). Lima's krunkit
  driver does return freed pages (libkrun free page reporting) but needs
  krunkit from a third-party Homebrew tap, libkrun 1.19+ and a new VM,
  and was not tried. On Windows, WSL2 already returns freed memory
  (`autoMemoryReclaim=dropCache` by default) and shuts its VM down 60 s
  after the last distribution stops; Windows was not tested.

#### Cold starts (2026-11-15)

A dev server compiles at its first requests, node_modules included, and
writes its cache some seconds after it goes idle: that write is the
memory peak of a preview. `local/local-preview-cold-start.ts` drives two
measures, only for a start whose selected services are not running and
whose worktree has no compiler cache yet (warm restarts and woken
previews skip both):

- **Seeded cache** (`local-preview-compile-cache.ts`). Compiler caches
  are found from the services' package dependencies; today only
  Turbopack (`next` → `.next/dev/cache/turbopack`, `.next/cache/turbopack`).
  An empty cache is filled from the snapshot of its dependency key (same
  manifests, so same compiler and node_modules), a volume
  `blame_compile_cache_<key>` that holds one snapshot and goes with the
  key's last node_modules volume. Only the compiler's own cache is copied,
  never its output: Turbopack checks sources, config and environment
  against what it restores. A snapshot is taken from a cold start (or one
  seeded from a snapshot over 6 h old) once its compiler wrote the cache
  after the first page and nothing changed for 5 s, with the same listing
  before and after the copy. Copies run in a busybox container through
  the Docker host, with no provisioning change.
- **Compile turns** (`runtime-heavy-work.ts`, shared with review builds
  and agent checks since 2026-11-19: see "Heavy work and agent processes"
  below). A start waits for a turn right before `up` ("Waiting for
  another preview to compile", or for what else holds the turn).
  One start always runs; another joins while the host's `MemAvailable`
  covers every running estimate plus its own (cold 3.25 GiB, seeded 1.75
  GiB: the measured peaks plus a margin), so a 4 GiB Runtime compiles one
  at a time. A seeded start ends its turn at its first page; a cold one
  when its cache became the snapshot (or 30 s after its first page if the
  compiler never writes, at most 3 min). A cold start that waited seeds
  again once admitted. Dependency installs keep their own queue.

Measured in a throwaway VM (runtime image v13, 6 vCPU, 4 GiB, swapfile;
`next dev` 16.4.6 Turbopack, a 9-page app with heavy client components;
the Mac under load from other VMs, so CPU times are noisy):

| One story | CPU s | cgroup peak | first page |
|---|---|---|---|
| cold, pages + cache write | 57–77 | 2.9–3.1 GiB | 7–14 s |
| seeded from a snapshot | 11–15 | 1.5–1.6 GiB | 4.6 s |

| Three new stories at once | CPU s (total) | VM swap peak | all first pages | all settled |
|---|---|---|---|---|
| before (6 runs) | 146–350 | 2.4–3.4 GiB | 11–17 s | > 210 s: two never wrote their cache |
| after, no snapshot (3 runs) | 70–103 | 3–409 MiB | 36–51 s | 37–53 s |
| after, snapshot present | 39 | 1.2 GiB¹ | 21 s | 24 s |

¹ three previews running in 4 GiB: the earlier ones are swapped out once
started, not during compilation (each container's swap peak stays under
0.6 GiB).

- Exactness: `local-preview-compile-cache-next.test.ts`
  (`BLAME_COMPILE_CACHE_E2E=1`, optional `BLAME_TEST_DOCKER_PREFIX`) runs
  a real `next dev`: a seeded story serves its changed, added and deleted
  pages, module, client component, CSS, `next.config` and environment, in
  both directions, and raw copies taken while Turbopack writes leave their
  stories correct (Turbopack commits through `CURRENT`).
- Turbopack writes its cache only once it compiled enough (9 pages did,
  3 did not): a story whose first page is all it ever serves leaves no
  snapshot, and the next ones start cold in turn.
- Not seeded: Next's webpack cache (no gain measured, even on a story's
  own restart: 35–38 CPU s), Vite (its dependency cache is in the shared
  node_modules). Nuxt, SvelteKit and Astro were not measured.

#### Heavy work and agent processes (2026-11-19)

**One admission for heavy work in the Runtime** (`runtime-heavy-work.ts`).
Cold and seeded preview starts, review builds and the checks agents run
take turns in one queue in the desktop: one piece of work runs whenever
none does, another joins while `MemAvailable` covers every running
estimate plus its own (cold 3.25 GiB, seeded 1.75, review build and agent
check 2 GiB each), in order. An agent's check never waits for anything
but another agent's check, so an agent working alone is never held up, and
a session's next check does not wait for its own (the harness already runs
a session's commands one at a time).

- Agent checks (`agent-heavy-checks.ts`, on the desktop's `lightWorkspace`
  route to the Runtime): `finish_task`, project tasks, and commands that
  run a package script named build, test, typecheck, check, lint, e2e,
  verify, validate or ci, or a build, type check, test or lint tool (`tsc`,
  `vitest`, `jest`, `next build`, `cargo test`, `go test`, `pytest`…). A
  check the harness answers as still running (after its 15 s initial
  wait) keeps its turn until an inspect sees the run end, the session ends
  or aborts, or 5 minutes pass (the harness stops a command at 120 s). A
  check that waited carries `data.waitedForTurn` (seconds, what it waited
  for) for the agent; its tool call card shows "Waited N s".
- Review builds take a `build` turn right before `compose run`, log what
  they wait for, and give up when an agent takes the story back meanwhile.

Measured in a throwaway VM (runtime image v13, 6 vCPU, 4 GiB, 4 GiB
swapfile): three copies of a Next.js 16.4 app (9 pages with heavy client
components, 60 typed modules), each verified with `tsc --noEmit` then
`next build` (alone: 36 CPU-s and 650 MiB for `tsc`, 120 CPU-s and
1.3 GiB for the build, MemAvailable down by 1.9 GiB). The Mac's load from
other VMs changes everything, so runs are paired by load:

| Three verifications | Mac load | All done | VM CPU-s | Min MemAvailable | Swap written | Killed |
|---|---|---|---|---|---|---|
| one after the other (2 runs) | ~20 | 134–204 s | 294–384 | 1.7–2.1 GiB | 0 | 0 |
| at once (2 runs) | ~20 | 468–630 s | 1,153–1,545 | not sampled | up to 1.5 GiB | 1 build (OOM) |
| one after the other (2 runs) | 6–14 | 41–54 s | 124–152 | 1.6–1.7 GiB | 0 | 0 |
| at once (3 runs) | 6–14 | 34–59 s | 174–265 | 27–45 MiB | 0.5–1.4 GiB | 0 |

At once, three builds exhaust a 4 GiB Runtime: they finish no sooner
(one after the other, they are done at 12–17, 26–30 and 41–54 s), use
1.1–1.9× the CPU, and on a loaded Mac three times the CPU, with the kernel
killing a build while the swapfile was still free (reclaim could not keep
up). In a 4 GiB Runtime the queue runs them one after the other; a larger
Runtime runs several.

**Agent processes.** Measured on macOS (Electron utility process, Claude
Code 2.1): an agent worker holds ~220 MB (footprint) once its runtime is
loaded and takes ~2 s to load it; a Claude Code process ~110–120 MB, idle
or after a 160k-token turn.

- The main process does not load the agent runtime (2026-11-19). The
  package's main entry pulls the whole engine and the Cline SDK; the main
  process takes the light utilities it needs from targeted entries
  (`@blame/agent-runtime/preview-manifest`, `/project-run-configurations`,
  …) and asks the engine host for MCP OAuth, which needs the SDK. In the built
  app on a project's backlog (`scripts/main-process-bench.mjs`, 5
  interleaved launches): main process 262 → 90 MB of footprint and
  3,045 → 773 modules loaded, first window 1.06 → 0.50 s, backlog
  4.47 → 3.89 s; the renderer (97–98 MB) and the first worker, which the
  backlog starts (222–224 MB, ready in ~0.8 s, first answer after
  ~2.55 s), are unchanged. `check-main-process-imports.mjs` fails the
  desktop build when the main process can load the engine again.
- The agent workers and their pool are gone (2026-11-20): every agent,
  one-shot work included, runs in the engine host
  (`docs/engine-in-the-app.md`), which also signs in to MCP servers.
- One Claude Code bridge for the app: the first worker to need it hosts
  it, the others reach it through its saved port and secret
  (`claude-code-bridge-client.ts`), so its caps (12 processes, 6 per
  session) bound the whole app instead of each worker. Lanes still stay
  55 minutes after a story's last turn: a new process replays the whole
  transcript as one message, a full prompt-cache write (162k tokens for a
  160k-token history) instead of a cache read, so the hour of prompt cache
  is worth ~115 MB. A lane closes at once when its story's worktree is
  removed (approved, merged, discarded, deleted) or a new project
  generation ends, and an idle lane closes when a newer conversation of
  the same session starts (a finished subagent, history Cline rewrote):
  the bridge log of 2026-11-05 to 19 shows 23 such lanes kept to expiry,
  36 lane-hours.
- The semantic harness in the Runtime keeps a session's workspace (managed
  runs, read coverage, indexes: ~7 MB of heap for 765 files, ~30 MB for
  3,700) for an hour after its last request, at most 8, never while it
  runs a command; it kept 32 until the VM stopped.

Three stories at once, then inactivity (the pool's code with these sizes):

| | During | 10 min after | 1 h after |
|---|---|---|---|
| Agent workers, before | 3 (~660 MB) | 3 | 3, until Blame quits |
| Agent workers, after | 3 | 1 (~220 MB) | 1 |
| Claude Code, before | 3+ (~115 MB each, one bridge per worker) | 3+ | 0 |
| Claude Code, after | 3+ (one bridge) | those of stories not yet approved | 0 |

Not tested: Windows (WSL2) for all of the above.

### Lighter dependencies and review builds (2026-11-15)

Measured in a throwaway 4 GiB VM (runtime image v13, one run each, small
apps); private (anonymous) memory unless noted.

**Development settings for heavy dependency images.** The local Compose
target (`compose/dependency-tuning.ts`) starts official images with
development memory settings. It is the local target and not the compiler
so that cloud plans, their hashes and the runner stay as they are.

| Image | Default, at rest / seeded | With the settings | Setting |
| --- | --- | --- | --- |
| `mysql` 8.4 and 9 | 421 / 509 MiB | 181 / 240 MiB | `--performance-schema=OFF --innodb-buffer-pool-size=64M` |
| Elasticsearch 8 | 2.4 GiB | 1.0 GiB | `ES_JAVA_OPTS=-Xms512m -Xmx512m` (heap defaulted to half the VM) |
| OpenSearch 2 | 1.47 GiB | 0.93 GiB | `OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m` |

"Seeded" is 40 tables and 200,000 rows. Postgres and PostGIS (3–8 MiB
private, the rest is reclaimable page cache), MariaDB (no Performance
Schema by default), MongoDB (its WiredTiger cache only matters past
256 MiB of data) and Redis/Valkey gained less than 20 MiB and keep their
defaults. No setting touches durability (redo log, flush policy, data
directories). A service with its own command, entrypoint or heap option,
and non-official images (Bitnami), are left as declared. Only new
containers get the settings (label `blame.dependency-tuning`): changing an
existing database container would recreate it, and the engine would rerun
its seed against the data its volume kept.

**Review builds.** A service may declare `production: { build?, command,
environment? }`; the initialization agent fills it for Next.js 16+, Vite
and SvelteKit, Astro, React Router and Nuxt. `compilePreviewManifest(m,
{ serving: "production" })` returns the review variant of the plan (the
default plan ignores `production`). In the desktop,
`local/local-preview-serving.ts`:

- Once no agent has worked in a story for 3 minutes, a sweep (every
  minute, one build at a time) builds each selected service that declares
  `production`, with `compose run --rm --no-deps` of the review variant's
  Compose file, while the development server keeps serving. On success
  the preview starts again in review mode: Compose recreates only those
  services, on the same ports.
- A build is keyed by the source revision (the tree `git add -A` would
  write, from a copy of the index, without `.blame`) and by the build's
  command, image, working directory and rendered environment, browser
  bindings included. A start serves the build only when every key
  matches; otherwise it starts the development server.
- Back to development: when an agent session starts or a message is sent
  to the story (`beforeWorkspaceWrite`), when the source changes under a
  served build, when a build fails (not retried for that revision; the
  development service restarts, since a build may rewrite files it
  reads) and when the production start fails.
- Paused (hibernated) or stopped previews are not built.
- On by default; Settings › Story previews turns it off per project
  (`preview-serving-settings.json`, keyed by the project folder that
  story worktrees record).

| Next.js 16.4, 9 pages | Development | Review build |
| --- | --- | --- |
| Steady state, private / total | 406 / 547 MiB | 69 / 77 MiB |
| CPU to serve the 9 pages once | 22 s (start + on-demand compile) | 3 s |
| Build | – | 9.7 s, 25 CPU-s, peak 1.9 GiB with the development server |
| Switch | development → build 2.1 s | build → development 2.6 s |

Vite 6 (React template): 110 → 70 MiB, build 3.0 s and 3 CPU-s, both
switches 1.9 s. The development figure is low because no browser loaded
its modules; a real session transforms every module the page imports.

Differences between the two modes that a review can see:

- `NODE_ENV` is `production` (forced when the service sets another
  value, unless `production.environment` sets it). Same environment and
  bindings otherwise, and the same port, so callback URLs and cookies
  still match.
- No development overlay, no HMR, minified errors in the console. Agents
  never see the build: they work in development.
- Static rendering at build time reads the dependencies as they were
  then; the build reruns on every source change, not on data changes.
- Component previews start one-off containers from the current Compose
  file, so during the few seconds after a session starts and before the
  switch back they get the production environment.
- Build output must be ignored by Git: otherwise the revision changes
  after each build and the next start builds again (once, not in a loop).
- Next.js before 16 shares `.next` between `dev` and `build`: the agent
  declares no `production` for it.

Not tested: Windows (WSL2) and native Linux runtimes, an existing story
switching through the real app (the measurements drove Compose with the
rendered files), and builds that need a running database. Manifests
written before this change have no `production` until the project is
initialized again.

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
