# The agent engine in the desktop app

How the app runs agents on `blame-engine` (`crates/`). Quick chats are the
first conversations on it; development stories, one-shot agents, the engine
in the Lima/WSL VM and provider settings follow the same contract. Until
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
  (`renderWebPage`). It imports only types and a tiny protocol module from
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
  last activity. Deleting a chat deletes its engine session log.
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

## Rules for the next slices

1. A conversation that moves to the engine loses its Cline path in the same
   change: runtime methods, IPC, renderer persistence, API tables and tests.
2. Purposes are built in the host (`engine/purposes/`), from settings the
   renderer sends. A new purpose adds a builder there, never a config in the
   renderer.
3. The renderer renders from records only. It persists no agent event.
4. Every engine call from the renderer goes through `platform.engine`; no
   other process holds an `EngineClient`.
