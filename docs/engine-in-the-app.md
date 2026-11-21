# The agent engine in the desktop app

How the app runs agents on `blame-engine` (`crates/`). Quick chats,
development stories, plan mode and the new-project assistant are
conversations on it; one-shot agents run on it as tasks (see "Tasks"). The
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
| `createSession({ session, purpose, settings })` | `session/create` with a config the host builds from the purpose (`quick-chat`, `development-story`, `plan`, `new-project`: system prompt, tools, harness options, checkpoints). The renderer never builds a `SessionConfig`. |
| `configure({ session, purpose, settings })` | Rebuilds the config from the settings and sets it only when it differs from the session's current one (`{ changed }`). |
| `send({ session, message, delivery, settings })` | Applies `settings` as `configure` does, uploads attachments as blobs, then `session/send`. `delivery: "turn"` while a turn runs queues it in the engine; `"steer"` joins the running turn. |
| `interrupt`, `compact`, `undoRewind({ session, location? })` | The engine calls of the same name. |
| `rewind({ session, to, restoreWorkspace })` | `session/rewind`: undo a message and, when asked, its files. |
| `resolveApproval({ session, call, decision })` | Answers the pending `host/approval`. |
| `follow({ session, subscription })`, `unfollow({ subscription })` | Records and deltas of one session. The caller names the subscription, so main can follow again after a host restart. |
| `running()` | Sessions with a turn running now. |
| task calls (`generateTitle`…), `cancelTask({ session })`, `deleteSession({ session })` | See [Tasks](#tasks); declared in `engine/task-protocol.ts`. |
| `status({ sessions })` | For each session, from its records: whether it exists, runs, how its last turn ended, what the agent last reported (`lastReply`: its `finish_task` summary, or its last text) and how far its plan is (`plan`). |
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
  itself, see "The agent's plan"). Plan mode and the new-project assistant do
  not: they discuss and propose, and have no work to break into steps.
- **Tools**: `purposeClientTools` / `purposeHarnessTools`
  (`engine/purposes/tool-sets.ts`) name the shared tools; the host adds the
  conversation's own (`conversationTools.ensure`: preview, story history and
  proposals, GitHub, MCP, attachments, skills) to every purpose's config.
  A story's preview tools follow the project's saved preview environment.
- **Project memory**: an accepted `finish_task` leaves its memory next to
  the harness journal; the host saves it to the account when the turn ends.
- **Lifecycle**, all from the renderer through `platform.engine`
  (`pages/backlog/story-engine.ts`, `use-backlog-rotation.ts`,
  `use-story-comments.ts`): start creates the session and sends the brief;
  a message while the agent works is queued by the engine (or steered into
  the turn with Send now); Pause is `interrupt`; undo of a message is
  `rewind` with its files; Compact is `compact`.
- **Board state**: the renderer is the one writer of the story's agent
  fields (`use-story-agent-outcomes.ts`). An `activity` event with
  `running` sets `agentStatus: "Running"`; the end of a turn sets what its
  outcome means (completed: In review; failed: Paused with
  `agentLastError`; interrupted or limit reached: Paused). After a quit
  mid-turn, stories left Running are settled from `status` when the backlog
  loads.
- **Drawer**: `StoryConversationProvider` follows the session once for the
  timeline, the metrics and the stats island. A turn's changed files open as
  the diff from its checkpoint snapshot (a git tree) to the next turn's, or
  to the files now for the last turn (`agent-run-diff-range.ts`).
- **Direct commit** finds the story's files from the harness journal, which
  records each write under the engine session id.

Plan mode is a `plan` session per project (its id kept in local storage);
the new-project assistant is a `new-project` session per opening of the
wizard, in a scratch folder the host makes.

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
- **The renderer** writes product state (create, rename, delete a chat or a
  story, a story's agent fields above) and nothing about runs: no run rows,
  no activities, no outboxes.

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

| tool | needs | story | plan | new project | quick chat (proposed) |
| --- | --- | --- | --- | --- | --- |
| `search_web`, `read_web_page` | API connection, `renderWebPage` | yes | yes | yes | yes (today) |
| `read_attachment` | workspace (an executor for the VM) | yes | yes | yes | no: attachments are message blocks |
| `get_preview_devtools` | `previewDevtools`, a preview without surface | yes | yes | no | no |
| `preview_devtools__*` | `previewDevtools`, `previewDevtoolsTools`, `previewDevtoolsCall`, a preview scope | yes | yes | no | no |
| `preview_terminal`, `preview_display`, `preview_device` | `previewSurfaceInfo`, `previewSurfaceCall` (replace the DevTools tools) | yes | yes | no | no |
| `get_preview_container_logs`, `preview_environment` | `previewContainerLogs`, `previewEnvironment`, a managed preview | yes | yes | no | no |
| `repair_preview_initialization` | the repair task (`runInitializationRepair`), then main's `applyPreviewInitialization` (`tools/preview-repair.ts`) | yes | no | no | no |
| `project_app` | `projectApp`, a story in the project folder | yes | yes | no | no |
| `open_component_preview` | `componentPreview`, and `prepareComponentPreview` saying the workspace holds a project it renders | yes | no | no | yes |
| `propose_user_stories` | a project | yes | yes | no | yes |
| `propose_project_stack` | nothing | no | no | yes | no |
| `search_user_stories`, `read_user_story` | API connection, a project (`git` for changed files) | yes | yes | no | yes |
| `github__*` | `githubMcpTools`, `githubMcpCall`: read-only GitHub access for the session id | yes | yes | no | no |
| `<server>__<tool>` | the user's MCP servers (Settings → MCP), `McpConnections` in the host | yes | yes | no | yes |
| `skills` | skill folders (`.claude/skills`, `.agents/skills`, `~/.agents/skills`… and Blame's own) | yes | yes | no | yes |

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
never leaves main), the project runner, Git and page rendering. The host
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
  running per engine. Blame runs up to three stories at once; three stories
  with four helpers each would be twelve model streams on one key and twelve
  callers of the one harness process. Six is two per story and leaves each
  lead its own stream; helpers past it wait for a slot (the card says
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
delivery, and the worktree counted as written while the flow runs. Git runs
through main (`git` desktop service); gh runs in the host with the person's
own sign-in. A failed commit message agent leaves Blame's own message.
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
