# blame-engine

The engine binary. It runs sessions next to their workspace and serves the
client protocol of `blame-engine-protocol` (`src/rpc.rs`): JSON-RPC 2.0, one
message per line.

## Commands

```bash
blame-engine serve --data-dir DIR [--harness-command CMD] [--idle-timeout SECONDS] [--durability full|os-crash|relaxed]
```

```bash
blame-engine auth chatgpt login [--device] [--auth-base URL]
```

```bash
blame-engine auth chatgpt refresh [--auth-base URL]
```

```bash
blame-engine catalog
```

```bash
blame-engine --version
```

- `serve` speaks the protocol on stdin/stdout. Logs go to stderr only
  (`BLAME_ENGINE_LOG=error|warn|info|debug`, `info` by default).
- `--data-dir` holds `sessions.db` (the logs; keep it on a disk local to the
  engine, never on a virtiofs/9p/SMB mount: SQLite's WAL needs shared memory)
  and `checkpoints/` (git directories for workspaces that are not
  repositories). One engine per data directory.
- `--harness-command` starts Blame's workspace harness (`blame-harness`),
  either a JSON array (`["/path/blame-harness", "serve", "--asks"]`) or a
  single program path. It is started on first use, kept alive, started again
  if it dies and stopped with the engine.
- `--idle-timeout` (600 by default): a session with no running turn and no
  subscriber is dropped from memory after this long, and opened again from
  its log when used.
- `auth chatgpt login` prints JSON lines on stdout: first
  `{"authorize_url": …}` (open it in the browser) or, with `--device` or when
  the callback ports are taken, `{"verification_uri": …, "user_code": …}`;
  the last line is the tokens (`access_token`, `refresh_token`, `id_token`,
  `account_id`, `expires_at_s`). `refresh` reads the refresh token from stdin
  and prints the new tokens. Nothing is stored: the app keeps them and hands
  the access token to engines through `host/credential` as
  `{"type": "bearer", "token": …, "account": <account_id>}`.
- `catalog` prints the providers and models as JSON.

## Driving `serve`

1. Send `initialize` first and wait for its answer: nothing else is read
   until the store is open. Set `remote_log: true` when the client answers
   `host/log/*` and `host/blob/*` (sessions are then copied to Blame's
   database and can be opened on an engine that never saw them).
2. `session/create` or `session/open`, then `session/subscribe` with the last
   seq the client has: the answer comes first, then every record after that
   seq, then live records and deltas.
3. Answer the engine's requests: `host/credential` (kept in memory only,
   one per provider, per session for `claude-code`; asked again once when
   the provider refuses it), `host/tool` for the session's `client_tools`
   (report progress meanwhile with the `tool/progress` notification),
   `host/approval`, and the log requests. The engine withdraws a request it
   no longer needs with `$/cancel`. Attachments go in with `blob/put`, whose
   `BlobRef` a message's image or document block then carries.
4. Stop with `shutdown` (answered once running turns ended as interrupted
   and the last records reached the client), or by closing stdin. SIGTERM,
   SIGINT and SIGHUP stop it the same way.

Client requests run to completion: `$/cancel` from the client is ignored.

## The harness

A session gets the harness tools when `engine_tools` contains `"harness"`.
Its settings go in `tool_options.harness`:

```json
{ "taskContract": { "objective": "…", "required_checks": [], "environment": { "isolated": true, "managedPreview": true } },
  "responseStyle": "balanced" }
```

`taskContract.session_id` defaults to the session id. The tools, their
descriptions and schemas come from the harness itself (`describe`), and their
results are presented as the harness presents them (`call`, see
`crates/blame-harness/README.md`). What only the client knows (command
credentials, the preview's dependency refresh) the harness asks for, and the
engine relays the question to the client (`host/harness`).

## Helper agents

A session whose `engine_tools` contains `"subagents"` is offered `run_agents`
(`src/subagents/`): read-only helpers run as tasks of the engine while a
message of the turn carries `UserBlock::Ultra`. See "Ultra mode" in
`docs/engine-in-the-app.md`.

## Tests

The tests in `tests/` spawn the built binary and speak the protocol to it,
with the mock model server of `blame-engine-providers` (feature `testing`).
`tests/harness.rs` uses `node` with a fake runner, and the real runner when
`packages/agent-runtime/dist` is built (`pnpm --filter @blame/agent-runtime build`).
