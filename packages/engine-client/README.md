# @blame/engine-client

The TypeScript side of the Blame agent engine protocol (`crates/`, see
`crates/README.md`). Plain Node, no Electron import: it runs in the desktop's
utility process and in tests.

| Part                        | What it is                                                                   |
| --------------------------- | ---------------------------------------------------------------------------- |
| `src/generated/protocol.ts` | Every wire type, **generated from Rust**. Never edit.                        |
| `EngineClient`              | One connection: handshake, typed requests, cancellation, host requests, exit |
| `EngineSupervisor`          | Keeps one engine running; starts a new one on the next use after a crash     |
| `followSession`             | One session's records, exactly once and in order, across restarts            |
| `TranscriptReducer`         | Records (and live deltas) to what the UI renders; incremental, rewind-aware  |
| `localEngine` etc.          | Commands for a local binary, `limactl shell` and `wsl.exe`                   |

## Generated types

`ts-rs` derives sit behind the `ts` feature of `blame-engine-protocol`, so the
engine's own build carries no generator.

```bash
pnpm --filter @blame/engine-client generate
```

```bash
pnpm --filter @blame/engine-client check:generated
```

`cargo test --workspace --all-features` also fails when the committed file is
stale (`crates/blame-engine-protocol/tests/typescript.rs`). Only the JSON-RPC
envelope and the result of each method (`ClientResults`, `HostResults` in
`src/protocol.ts`) are written by hand; the build fails when a method exists in
Rust and is missing there. `Record` is exported as `SessionRecord`, since
`Record` is a TypeScript built-in. 64-bit integers are `number`.

## Using it

```ts
const engine = new EngineSupervisor(() =>
  EngineClient.start(localEngine(binary, { dataDir }), {
    clientName: "blame-desktop",
    clientVersion: app.getVersion(),
    handlers, // see below
    onLog: ({ source, text }) => log.debug(source, text),
  }),
);

const reducer = new TranscriptReducer();
const follower = followSession({
  source: engine,
  session,
  onEvent: (event) => {
    applyFollowEvent(reducer, event);
    render(reducer.snapshot());
  },
});

const client = await engine.client();
await client.sendMessage({
  session,
  input: [{ type: "text", text }],
  delivery: "turn",
});
```

### EngineClient

- `EngineClient.start(command, options)` spawns the engine and completes the
  handshake; `EngineClient.connect(transportFactory, options)` does the same
  over any `Transport` (a WebSocket later). It resolves only after `initialize`
  answered with the protocol version this client speaks
  (`EngineProtocolVersionError` otherwise).
- One method per `ClientRequest`: `createSession`, `openSession`, `listSessions`,
  `readRecords`, `subscribe`, `unsubscribe`, `sendMessage`, `interrupt`,
  `rewind`, `undoRewind`, `fork`, `compact`, `configure`, `closeSession`,
  `putBlob`, `shutdown`. Each takes `{ signal?, timeoutMs? }`: aborting sends `$/cancel`
  and rejects at once.
- `onNotification(listener)` receives `session/record` and `session/delta` for
  every subscribed session. Most callers use `followSession` instead.
- `closed` resolves (never rejects) with an `EngineExit` when the connection
  ends. Pending requests reject with `EngineExitedError`, which carries the
  last stderr lines. `shutdown()` asks politely, closes stdin, then SIGTERM,
  then SIGKILL, and resolves with the exit.
- stderr of the engine reaches `onLog` line by line.
- **No process outlives the client.** The engine exits when its stdin closes,
  which the OS does when the parent dies, even by SIGKILL; and a `process.on("exit")`
  hook kills any engine still running if the parent exits without shutting it down.

### Handlers (what the desktop must provide)

`options.handlers` answers what only the client has. Each receives
`(params, { signal, id })`; `signal` aborts when the engine sends `$/cancel`
(no answer is sent for a withdrawn request).

| Handler                                      | Engine request                                            |
| -------------------------------------------- | --------------------------------------------------------- |
| `tool`                                       | `host/tool`: run one of the session's `client_tools`; its context's `progress(text)` sends `tool/progress` |
| `approval`                                   | `host/approval`: ask the user, answer `approved`/`denied` |
| `credential`                                 | `host/credential`: `api_key`, `bearer` or `missing`       |
| `logPush`, `logPull`, `blobPush`, `blobPull` | `host/log/*`, `host/blob/*` (all four or none)            |

Supplying all four log handlers sets `remote_log` in `initialize`. A method
without a handler is answered "method not found". A thrown error is answered as
an internal error with its message.

### Choosing the command

`localEngine(binary, { dataDir })`, `limaEngine({ instance, binary, serve })`
(`limactl shell <instance> -- <binary> serve …`) and `wslEngine({ distro,
binary, serve })` (`wsl.exe -d <distro> -u root --exec <binary> serve …`). They
only build `{ command, args, env }`; the desktop owns where the binary and the
data directory live. The engine must see its data directory at the same path
every time, since a restart reopens sessions from it.

### Following a session

`followSession({ source, session, after?, onEvent })` delivers:

- `records`: new records, each seq once and in order, however the engine pushes
  them (backlog before or after the answer, duplicated, with a gap: it reads
  what is missing);
- `delta`: live deltas, which may be lost across a drop;
- `attached`: on every (re)subscription, with `activity` and the `in_flight`
  deltas: a view drops its live state and starts from these;
- `state`: `connecting`, `live`, `reconnecting`, `stopped` (with the error when
  it gave up: the engine refused, or `maxAttempts` failures in a row).

It resubscribes after the last seq it holds whenever the client ends, asking
its `ClientSource` (an `EngineSupervisor`) for the next one. After a turn goes
idle it re-reads the tail, since a lost last record reveals itself to nothing
else.

### Transcript

`TranscriptReducer.applyRecord / applyDelta / snapshot()`, or the pure
`reduceTranscript(records, deltas?)`. `snapshot()` returns immutable data with
structural sharing: an item no record touched keeps its identity, and deltas
never copy the stored part. See `src/transcript/model.ts` for the shape:
`items` (user messages, text, reasoning, tool calls with state and result,
failed requests, turn ends, compactions, notices, model changes, rewind cuts),
`turns`, `pendingApprovals`, `checkpoints` (`to` to pass to `session/rewind`),
`usage.total` / `usage.spent`, `live`, `activity`.

Which records are in effect follows `effective()` in
`blame-engine-core/src/projection.rs`; `src/transcript/oracle.ts` is a port of
it that the tests compare against on random logs with rewinds and undos.

## Tests

```bash
pnpm --filter @blame/engine-client test
```

Most tests run against `test/fake-engine.mjs`, a small script that speaks the
protocol. `src/real-engine.test.ts` runs against the real binary when
`target/debug/blame-engine` exists (or `BLAME_ENGINE_BIN` points at one) and is
skipped otherwise.
