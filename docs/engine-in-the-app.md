# The agent engine in the desktop app

How the app runs agents on `blame-engine` (`crates/`). Quick chats,
development stories, the orchestrator of an epic and the
new-project assistant are conversations on it; one-shot agents run on it as tasks (see "Tasks"). The
engine in the Lima/WSL VM follows the same contract. Benchmarks run on it
too: `packages/benchmark-runner` runs a story's agent as a task
(`EngineHost.runStoryTask`, see "Benchmarks").

## Processes

```
renderer (packages/app)        main (packages/desktop)          engine host (utility process)        blame-engine (child)
platform.engine.*  ── invoke ─▶ engine-host.ts ─── message ────▶ EngineHost (@blame/agent-runtime/   ── JSON-RPC stdio ──▶ sessions, records,
                   ◀─ events ── fans events out ◀── message ──── engine): supervisor, handlers,     ◀── host/* requests ── providers, harness
                                                                  followers, client tools
```

- **Engine host**: one Electron utility process for the whole app
  (`packages/desktop/src/main/engine/engine-host-process.ts`, logic in
  `packages/agent-runtime/src/engine/`). It is the only owner of an
  `EngineClient`: it starts `blame-engine serve` through `EngineSupervisor`,
  answers every `host/*` request, follows sessions and runs the client tools.
  It stays a small Node process.
- **Main** spawns the engine host, starts it again after a crash, routes
  renderer calls to it and its events back to the windows that follow a
  session. It serves the host the desktop services the tools need
  (see "Desktop services"). It imports only types and a tiny protocol module from
  `@blame/agent-runtime/engine-protocol`: the main process stays light
  (`scripts/check-main-process-imports.mjs` still passes).
  On quit it asks the host to shut down: the engine ends running turns as
  interrupted, flushes its logs to the database, and exits. Agents stop with
  the app; if the host dies the engine's stdin closes and it exits too.
- **blame-engine** runs on the user's machine with its data directory at
  `<userData>/engine` (`sessions.db`, checkpoints). The app ships it; see
  "Engine binaries" for where it is found. The harness
  runs inside the engine (`engine_tools: ["harness"]`, `--harness-command`
  `blame-harness serve --asks`); see "Workspace harness".

## IPC surface

Renderer → main → host, all `ipcRenderer.invoke("engine:call", method, input)`
(see `EngineHostMethods` in `engine/protocol.ts`):

| method | does |
| --- | --- |
| `connect({ api })` | The API connection (URL, user token) the host uses for credentials, logs, blobs and web search. Sent at start and on every sign-in or token change. |
| `createSession({ session, purpose, settings })` | `session/create` with a config the host builds from the purpose (`quick-chat`, `development-story`, `orchestrator`, `new-project`: system prompt, tools, harness options, checkpoints). The renderer never builds a `SessionConfig`. An `orchestrator` session first makes its epic's branch and writes it to the epic (see "The orchestrator"). |
| `configure({ session, purpose, settings })` | Rebuilds the config from the settings and sets it only when it differs from the session's current one (`{ changed }`). |
| `send({ session, message, delivery, settings })` | Applies `settings` as `configure` does, uploads attachments as blobs, then `session/send`. `delivery: "turn"` while a turn runs queues it in the engine; `"steer"` joins the running turn. It answers once the message is in the engine's records. A message whose context reads as the orchestrator's wake is refused: only the host writes one. |
| `interrupt`, `compact`, `undoRewind({ session, location? })` | The engine calls of the same name. |
| `rewind({ session, to, restoreWorkspace })` | `session/rewind`: undo a message and, when asked, its files. |
| `resolveApproval({ session, call, decision })` | Answers the pending `host/approval`. |
| `follow({ session, subscription })`, `unfollow({ subscription })` | Records and deltas of one session. The caller names the subscription, so main can follow again after a host restart. |
| `running()` | Sessions with a turn running now. |
| task calls (`generateTitle`…), `cancelTask({ session })`, `deleteSession({ session })` | See [Tasks](#tasks); declared in `engine/task-protocol.ts`. |
| `status({ sessions })` | For each session, from its records: whether it exists, runs, how its last turn ended, what the agent last reported (`lastReply`: its `finish_task` summary, or its last text), how far its plan is (`plan`) and what its requests cost, rewound ones included (`spentMicroUsd`, `unpricedRequests`). |
| `epicState({ epicId })`, `epicChanged({ epicId })` | An epic's conversation state, unreported turns and spend (`EpicState`); `epicChanged` after the window wrote the epic (its settings, a pause), so the host reads it again. See `docs/orchestrator.md`. |
| `story*` | The story service (see "Development stories"; declared in `engine/story-protocol.ts`): `storySync`, `storyRefresh`, `storyRetry`, `storyQueueState`, `storyEnqueue`, `storySend`, `storyPause`, `storyResume`, `storyRewind`, `storyApprove`, `storyComplete`, `storyToBacklog`, `storyDiscard`, `storyDelete`, `storyError`. A story comes back as the API's payload. |
| `providers({ refresh })` | The providers and models to offer: the engine's `catalog/list` (models.dev) with the person's credentials, an OpenAI-compatible server's own `/models`, and the API's ranking. `refresh` asks models.dev first (the pickers do on opening). |
| `saveCredential`, `deleteCredential({ id })` | The person's provider credentials, kept by the API. |
| `signInChatGpt({ label })` | `blame-engine auth chatgpt login`: opens the sign-in in the browser (`openExternal`, served by main) and keeps the tokens in the API. |
| `claudeCodeStatus()`, `connectClaudeCode({ label })` | Whether Claude Code is installed and signed in here; saves the connection. |
| `planUsage({ providerId, credentialLabel })` | How much of the ChatGPT or Claude plan is used. |

Every call that names a session also takes `location` (`"host"`, the
default, or `"vm"`). The host picks the engine from it (see "Engine in the
VM").

Host → renderer, on `engine:event`:

- `{ type: "follow", subscription, event }`: a `FollowEvent` of
  `@blame/engine-client` (`records`, `delta`, `attached`, `state`). A new
  subscriber first gets every record the host holds for the session, then
  live events: the renderer keeps nothing between loads.
- `{ type: "activity", session, running, outcome? }`: a turn started or ended,
  for the sidebar, the running count and the "response ready" notification.
- `{ type: "plan", session, plan }`: how far a followed session's plan is
  (`PlanProgress`: done, abandoned, total, the step in hand), each time it
  moves. A story's card and its drawer header read it (`onPlan`,
  `components/chat/plan/plan-progress-store.ts`); no transcript is read for a
  card.
- `{ type: "epic", epicId, state }`: an epic's `EpicState` changed
  (`onEpic`, optional on `EnginePlatformClient`); it has no `projectId`, so
  the story listeners skip it.
- `{ type: "story", projectId, storyId, story }`, `story-removed`,
  `story-cleanup` and `story-queue`: what the story service wrote to a story
  (the API's payload), a story it deleted, the removal of a story's runtime,
  and why queued stories wait (`onStory`). The backlog of the project a
  window shows applies them; nothing is read again.
- An `activity` event carries the session's folder (`workspace`) when the
  host knows it: main keeps a preview up and never moves a target branch
  under a folder where an agent works, for sessions the host started
  itself.

## Development stories

A story is a `development-story` session (`engine/purposes/development-story.ts`):

- **Workspace**: the story's worktree, or the project folder in Direct mode.
  A worktree gets the harness's `isolated` option and, with a preview, its
  managed preview. Checkpoints are on: every turn snapshots the files.
- **First message**: the host wraps the person's brief with the story's
  title, the hint about earlier stories, and the project memory selected for
  it (`<task_briefing>`).
- **Completion contract**: `storyCompletionContract` makes `finish_task`
  the engine-checked end of a turn (see "Tasks"): a reply that stops
  without one is corrected, and a turn the agent still does not finish ends
  as `contract_unmet`, which pauses the story with that reason.
- **Plan**: stories and quick chats get `update_plan`
  (`purposeEngineTools`: the `plan` tool set, which the engine's core serves
  itself, see "The agent's plan"). The new-project assistant and the
  orchestrator do not: they discuss and decide, and have no work to break
  into steps.
- **Tools**: `purposeClientTools` / `purposeHarnessTools`
  (`engine/purposes/tool-sets.ts`) name the shared tools; the host adds the
  conversation's own (`conversationTools.ensure`: preview, story history and
  proposals, GitHub, MCP, attachments, skills) to every purpose's config.
  A story's preview tools follow the project's saved preview environment.
- **Project memory**: an accepted `finish_task` leaves its memory next to
  the harness journal; the host saves it to the account when the turn ends.
- **The story service** (`engine/stories/`, `EngineHost.stories`) owns a
  story's life, for every project the windows know on this computer,
  whatever page or project a window shows, and with no window following
  the session. It is the one writer of a story's agent fields
  (`agentStatus`, `agentLastError`, `engineSessionId`, `agentModels`) and of
  its status once it is queued. Windows call it (`story*`) and show what it
  writes; the host's own code (the orchestrator) calls its methods directly:
  `create` (with `epicId`, `modelIntent`, `requestedModel`, `startsAfter`,
  `targetBranch`, `runMode`), `edit` (the title, brief, dependencies,
  intent, model or run mode of a story not started), `enqueue`, `send`,
  `pause`, `resume`, `approve`, `complete`, `discard`, `toBacklog`,
  `remove`, `storyStatus` (a story's session, only for a story this
  computer runs and at work), `epicStories`, `loaded`, `preferences`, and
  `onTurnEnded` for one event per ended turn (its id, the story, the turn's
  outcome, the agent's report `lastReply`, and what the session spent).
  Each method checks the story is in the state it needs (`enqueue` a story
  of the backlog, `edit` one not started, `approve` one in review), and
  every action on a story runs after the one before it. The host may hold
  a queued story without a reason of its own (`holds`): the orchestrator's
  gate for an epic paused, spent or run on another computer.
- **What only a window knows**: each window sends `storySync` with its id,
  the projects open on this computer (id and folder, from its recent
  projects) and the person's settings kept on the device: the account's
  agent model as the picker resolves it, personalization, the default run
  mode, Premium, the context caps picked per story, the Blame Runtime's
  phase and the projects whose preview environment it prepares now. The
  queue runs for the projects the open windows list together; a project no
  window lists any more stops starting stories, and when a window closes
  main tells the host (`storyWindowClosed`). When the last window closes
  its list stays, since the app runs on. The latest settings win (the
  agent model is the latest one a window named, so a window whose picker
  is still loading holds nothing back); main replays each open window's
  last sync to a restarted host, the latest last, and none after a
  sign-out. A refreshed token keeps everything; signing out or another API
  starts over. A window still loading sends no `connect`, and main tells
  the host a window is not signed in only once no other open window is
  (`engine-host-router.ts`): opening or reloading a window, or one on the
  sign-in screen, signs no one out. A window that created or edited
  a story says so (`storyRefresh`); the service also reads every project's
  stories again each minute. A read asked before a write's answer arrived
  never replaces it (`stories/records.ts`).
- **One computer, its stories**: the service settles, pauses and
  reconciles only the stories this computer runs (it started their agent
  or sent them a turn), kept with their project's folder in
  `<userData>/story-turns.json` (`stories/ledger.ts`). A story another
  computer of the account runs is left alone: its session is never read
  here (reading it would pull it from Blame's database and end its running
  turn as interrupted on this computer), a pause or a message to it is
  refused, and its worktree is not removed here. A story no agent runs is
  cleaned of what this computer has of it when it is merged, done,
  discarded or sent back here, whoever started it (a story in review from
  before the ledger existed included). A story at work the ledger does not
  name (one the previous build left, or a lost ledger) is this computer's
  when its engine runs the story's session or the story's own worktree is
  here, the runtime VM's included (`storyWorktreeHere`; a Direct story's
  folder proves nothing); and, for a story already at work when its
  project is first read after the ledger started empty (no file yet, or
  one set aside), when this computer's engine keeps its session
  (`session/list`, never Blame's database). Only then, since a session
  followed here from a drawer is kept here too. The service looks when a
  project is first read and each minute (in the runtime VM only while it
  runs, since looking there starts it), and before it refuses a pause or a
  message or skips a cleanup; the ledger names the story from then on,
  and the turn it was left at work for is told (`stories/ownership.ts`). Two computers starting the same queued story is
  not prevented yet: that needs an atomic claim in the API.
- **Reconcile** (`stories/reconcile.ts`): every path ends in one step, run
  as the story's action: its record read now, set against what the engine
  says of its session (`status`), and written with retries. A turn running
  as the records say makes the story In Progress and Running (a follow-up
  to a story in review too; a compaction is not a turn and moves nothing);
  a turn that ended applies its outcome; a session that never got its
  first message is dropped and the story queued again; a start or an
  Approve & Merge cut short (a quit, a crash, a failed write) is put
  right. A session the engine cannot read now is not taken for a lost one:
  only "does not exist" is. It runs on each `activity` event, when a
  project is first read (after a quit), and every minute for the stories
  said Running whose turn does not run, one pending per story, again after
  a failure with a pause that grows to ten minutes (`stories/reconciler.ts`),
  and never waiting more than a minute on the API or the engine, so a
  story's other actions are never held. So a story this computer runs is
  never left Running with no turn running, nor In Progress with no agent.
  The engine ends a turn a crash cut as interrupted when it opens the
  session again, before `status` reads it.
- **Turns told once**: each ended turn reaches `onTurnEnded` once, after
  the story is settled, a turn that ended while Blame was closed included.
  `status` lists a session's last 100 ended turns (`endedTurns`); the
  service keeps the turns it told per session in the same file, so a
  rewind and its undo tell nothing twice. A file that cannot be read is
  kept aside (`.corrupt-<time>`), never overwritten; what it said is then
  lost (the stories it ran are not settled here, their turns not told).
- **The queue**: every story in `ready` whose files are uploaded starts, oldest
  first, with no cap on how many agents work at once (preview starts and
  builds still take turns by free memory in main, `runtime-heavy-work.ts`).
  A story whose `startsAfter` names stories of its project starts once each
  is `done`; one that was discarded or deleted means it never starts
  (`dependency-dropped`). A story that cannot start yet waits with a reason
  (`StoryWaitReason`: the stories it starts after, no model chosen, the
  preview environment being prepared, the Blame Runtime starting or
  missing, a missing tool on this computer, Git without a name, Cloud
  Preview without Premium, a failed start). Its card in Agent Queue says
  why; the window showing its project also does what only it can (start
  the runtime, the host-dependencies or Git identity dialog, a toast), then
  `storyRetry`. Every wait has a delay before the queue tries again.
- **Start** (`stories/start.ts`): the details, the run mode (a project with
  no working preview environment runs Direct), the runtime and host checks
  (desktop services `checkHostDependencies`, `gitIdentity`), the worktree
  (`createStoryWorktree`), the story in progress, then the session (a
  requeued story keeps its conversation), the turn's preparation in main
  (`prepareStoryTurn`: development server, preview sync, GitHub access) and
  the first message with the story's attachments. Its first run uses the
  story's `requestedModel` when set, else the account's agent model. A
  start that fails puts the story back in the queue with the error.
- **Turns** (`stories/turns.ts`): a message while the agent works is queued
  by the engine (or steered into the turn with Send now); a message to a
  paused or reviewed story makes it work again, said before the turn starts.
  The window sends the composer's text, excerpts and files, and the model,
  cap, personalization and Ultra mode picked; the service builds the turn's
  settings. Pause is `interrupt`; undo of a message is `rewind` with its
  files, then the turns are counted again; Compact is `compact`.
- **Board state**: an `activity` event with `running` sets `agentStatus:
  "Running"`. The engine reports no activity between accepting a message
  and its turn's first request (it sets `waiting` just before the request),
  so the activity reads idle while a turn is open: the session hub ends a
  run on the engine's idle activity, or, for a turn the engine ended before
  it ever turned busy (an interrupt at once), on the end in the records of
  the very turn the host sent (`hub.watch(session, turn)`; a session
  already followed may have that end before the send returns, and `watch`
  finds it there), never on an older turn's end met while a long log is
  read back in pages; the end of a turn sets what its outcome means (completed: In
  review; failed: Paused with `agentLastError`; interrupted or limit
  reached: Paused) and how many turns each model answered. After a quit
  mid-turn, the stories left Running are settled from `status` when the
  service first reads their project.
- **Endings** (`stories/endings.ts`): Approve & Merge runs the git flow
  (`approveAndMerge`, with what main adds through `beginGitFlow`), then the
  story is done and its runtime is cleaned as the story's next action (a
  rework or a new start waits for it, however long the removal takes):
  the agent
  stopped and its session deleted (the account keeps the conversation), its
  setup, previews and devices stopped (`stopStoryRuntime`), its worktree
  removed (`removeStoryWorktree`). The window then says where it went and
  checks the preview environment against the merge (with the story's own
  repair, read from its worktree). Done without a merge here (a Direct
  commit, a pull request merged on GitHub, nothing to merge), discarded,
  back to the backlog and deleted stories go through the service the same
  way; a discarded story keeps its conversation for a rework.
- **Drawer**: `StoryConversationProvider` follows the session once for the
  timeline, the metrics and the stats island. A turn's changed files open as
  the diff from its checkpoint snapshot (a git tree) to the next turn's, or
  to the files now for the last turn (`agent-run-diff-range.ts`).
- **Direct commit** finds the story's files from the harness journal, which
  records each write under the engine session id.

The new-project assistant is a `new-project` session per opening of the
wizard, in a scratch folder the host makes. Plan Mode's `plan` sessions are
gone; one an engine store still holds is only listed, followed, reported and
deleted like any session (none of those reads its purpose), and no window
sends it a message again.

## The orchestrator

An epic's conversation is an `orchestrator` session
(`engine/purposes/orchestrator.ts`, one per epic, its id in
`epic.engineSessionId`); `docs/orchestrator.md` is its contract.

- **Workspace**: the project folder, read only: harness `search_code` and
  `read_code`, no checkpoints, no `update_plan`.
- **Settings** (`OrchestratorSettings`): workspace, `projectId`, `epicId`,
  `model`, context cap, personalization. The host reads the epic before it
  builds the config (`Orchestrator.resolve`): its title, goal and branches
  go in the prompt, its `orchestratorModel` wins over the window's model.
- **Tools**: the project conversation tools (web research, story history,
  attachments, read-only GitHub, the person's MCP servers and skills)
  without `propose_user_stories` or a preview, plus the host's own (`engine/orchestrator/tools.ts`,
  logic and refusals in `actions.ts`): `epic_board`, `create_stories`,
  `update_story`, `story_report`, `message_story`, `approve_story`,
  `reject_story`, `end_turn`. They go through `EngineHost.stories`, never
  the API's story fields directly.
- **Completion contract**: `end_turn` is the result tool
  (`orchestratorCompletionContract`).
- **Approvals**: `create_stories`, `update_story` and `approve_story`
  declare `needs_approval`; the host's `host/approval` handler answers
  those three at once unless the epic asks before launching (any other
  tool's request is the person's).
- **The queue's gate**: `StoryServiceHost.holds` gives the wait reason of a
  story its epic holds (`{ kind: "epic", hold }`: paused, budget, elsewhere,
  direct, unknown); an epic's story never runs Direct (`stories/start.ts`
  waits with `hold: "direct"`), and an epic's Approve & Merge refuses a
  conflicting merge (`conflicts: "refuse"` of `approveAndMerge`, a
  `StoryMergeConflictError` with the files) instead of the merge agent's
  resolution: the merge is undone (`git merge --abort`, else `git reset
  --merge`), or the error says the worktree is left mid-merge and where.
- **Pause all**: the host pauses the epic's agents at work and cuts the
  orchestrator's turn running then (only that one: the person can talk to
  it while paused), then resumes exactly those (`orchestrator/pause.ts`),
  written ahead so a quit part way is taken up. The windows' story calls
  name each story a person acts on (`storyHandlers`' `touched`, awaited
  before the act runs), which the pause leaves to them; `resume` of an
  agent already running does nothing, so the person's resume and the
  epic's never double. `StoryService.retry` takes the stories to look at
  again.
- **Waking** (`engine/orchestrator/service.ts`): the host writes to the
  session itself, a user message of one `context` block holding
  `<orchestrator_wake>` (`parseOrchestratorWake`), when the epic's stories
  call for it; what a wake told is read back from the records, so each
  story turn is told once.
- **Kept on this computer**: `<userData>/orchestrator-epics.json`, the epics
  whose conversation runs here with the API they were made through and the
  branch this host made, the last settings a window sent, the turns
  waiting for a wake and those heard, each story's and the conversation's
  spend, the messages and requests for changes sent, what a pause stopped.
  A 404 never drops any of it.
- **Model choice**: `resolveModelIntent` and `escalateModel`
  (`engine/model-intent.ts`) are exported from `engine-protocol` for the
  screen.

## Engine in the VM

The renderer names a session's workspace as a root and a location
(`EngineWorkspace`). A local-container worktree lives in the Blame Runtime
VM on macOS and Windows, so its location is `"vm"` (`storyLocation`);
Direct and Cloud Preview worktrees, and every worktree on Linux, are on the
host.

- **Two engines, one host.** The host keeps this computer's engine and, on
  the first call for a VM workspace, starts a second `blame-engine serve`
  inside the VM (`engineAt`, `VmEngineOptions`). It speaks the same JSON-RPC
  over the stdio of `limactl shell BlameRuntime sudo -u blame` (through
  `blame-lima-runtime`) or `wsl.exe -d <distro> -u blame --exec`. Both
  answer to the host: credentials, client tools, approvals and replication
  to the API go through it, so nothing about a VM session is written to the
  VM's disk except its records. A credential's local endpoint (a local
  model, the Claude Code bridge) is rewritten to `host.lima.internal`.
- **Install** (`packages/desktop/src/main/engine/vm-engine.ts`): the static
  musl `blame-engine` for the VM's architecture is copied in through stdin,
  checked against its SHA-256 and made executable, into
  `/usr/local/lib/blame/engine/<hash>/`, only when that build is not there.
  Older builds are removed.
- **Harness**: the static `blame-harness` is installed beside the engine
  (both streamed in one after the other and sha-checked) and the VM's engine
  starts `<install>/harness`, a launcher (`vmHarnessLauncher`) that runs it
  with the runtime's payload: `@blame/semantic-harness-runtime`, installed by
  provisioning with `npm install -g`, whose command
  (`blame-semantic-harness`) is the compiler side process; the launcher
  takes the test reporter, the Vitest preload hook, the bundled package
  managers and ripgrep from that package. Without the payload the harness
  runs without its compiler tier.
- **Data**: `/home/blame/.local/share/blame/engine` on the VM's disk, owned
  by `blame`: a conversation resumes after a quit; checkpoints are git trees
  in the worktree's repository, as natively.
- **Stop**: the host's shutdown stops both engines. If the host dies, the
  engine's stdin closes through `limactl shell`/`wsl.exe` and it exits with
  its harness and their commands (checked with `kill -9` of the host).
- **Tasks**: a task whose workspace is under a VM folder
  (`workspaceRoots`) and uses the harness runs on the VM's engine; one that
  reads no file runs on this computer's, in its temporary folder.
- **Cost**: about 2.7 ms per JSON-RPC round trip through `limactl shell`
  (0.06 ms natively); the first call of a session pays the engine's start
  (about 0.2 s, 0.4 s more when it is installed).

## Engine binaries

The app ships two Rust binaries: `blame-engine`, and `blame-harness` (the
workspace harness the engine runs, see "Workspace harness").

- **Where they live.** A package carries `resources/engine/<platform>-<arch>/`
  for itself and `resources/engine/linux-<arch>/`, of the same architecture,
  for the runtime VM (Lima, WSL) to copy in; on Linux both are one directory.
  On macOS that is `Blame.app/Contents/Resources/engine/`; on Windows both
  are `.exe`.
- **Finding them.** `packages/desktop/src/main/engine/engine-binary.ts` is the
  one place. `engineBinary()` and `harnessBinary()` take `BLAME_ENGINE_BIN`
  and `BLAME_HARNESS_BIN` first, then the packaged resources, then the newest
  Cargo build of the checkout (`target/release` or `target/debug`).
  `vmEngineBinaries(arch)` gives the Linux pair for the VM
  (`target/engine-binaries/linux-<arch>/` in development). When nothing is
  found, every engine call fails with the reason: missing from the
  installation, not built, or a variable pointing at nothing.
- **Building them.** `node scripts/build-engine-binaries.mjs [target... | all]`
  builds release binaries into `target/engine-binaries/<platform>-<arch>/`;
  with no target, what a package for this machine carries. macOS targets
  (arm64 and x64) build on macOS, `win32-x64` on Windows (MSVC), the Linux
  ones anywhere `cargo-zigbuild` and `zig` are on `PATH`: static musl builds
  that run on a Linux desktop and in any runtime image.
  `pnpm --filter @blame/desktop package` builds them each time (a no-op when
  Cargo is up to date) unless `BLAME_ENGINE_BINARIES_DIR` names prebuilt ones.
  The release workflow builds each target in its own job
  (`.github/workflows/engine-binaries.yml`, Cargo cache kept warm on main by
  Release cache) and hands them over that way.
  `pnpm --filter @blame/desktop dev` runs `cargo build -p blame-engine -p
  blame-harness` first, so a fresh checkout answers; a failed build keeps the
  last one.
- **Signing.** macOS: `afterPack` signs them with the hardened runtime and no
  entitlement, like the Lima executables, and they are notarized with the app;
  the Linux ones are plain sealed resources. Windows: SignPath signs
  `resources/engine/win32-x64/*.exe` in the same request as `Blame.exe`.
- **Checks.** `packages/desktop/scripts/package-integrity.mjs` requires
  exactly those two targets in every package, each binary of the right format
  and architecture (read from its header), the Linux ones static.
- **Profile.** `[profile.release]`: fat LTO, one codegen unit, stripped,
  `opt-level` 3. Panics unwind: tokio keeps the other sessions when one
  task panics, so `panic = "abort"` is not an option. Fat LTO against thin
  LTO, same speed (harness `search_code`, `read_code` and `blame-engine
  catalog` medians within noise):

| Target | `blame-engine` | `blame-harness` |
| --- | --- | --- |
| darwin-arm64, thin LTO | 13.1 MB | 20.5 MB |
| darwin-arm64 | 12.1 MB | 20.3 MB |
| darwin-x64 | 13.7 MB | 20.4 MB |
| linux-arm64 (musl, static) | 11.9 MB | 20.2 MB |
| linux-x64 (musl, static) | 13.9 MB | 20.6 MB |
| win32-x64 (GNU build; releases use MSVC) | 12.4 MB | 21.7 MB |

## Workspace harness

`blame-harness` (`crates/blame-harness`, see its README) is the harness of
every engine: `search_code`, `read_code`, `edit_code`, `run_task`,
`finish_task`. The engine starts it once (`--harness-command`) and talks to
it over JSON lines: `describe` (the tools for a task contract, response
style and tool filter), `call` (a model's call, answered as the model reads
it), `cancel`.

- **Command.** `[harnessBinary(), "serve", "--asks"]`, natively from the
  engine host (`engine-host-process.ts`); `harnessEnvironment()` in
  `@blame/agent-runtime/harness-runner-path` gives what it takes from the
  agent-runtime package, through the engine's environment:
  `BLAME_HARNESS_COMPILER` (Electron, run as Node, on
  `harness/rust-harness-compiler.js`), `BLAME_HARNESS_NODE_ASSETS` (the
  test reporter and Vitest preload, unpacked from `app.asar`),
  `BLAME_HARNESS_NODE_MODULES` (the bundled package managers, unpacked) and
  `BLAME_HARNESS_RIPGREP_DIRECTORY`. In the VM, `vmHarnessLauncher`.
- **Compiler side process.** References and renames, dependency
  declarations, the import index behind `links`, TypeScript/JSONC/Prisma
  validation and the opt-in symbolic analysis stay on the TypeScript
  compiler, in a Node process the harness starts on demand and that exits
  after 60 s without a query. It is the only TypeScript left of the harness:
  `rust-harness-compiler.ts` and the modules it imports.
- **Questions** (`--asks`). While a call runs the harness asks its engine,
  which asks the host (`host/harness`): `commandCredentials` before a
  command or project task (a cloud session's GitHub token; for a story in
  the runtime VM, the token granted for writing, or none so that no
  inherited token reaches it; elsewhere the environment stays) and
  `refreshPreviewDependencies` after a dependency operation changed files
  (the preview installs them; its state is the result's `preview`). Both
  are desktop services (`commandCredentials`, `refreshPreviewDependencies`);
  without the desktop there is no answer.
- **Memory.** An accepted `finish_task` leaves the project memory candidate
  at `.blame/harness/light/<sha256(session)[:24]>.memory.json`; the host
  saves it to the account when the turn ends.

## What renders a conversation

The renderer folds records and deltas with `TranscriptReducer`
(`@blame/engine-client/transcript`, no Node imports), live and after a
reload alike. `components/chat/engine/transcript-conversation.ts` maps a
`Transcript` to the shared `AgentConversationTimeline`; that mapping is the
only place that knows both shapes. Undo of a message is `rewind` to the
item's `rewind.to` with `restoreWorkspace` when it has a checkpoint.

## The agent's plan

A short list of steps the agent writes and ticks off, shown live and refused
a finish while a step is open. It is a projection of the log, never state of
its own:

- **The tool.** `update_plan` is served by `blame-engine-core`
  (`plan.rs`), offered to a session whose `engine_tools` name `plan`. Its
  input is the whole plan, each step `pending`, `in_progress`, `completed` or
  `abandoned` (with a reason), at most one in progress; a refused input is
  answered with what to fix. It changes no file.
- **The plan is the input of the latest `update_plan` call that completed**,
  among the records in effect (`View::plan`; `currentPlan` and the
  `TranscriptReducer` in `@blame/engine-client` read it the same way). A
  rewind, its undo, a fork, a restart and an offline replay give it as the
  log says. The model's last reply of a turn may call it twice: the later
  call in the reply stands.
- **The finish gate.** `finish_task` (the contract's result tool) is refused
  before it runs while a step is open: the call's answer names the open
  steps, and `ResultRejected` carries `Refusal::OpenPlan`. Without a
  contract (a quick chat) the tool that ends the turn is held back the same
  way. A turn that never closes its plan ends as `contract_unmet` with that
  refusal, which the app words ("The agent stopped with 2 steps of its plan
  still open").
- **In the app.** The plan is a tab growing out of the composer's left edge
  (`plan/plan-tab.tsx`, beside the turn's tab); an update reads in the
  transcript as what it changed (`describe-plan.ts`); a story's card and its
  drawer header show the count and the step in hand.

## Settings during a conversation

Every message carries the settings picked when it is sent: model, reasoning,
context cap, personalization and code practices. The host rebuilds the
session's config from them and appends a `ConfigChanged` only when the result
differs from the config in effect (it reads it from the records after a
restart or a rewind), so a change of any of them applies from that message on,
and an unchanged one adds nothing. The prompt keeps the day the conversation
started (`CURRENT_DATE` comes from its first record), so a message sent on a
later day does not rewrite it and the provider's prompt cache holds.

## Who writes what to the database

- **The engine** is the only writer of the conversation: its store replicates
  each record to `/api/v1/engine/sessions/:id/records` and each blob to
  `/api/v1/engine/blobs/:sha256` through the host's `host/log/*` and
  `host/blob/*` handlers, with the user's token. Nothing else copies the
  conversation anywhere.
- **The API** keeps product state only. `quick_chats` holds `title`,
  `workspace`, `engine_session_id`; its list joins `engine_sessions` for the
  last activity. Deleting a chat deletes its engine session log, and the
  renderer deletes the engine's local copy (`deleteSession`).
  `user_stories` holds `engine_session_id`, `agent_status`,
  `agent_last_error` and `agent_models` (the models that worked on it, for
  the board); runs, activities and story comments are records.
- **The story service** in the engine host writes a story's agent fields
  above and its status from the queue on (started, settled, merged, done,
  discarded, back to the backlog, deleted); for the orchestrator it also
  creates stories and changes the brief, dependencies and model of one not
  started.
- **The orchestrator** in the engine host writes an epic's `branch`,
  `targetBranch` and `engineSessionId` when its conversation is created;
  the screen writes the rest of the epic.
- **The renderer** writes product state (create, rename, delete a chat; create
  a story and edit its fields) and nothing about runs: no run rows, no
  activities, no outboxes.

## Providers and models

The engine's providers are the product's: the app, the API (credentials,
preferences, validators) and the engine all say `anthropic`, `claude-code`,
`openai`, `chatgpt`, `gemini`, `openrouter` and `openai-compatible`
(`packages/api/app/validators/provider_id.ts`). There is no other provider.

The models come from models.dev, through the engine (`crates/README.md`,
"The model catalog"): `catalog/list` gives every client the same list, a
model published there shows in the pickers the next time one opens, and a
model the provider refuses fails the turn as `model_unavailable` with a
message that names the model and the provider and quotes the provider. The
host shapes the list for the pickers (`engine/provider-list.ts`); the API
keeps no catalog and only ranks what it is sent
(`POST /providers/recommendations`: OpenRouter's benchmarks and the
person's usage). Reasoning: the selector's `none` is the engine's `off`,
`max` is `max`, and a model is offered only the levels models.dev lists for
it.

## Credentials

`host/credential { provider, session }` is answered from the user's provider
credentials in the API (`/providers/credentials/resolve`):

| provider | answer |
| --- | --- |
| `anthropic`, `openai`, `gemini`, `openrouter` | `api_key` |
| `chatgpt` | `bearer` with the account id; signed in with `blame-engine auth chatgpt login`, refreshed with `blame-engine auth chatgpt refresh` and saved back to the API |
| `openai-compatible` | `api_key` with its base URL |
| `claude-code` | the shared Claude Code bridge: a key scoped to the session and the bridge URL |

## Tools

A client tool is a `ClientTool` (`engine/tool.ts`): name, description, JSON
Schema, effect, `endsTurn`, `needsApproval`, and `run(input, context)` with
the call's `session`, `turn`, `call`, `signal` and `progress(text)`. A
`ToolSet` turns tools into the session's `client_tools` specs and serves
`host/tool`; progress goes back to the engine as `tool/progress` and reaches
viewers as `tool_progress` deltas. Engine tools (the harness) run inside the
engine, next to the files.

The host's one tool set does three things for every call, whatever the tool:

- **Policy** (`engine/tools/policy.ts`): one table gives each tool its effect
  and whether the user approves it. An MCP tool takes `read_only` when its
  server says so (`readOnlyHint`), else Blame's rule for its own servers
  (GitHub read-only, preview DevTools `command`), else `external`. The engine
  runs read-only calls in parallel and lists command and external calls as
  not undone on a rewind. No conversation tool needs approval today.
- **Guards** (`engine/tools/guards.ts`): a call whose input names a developer
  env file (`.env`, `.env.local`, not `.env.example`) is refused; what an MCP
  server answers (GitHub, preview DevTools, the user's servers) is masked
  before the model and the transcript see it. Blame's own tools mask their
  own answers.
- **Images**: a tool answers `{ type: "image", data, mediaType }` blocks; the
  set stores each as a blob (`blob/put`) and the record keeps
  `ToolResultBlock::Image { blob }`. The model receives the image, and a
  reopened conversation still has it (the engine reads it from its store).

### A conversation's tools

Tools shared by every session (web research) are given to the `ToolSet` at
construction. A conversation's own tools are bound to its session:
`host.conversationTools.ensure(session)` (`engine/tools/index.ts`,
`ConversationTools`) lists them once with `conversationClientTools(services,
session)`, binds them to the session in the tool set and returns their specs
and the prompt section they need (the skills' scopes). A purpose builder puts
those specs in `client_tools` and the prompt in `system_prompt`.

The list stays the same for the whole conversation in this host: the specs
are part of the session's config and of the provider's prompt cache, and the
host only rebuilds a config with a message (`applySettings`). An MCP
server's tools are listed when the conversation's tools are; a tool the
server dropped later fails with the server's message, a new one shows in new
conversations, or in this one after the app restarts (one `ConfigChanged`,
one cache miss).

| tool | needs | story | plan | orchestrator | new project | quick chat (proposed) |
| --- | --- | --- | --- | --- | --- | --- |
| `search_web`, `read_web_page` | API connection, `renderWebPage` | yes | yes | yes | yes | yes (today) |
| `read_attachment` | workspace (an executor for the VM) | yes | yes | yes | yes | no: attachments are message blocks |
| `get_preview_devtools` | `previewDevtools`, a preview without surface | yes | yes | no | no | no |
| `preview_devtools__*` | `previewDevtools`, `previewDevtoolsTools`, `previewDevtoolsCall`, a preview scope | yes | yes | no | no | no |
| `preview_terminal`, `preview_display`, `preview_device` | `previewSurfaceInfo`, `previewSurfaceCall` (replace the DevTools tools) | yes | yes | no | no | no |
| `get_preview_container_logs`, `preview_environment` | `previewContainerLogs`, `previewEnvironment`, a managed preview | yes | yes | no | no | no |
| `repair_preview_initialization` | the repair task (`runInitializationRepair`), then main's `applyPreviewInitialization` (`tools/preview-repair.ts`) | yes | no | no | no | no |
| `project_app` | `projectApp`, a story in the project folder | yes | yes | no | no | no |
| `open_component_preview` | `componentPreview`, and `prepareComponentPreview` saying the workspace holds a project it renders | yes | no | no | no | yes |
| `propose_user_stories` | a project | yes | yes | no | no | yes |
| `propose_project_stack` | nothing | no | no | no | yes | no |
| `search_user_stories`, `read_user_story` | API connection, a project (`git` for changed files) | yes | yes | yes | no | yes |
| `github__*` | `githubMcpTools`, `githubMcpCall`: read-only GitHub access for the session id | yes | yes | yes | no | no |
| `<server>__<tool>` | the user's MCP servers (Settings → MCP), `McpConnections` in the host | yes | yes | yes | no | yes |
| `skills` | skill folders (`.claude/skills`, `.agents/skills`, `~/.agents/skills`… and Blame's own) | yes | yes | yes | no | yes |

The orchestrator also has its own tools, `epic_board`, `create_stories`,
`update_story`, `story_report`, `message_story`, `approve_story`,
`reject_story` and `end_turn` (see "The orchestrator").

Not client tools: `finish_task` and the harness (Rust harness), the helper
agents of ultra mode (the engine's `run_agents`, see "Ultra mode"), project
memory.

### Component previews

When a story's or a quick chat's tools are listed, main's
`prepareComponentPreview` looks for a project the component preview renders
(Vite, React, Vue 3, Nuxt 3+, Svelte 5, Angular: `component-preview-location`)
and, when there is one, hides `*.blame-preview.*` from Git in
`.git/info/exclude`. It runs with the other tool discovery, once per
conversation and host lifetime (about 25 ms on a small project). The tool
renders where the workspace is: the project folder, a managed preview's
container, a cloud preview's sandbox, or the runtime VM for a VM worktree.
When a turn ends (main's `onActivity`, running false), main removes the
preview files the conversation rendered and stops its servers; quitting does
the same. Screenshots are tool-result images (engine blobs) and land in
Blame's screenshot store with a `screenshot:<id>` reference in the result's
text. `finish_task` accepts the references the session's tool results named
(the engine passes them as `knownScreenshots`); the conversation shows an
accepted finish's images above the final reply (`turnReplyImages`).

### Desktop services

The tools ask the main process for what only it has through typed desktop
services (`engine/desktop-services.ts`, `DesktopServices`): the preview's
browser, readiness, logs, variables and screen, the screenshot store, the
component preview server, the session's GitHub MCP connection (its token
never leaves main), the project runner, Git and page rendering; and for the
story service a story's worktree, the host checks, Git's identity, a turn's
preparation and a story's cleanup
(`packages/desktop/src/main/engine/engine-story-services.ts`). The host
sends `desktop-request { method, input }`; main answers it in
`packages/desktop/src/main/engine/engine-desktop-services.ts` (the same
functions the agent runtime host uses, which delegates to it) and an aborted
call sends `desktop-cancel`, which aborts the work in main.

### The user's MCP servers and skills

MCP servers are read from the MCP settings file Settings → MCP writes
(`mcp-settings.ts`), connected with `@modelcontextprotocol/sdk` (stdio,
Streamable HTTP, SSE), one connection per server for the whole host, closed
when it shuts down. OAuth state stays in that file next to the server
(`mcp-oauth.ts`); authorizing opens the server's sign-in page and waits for
the loopback redirect. Skills are `SKILL.md` folders read from the
workspace (`.clinerules` and `.cline` for projects that also use Cline,
`.claude`, `.agents` `/skills`), the user's home (`~/.agents/skills`) and
Blame's own
(`plugins/blame-native/skills`); the prompt lists their scopes as they were
when the conversation started and the `skills` tool reads the current files.
A plugin folder (`BLAME_AGENT_PLUGIN_PATHS`) adds its skills only.

### Bringing the setup of other tools

First run (after the provider) and Settings → MCP offer to bring over what
the person already has in Claude Desktop, Claude Code, Codex (the CLI and the
desktop app, which share `~/.codex`; on this Mac it ships inside
`ChatGPT.app`), Cursor, VS Code and the open-source tools below. The first
screen shows one tile per tool, in colour when something can be imported and
greyed when not found; the second lists the items of the tools picked. Main
reads the files
(`packages/desktop/src/main/agent-import/`), the renderer reviews them
(`components/agent-import/`), and the person ticks each item.

| source | read | importable |
| --- | --- | --- |
| Claude Desktop | `claude_desktop_config.json` (`mcpServers`) in `~/Library/Application Support/Claude`, `%APPDATA%\Claude` (and the Store build's redirected copy), `~/.config/Claude` | MCP servers |
| Claude Code | `~/.claude.json` (user `mcpServers`, and each project's), `~/.claude/{skills,commands,CLAUDE.md,agents,settings.json,plugins}`; `CLAUDE_CONFIG_DIR` moves all of it | MCP servers; skills synced from claude.ai (copied); skills and commands in `~/.claude/skills` and `commands` are read in place |
| Codex | `$CODEX_HOME` or `~/.codex`: `config.toml` (`[mcp_servers.*]`), `skills/` (not `.system`), `AGENTS.md` | MCP servers (stdio, HTTP with `http_headers`); skills (copied) |
| Cursor, VS Code | `~/.cursor/mcp.json`; VS Code's user `mcp.json` (`servers`, with comments) | MCP servers |
| Cline | `~/.cline/data/settings/cline_mcp_settings.json` (`CLINE_DIR`, `CLINE_DATA_DIR`, `CLINE_MCP_SETTINGS_PATH`), the VS Code extension's `globalStorage/saoudrizwan.claude-dev/settings`; `~/.cline/skills` | MCP servers (`disabled` kept off); skills (copied) |
| OpenCode | `~/.config/opencode/opencode.json(c)`: `mcp` (`type: local` with `command` as an array and `environment`, or `remote`; also the newer `mcp.servers`); `skills/` | MCP servers; skills (copied) |
| Kilo Code, Roo Code | Kilo: `~/.config/kilo/kilo.json(c)` (OpenCode-style) and the legacy extension file; Roo: `globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json` (the repo is archived) | MCP servers |
| Gemini CLI, Qwen Code | `~/.gemini/settings.json`, `~/.qwen/settings.json`: `mcpServers`, `url` is SSE and `httpUrl` Streamable HTTP, `timeout` in ms; `skills/` | MCP servers; skills (copied) |
| Goose | `~/.config/goose/config.yaml` (`%APPDATA%\Block\goose\config` on Windows): `extensions` (`stdio` with `cmd`, `envs`; `streamable_http` with `uri`) | MCP servers (built-in extensions are Goose's own, listed only) |
| Continue, Zed | `~/.continue/mcpServers/*.json|yaml`; Zed's `settings.json` `context_servers` | MCP servers |

Checked against each project's documentation or source on 2026-11-23; not
checked on a real install here: everything but Claude, Codex and Cline (the
VS Code `globalStorage` paths follow the standard per-system prefixes;
`GEMINI_CLI_HOME`, OpenCode's Windows location and Kilo's CLI skills folder
are unverified). Left out on purpose: closed-source tools (Windsurf, Kiro,
Amp, Copilot CLI: each is one more entry in the table if wanted) and Crush
(its `crushrc` format is mid-migration).

What has no equivalent is listed, not imported: global instructions
(`CLAUDE.md`, `AGENTS.md`: Blame has no place for them, its personalization
is four notches), Claude subagents, plugins, hooks, settings, Claude desktop
extensions (`.mcpb`), servers the Codex app bundles. Connectors kept on
claude.ai or in ChatGPT are server-side and not on the disk at all. OAuth
sessions are not copied (the tokens sit in each tool's keychain): the person
authorizes again.

Decisions:

- **Own parsers, not a library.** The surveyed projects (rulesync, ruler,
  ai-rulez, add-mcp, vercel-labs/skills, openskills, vibe-rules, install-mcp)
  mostly generate configurations for many tools from one source; only
  rulesync (MIT, 23 MB, 15 dependencies, built around its `.rulesync` tree)
  and add-mcp (Apache-2.0, install-first) read native files, and none reads
  Claude Code's per-project servers, `CLAUDE_CONFIG_DIR`, VS Code's `servers`
  key with comments, or skills. The mapping is a few hundred lines. We took
  the path tables as a cross-check only. One dependency was added:
  `smol-toml` (BSD-3-Clause, no dependencies) for Codex's `config.toml`.
- **Deterministic, no agent.** Every importable thing maps 1:1: a server is a
  command (stdio) or a URL (Streamable HTTP, SSE) with `env` and `headers`; a
  skill is a `SKILL.md` folder. The only agent-shaped material is free-form
  instructions, and Blame has nowhere to put them, so there is nothing for an
  agent task to produce. If Blame gains global instructions, the conversion
  is a task like the others (`submit_*` result, no tools, the text in the
  instruction) and must stay away from the server files, which hold secrets.
- **Secrets never reach the renderer.** The scan sends masked summaries
  (names of hidden values, URLs and arguments with their tokens replaced);
  `apply` takes item ids and main reads the files again, so no secret crosses
  IPC, goes to the API, to telemetry or into a prompt. Servers are written to
  `mcp-settings.json` through the same queue as Settings (mode 600).
- **Nothing is started and nothing is overwritten.** A scan only reads. A
  server or skill of the same name that differs is a conflict: skipped unless
  ticked, then imported as `<name>-<source>`; an identical one is shown as
  already there, so re-running adds nothing. A server that uses `${VAR}` or
  an environment variable for its token (Blame expands none) is imported
  switched off. A server whose token is in its URL is left to be added by
  hand: Settings → MCP syncs addresses with the account and refuses those.
- **Skills**: ones Blame reads in place (`~/.claude/skills/<name>`, with the
  skills loader) are only shown as available; others (Codex's, the ones
  claude.ai syncs under `~/.claude/skills/synced`) are copied into
  `~/.agents/skills`, without overwriting.
- **Testing**: `BLAME_AGENT_IMPORT_HOME` points the scan (and the copy
  destination) at a fake home and hides `CODEX_HOME`, `APPDATA` and the like;
  `HOME` is never changed.

## Approvals

`host/approval` waits in the host until `resolveApproval` answers it (a
decision that arrives first is kept for a minute). The pending call shows in
the transcript (`pendingApprovals`, a tool call in `awaiting_approval`), and
the timeline shows Allow and Deny under it (`engine-approvals.tsx`; each
surface wraps its timeline in `EngineApprovalProvider`).

## Ultra mode

The person checks **Ultra mode** in the composer's reasoning menu (per story,
per chat, kept until unchecked) and each message sent then carries a
`UserBlock::Ultra`, which the conversation shows as a small marker. The agent
may then call `run_agents` (`crates/blame-engine/src/subagents/`): one to four
read-only helpers, side by side, answered with each one's report (a summary
and `path:line` or URL references).

- **Roles are the engine's.** `explore` (`search_code`, `read_code`),
  `research` (`search_web`, `read_web_page`) and `review` (the code tools; the
  workspace's `git diff HEAD` is read once by the engine and goes in the
  instruction). The lead picks a role and writes a title and a brief, never a
  prompt or a permission. The tool list is the permission: a helper's
  completion contract allows its role's tools and its `report`, so it has no
  edit, no command, no preview, and no `run_agents` (no nesting). The prompts
  are a few lines of what the role does, no persona.
- **A helper is a task session** (`SessionKind::Task`, records of its own,
  kept on this machine for the task retention, three days). Its id is
  `<call id>.<index>`, so the app finds it from the lead's call without
  anything stored beside it; its configuration says where it comes from in
  `tool_options.subagent`. It uses the lead's model, asks as the lead does
  (`AsLead`: same credential, same cache routing), and shares the lead's
  harness workspace (the lead's task contract, so one index) with reads of its
  own (the harness keys them by session). Reasoning: the lead's effort capped
  at `low` (`medium` for a review).
- **Caps** (`gate.rs`): 4 per call, 8 per turn, 4 running per session, 6
  running per engine. Blame runs every queued story at once; three stories
  with four helpers each would already be twelve model streams on one key and
  twelve callers of the one harness process. Six is two per story for three
  stories and leaves each lead its own stream; helpers past it wait for a slot (the card says
  "Waiting"), nothing is refused for it. Each helper has its own limits: 16
  requests, 4 minutes, 500k tokens counted.
- **Stopping.** The call is the lead's: an interrupt, a rewind or the engine
  stopping cancels it, and it interrupts its helpers before it answers.
- **Prompt cache.** The tool is in the tool list of every quick chat and story
  whose model can run helpers, whatever a message says, so toggling never
  changes the cached prefix (tools, then system, then messages): only the new
  message differs. The engine refuses a call made while no message of the turn
  carries the block (`ToolInvocation::ultra`, read from the log), with the
  reason. The cost is the tool's description on each request, cached. A test
  (`toggling_ultra_leaves_the_cached_prefix_alone`) pins that the tool list,
  the system prompt and every earlier message are the same on both sides of a
  toggle.
- **Claude Code** gets no helpers: each lane is a whole Claude Code process
  (about 115 MB), kept for a follow-up that a helper never makes. The tool is
  not offered there (`helperAgentsAvailable`), the engine refuses it, and the
  menu says so.
- **In the app** a `run_agents` call is a few lines of the conversation, no
  frame (`chat/sub-agents/`): a sentence that opens them ("Running 3
  helpers · 1 done", "Ran 3 helpers"), then a line per helper on the chat's own
  background: its pixel-art flower (the flower glows while it works, a small
  badge says done, failed or stopped), the flower's name, the title of its
  brief, what it does now or found, its time and tokens. The flowers are given
  by the call (a hash of its id), so a reload shows the same helpers, and no
  two helpers of a call are alike; they are a face, not a persona (the prompt is
  the role's and nothing else). A line opens the helper's thread in a dialog.
  While the call runs the lines follow each helper's own session; afterwards
  they read the call's result, so a thread the engine no longer keeps costs
  nothing. The agent's stats island reminds the person of the helpers that
  work: a section in the open panel, the flowers in the pill.

## Context shaping

The engine shapes old tool results in the model's context
(`crates/blame-engine/src/context/`, a `ContextPolicy`): command echoes,
repeated advice and repair plans, stale or partly repeated reads, completed
edits and the image budget. Targets come from the
stored records only, so the same records give the same request bytes after
a reopen. Results already sent change only in large batches or after a
compaction, so the prompt cache holds. Harness tools get the compaction in
effect as `contextGeneration`.

## Tasks

A task is an agent run with no user in it: a title, a commit message, a
project initialization. It is a session of kind `task` (`SessionConfig.kind`)
made of the same records as a conversation, so recovery, replay and the
follow subscription work alike, but nothing can be sent to it, it cannot be
rewound or reconfigured, and it ends by itself.

```
renderer                         engine host                                   blame-engine
platform.engine.call(            tasks/handlers.ts → purposes/<agent>.ts
  "generateTitle", input) ─────▶ TaskRunner.run(spec) ── task/run ───────────▶ creates the session, runs its turn
                                                       ◀─ TaskOutcome ─────── when the turn ends
                         ◀────── typed result, or EngineTaskError
platform.engine.call("cancelTask", { session }) ──── $/cancel of that task/run ─▶ the task ends as interrupted
platform.engine.follow(session) ─── records as for a conversation (progress of a long task)
```

A long task's caller names it (`task` in the call's input), calls it, then
follows it at once. The host announces the task when its call arrives and
holds a follow of it until the engine has created its session, however long
the host prepares it first (a project scan); `cancelTask` stops it in that
time too, and it ends as interrupted without running.

### How a purpose declares its task

A purpose (`engine/purposes/<agent>.ts`) returns a `TaskSpec`: the config
(`taskConfig()` in `tasks/runner.ts`), the instruction that opens the turn,
and `result(value)` that turns the validated result into the caller's type.
Its **completion contract** (`SessionConfig.contract`) is what the engine
enforces, not the prompt:

| field | meaning |
| --- | --- |
| `result` | `{ source: "submit", name, description, input_schema }`: a tool the engine offers and answers itself; a call is accepted when its input matches the schema (`submitTool()`). `{ source: "tool", name }`: one of the session's tools, such as the harness's `finish_task`; its input is checked against the tool's schema, then the tool runs, and its completion is the result. |
| `required` | Tools that must have completed in the turn, in a reply before the one calling the result tool: "inspect the code before answering" is `required: ["read_code"]`, not a sentence in the prompt. |
| `allowed` | The only tools offered besides the result tool (`[]`: none). Absent: every tool of the session. |
| `max_corrections` | How many times a model that stops without an accepted result is told so (default 2). |

What the engine does, each step stored as a record:

- A refused result call (`ResultRejected`, with the schema errors and the
  unmet obligations) goes back to the model as the call's error; it fixes it
  and calls again.
- A model that stops in text gets a `ContractCorrection` whose text is a
  pure function of what is unmet. The last one also forces the tool choice
  where the provider can: OpenAI and Gemini. Claude refuses a forced choice
  while it thinks, and the ChatGPT backend, OpenRouter and compatible
  servers may not honour one, so they get the message only.
- Past the corrections the turn ends as `contract_unmet`, naming what is
  missing. Only an accepted result (`ResultAccepted`) ends the turn: under a
  contract, a tool marked `ends_turn` does not.
- `limits` bound a task: `max_requests_per_turn`, `max_turn_tokens` (checked
  before each request) and `max_turn_ms` (a request or tool still running at
  the deadline is stopped).

`task/run` answers with a `TaskOutcome`: `completed` with the result,
`failed` with `contract_unmet`, `limit_reached` or `provider_error`, or
`interrupted`. The runner throws `EngineTaskError` for anything but
`completed`, with the outcome and a sentence saying what went wrong.

A conversation carries a contract the same way: a development story's
purpose sets `contract: { result: { source: "tool", name: "finish_task" },
... }` so a turn only ends through an accepted `finish_task`.

### What a task leaves behind

A task's log stays on the machine that ran it: the store never copies it to
Blame's database, and the engine deletes it three days after its last record
(`--task-retention`), long enough to look into a failure. A purpose that
must be readable elsewhere sets `kind: { kind: "task", replicate: true }`.
`deleteSession` (engine `session/delete`) removes a session from the engine;
the API's copy is the app's to delete, as for a deleted quick chat.

### Where a task runs

On the host's engine, or on the VM's for a task that works on files of a
project in the runtime VM (see "Engine in the VM"). A task that reads no
file runs on the host's even for a project in the VM (its folder is the
temporary one). Project initialization and code practices scan the folder
on this computer first, so they refuse one in the VM (`VM_SCAN_UNSUPPORTED`);
project folders are on this computer.

### Git flows

Approve & Merge, Open PR, the Git page's commit message and conflict
resolution run in the engine host (`engine/git/`), not in a renderer: a flow
is git work with agent steps in it, and each step is
an engine task (`GitAgent`). Main adds what only it knows to these calls
(`engineGitFlowCall` in `agent-ipc.ts`): whether the worktree is in the
runtime VM (`inVm`), the worktrees where an agent runs (`activeWorktrees`,
so a target branch never moves under one), the preview sync before a
delivery, and the worktree counted as written while the flow runs. A
story's Approve & Merge is the story service's, in the host: it asks main
for the same (`beginGitFlow`, `endGitFlow`). Git runs through main (`git`
desktop service); gh runs in the host with the person's own sign-in. A failed commit message agent leaves Blame's own message.
The conflict agent cannot run git mutations (its workspace is not isolated):
the host stages each conflicted file it left without markers, then Git says
what is still conflicted, as before.

### The tasks

| renderer call | purpose | result tool | tools |
| --- | --- | --- | --- |
| `generateTitle` | `title` | `submit_title` (run configuration ids in the schema) | none |
| `optimizeUserStory` | `user-story-optimization` | `submit_user_story` | none |
| `generateCommitMessage`, and in `approveAndMerge`, `openPullRequest` | `commit-message` | `submit_commit_message` (its first line is the subject) | none: the changes are in the instruction |
| `openPullRequest` | `pull-request-text` | `submit_pull_request` (`agentSummary` required when the story has one) | none |
| `resolveMergeConflicts`, and in `approveAndMerge` | `merge-conflict-resolution` | `submit_merge_resolution` (`resolved`, `reason`) | harness: `search_code`, `read_code`, `edit_code`, `run_task`; `required: ["read_code"]`; on the VM's engine in the VM |
| `discoverSecurityAudit` | `security-discovery` | `submit_security_discovery` | harness, `allowed: search_code, read_code`, `required: read_code` |
| `validateSecurityAudit` | `security-validation` | `submit_security_validation` (the given candidate ids in the schema) | harness, `allowed: search_code, read_code`, `required: read_code` |
| `initializeProject` | `project-initialization` | `submit_project_initialization`, a host client tool that checks each setup (or takes only `blocked`) | harness `read_code` (required), `search_code` |
| `repairProjectInitialization` | `project-initialization-repair` | `submit_project_initialization_repair`, a host client tool that checks a repaired setup | harness `read_code`, `search_code` |
| `assessInitializationImpact` | `initialization-impact` | `submit_initialization_impact` (the host reads the diff; a diff touching nothing the setup needs ends without an agent) | none |
| `analyzeCodePractices` | `code-practices` | `submit_project_code_practices` (each practice once; a starter's defaults in the schema) | harness `read_code` (required), `search_code` |
| `generateNewProject` | `new-project-generation` | `submit_new_project` | harness `search_code`, `read_code`, `edit_code`, `run_task`; `search_web`, `read_web_page` |

## Benchmarks

`packages/benchmark-runner` (`blame-headless run`, the Terminal-Bench adapter
in `tools/terminal_bench/blame_agent.py` and the corpus in
`tools/terminal_bench/corpus/`) runs one development story's agent per run,
on the engine host in its own process: `EngineHost.runStoryTask` builds the
story's config and brief, then runs it as a task with no person in it.

- **End**: an accepted `finish_task` (the story's completion contract). The
  request limit is `--max-iterations` (`max_requests_per_turn`); the runner's
  deadline cancels the task (`timed_out`).
- **Inputs**: the instruction, isolation (`BLAME_ISOLATED_ENVIRONMENT`: a
  story worktree, else the project folder), required checks and acceptance
  criteria (added to the harness contract), the project memory file.
- **Outputs**: `result.json` and `events.jsonl` keep their shape. The events
  come from the session's records once it ended; a tool's output is the
  harness's own result, from the trace `blame-harness` writes when
  `BLAME_HARNESS_TRACE_FILE` is set (`harness-trace.jsonl`, beside the
  events: `{at, toolCallId, tool, input, raw, presented}` per call). Usage and cost are the records' (`cost_micro_usd`); request counts
  are exact (`requestObservations.coverage: "engine_records"`).
- **Engine binary**: `BLAME_ENGINE_BIN`, else the payload's
  `engine/<platform>-<arch>/blame-engine` (`scripts/headless-benchmark-payload.mjs`
  ships the Linux builds), else this checkout's `target/debug`.

## Rules for the next slices

1. Purposes are built in the host (`engine/purposes/`), from settings the
   renderer sends. A new purpose adds a builder there, never a config in the
   renderer.
2. The renderer renders from records only. It persists no agent event.
3. Every engine call from the renderer goes through `platform.engine`; no
   other process holds an `EngineClient`.
