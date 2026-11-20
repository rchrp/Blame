# The agent engine in the desktop app

How the app runs agents on `blame-engine` (`crates/`). Quick chats are the
first conversations on it, one-shot agents run as engine tasks (below);
development stories, the engine in the Lima/WSL VM and provider settings
follow the same contract. Until
they move, they still run on the Cline runtime (`cline-runtime.ts`).

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
  It imports nothing from Cline (`engine/no-cline.test.ts` walks its import
  graph), so it stays a small Node process.
- **Main** spawns the engine host, starts it again after a crash, routes
  renderer calls to it and its events back to the windows that follow a
  session. It serves the host the few desktop services a tool needs
  (`renderWebPage`) and the git of the git flows (`git`: on this machine,
  or in the runtime VM for its worktrees). It imports only types and a tiny protocol module from
  `@blame/agent-runtime/engine-protocol`: the main process stays light
  (`scripts/check-main-process-imports.mjs` still passes).
  On quit it asks the host to shut down: the engine ends running turns as
  interrupted, flushes its logs to the database, and exits. Agents stop with
  the app; if the host dies the engine's stdin closes and it exits too.
- **blame-engine** runs on the user's machine with its data directory at
  `<userData>/engine` (`sessions.db`, checkpoints). `engineBinaryPath()` in
  `packages/desktop/src/main/engine/engine-binary.ts` is the one place that finds the
  binary (`target/{release,debug}/blame-engine` in development,
  `BLAME_ENGINE_BIN` to override; packaging is a later slice). The harness
  runs inside the engine (`engine_tools: ["harness"]`, `--harness-command`
  pointing at `semantic-harness-runner.js --serve`, run by Electron as Node).

## IPC surface

Renderer → main → host, all `ipcRenderer.invoke("engine:call", method, input)`
(see `EngineHostMethods` in `engine/protocol.ts`):

| method | does |
| --- | --- |
| `connect({ api })` | The API connection (URL, user token) the host uses for credentials, logs, blobs and web search. Sent at start and on every sign-in or token change. |
| `createSession({ session, purpose, settings })` | `session/create` with a config the host builds from the purpose (`quick-chat`: system prompt, tools, harness options). The renderer never builds a `SessionConfig`. |
| `configure({ session, purpose, settings })` | Rebuilds the config from the settings and sets it only when it differs from the session's current one (`{ changed }`). |
| `send({ session, message, delivery, settings })` | Applies `settings` as `configure` does, uploads attachments as blobs, then `session/send`. `delivery: "turn"` while a turn runs queues it in the engine; `"steer"` joins the running turn. |
| `interrupt`, `compact`, `undoRewind({ session })` | The engine calls of the same name. |
| `rewind({ session, to, restoreWorkspace })` | `session/rewind`: undo a message and, when asked, its files. |
| `resolveApproval({ session, call, decision })` | Answers the pending `host/approval`. |
| `follow({ session, subscription })`, `unfollow({ subscription })` | Records and deltas of one session. The caller names the subscription, so main can follow again after a host restart. |
| `running()` | Sessions with a turn running now. |
| task calls (`generateTitle`…), `cancelTask({ session })`, `deleteSession({ session })` | See [Tasks](#tasks); declared in `engine/task-protocol.ts`. |

Host → renderer, on `engine:event`:

- `{ type: "follow", subscription, event }`: a `FollowEvent` of
  `@blame/engine-client` (`records`, `delta`, `attached`, `state`). A new
  subscriber first gets every record the host holds for the session, then
  live events: the renderer keeps nothing between loads.
- `{ type: "activity", session, running, outcome? }`: a turn started or ended,
  for the sidebar, the running count and the "response ready" notification.

## What renders a conversation

The renderer folds records and deltas with `TranscriptReducer`
(`@blame/engine-client/transcript`, no Node imports), live and after a
reload alike. `components/chat/engine/transcript-conversation.ts` maps a
`Transcript` to the shared `AgentConversationTimeline`; that mapping is the
only place that knows both shapes. Undo of a message is `rewind` to the
item's `rewind.to` with `restoreWorkspace` when it has a checkpoint.

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
- **The renderer** writes product state (create, rename, delete a chat) and
  nothing about runs: no run rows, no activities, no outboxes.

## Credentials

`host/credential { provider, session }` is answered from the user's provider
credentials in the API (`/providers/credentials/resolve`):

| engine id | app (API) id | answer |
| --- | --- | --- |
| `anthropic` | `anthropic` | `api_key` |
| `openai` | `openai-native` | `api_key` |
| `chatgpt` | `openai-codex` | `bearer` with the account id; refreshed with `blame-engine auth chatgpt refresh` and saved back to the API |
| `gemini` | `gemini` | `api_key` |
| `openrouter` | `openrouter` | `api_key` |
| `openai-compatible` | `openai` | `api_key` with its base URL |
| `claude-code` | `claude-code` | the shared Claude Code bridge: a key scoped to the session and the bridge URL |

Other app providers have no engine provider yet: such a model cannot start a
conversation on the engine.

## Tools

A client tool is a `ClientTool` (`engine/tool.ts`): name, description, JSON
Schema, effect, `endsTurn`, `needsApproval`, and `run(input, context)` with
the call's `signal` and `progress(text)`. A `ToolSet` turns tools into the
session's `client_tools` specs and serves `host/tool`; progress goes back to
the engine as `tool/progress` and reaches viewers as `tool_progress` deltas.
Engine tools (the harness) run inside the engine, next to the files.

## Approvals

`host/approval` waits in the host until `resolveApproval` answers it (a
decision that arrives first is kept for a minute). The pending call shows in
the transcript (`pendingApprovals`, a tool call in `awaiting_approval`).
No quick-chat tool needs approval, so the conversation view has no
Allow/Deny buttons yet: the first slice whose tools need approval adds them.

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

On the host's engine. A task that reads no file runs there even for a
project in the runtime VM (its folder is the temporary one). A task that
works on files of a project in the VM fails with `VM_WORKSPACE_UNSUPPORTED`
until the engine runs in the VM; there is no Cline fallback.

### Git flows

Approve & Merge, Open PR, the Git page's commit message and conflict
resolution run in the engine host (`engine/git/`), not in a renderer or the
Cline runtime: a flow is git work with agent steps in it, and each step is
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
| `resolveMergeConflicts`, and in `approveAndMerge` | `merge-conflict-resolution` | `submit_merge_resolution` (`resolved`, `reason`) | harness: `search_code`, `read_code`, `edit_code`, `run_task`; `required: ["read_code"]`; `VM_WORKSPACE_UNSUPPORTED` in the VM |

## Rules for the next slices

1. A conversation that moves to the engine loses its Cline path in the same
   change: runtime methods, IPC, renderer persistence, API tables and tests.
2. Purposes are built in the host (`engine/purposes/`), from settings the
   renderer sends. A new purpose adds a builder there, never a config in the
   renderer.
3. The renderer renders from records only. It persists no agent event.
4. Every engine call from the renderer goes through `platform.engine`; no
   other process holds an `EngineClient`.
