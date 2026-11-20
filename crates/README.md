# Blame agent engine

The engine runs Blame's coding agents. It is one headless Rust binary that
runs next to the workspace it works on: on the user's machine, inside the
runtime VM (Lima, WSL), or in the cloud. Clients (the desktop app, later a
phone through Blame's cloud) drive it over one protocol and hold no state the
engine cannot rebuild.

## Crates

| Crate | Role | Depends on |
| --- | --- | --- |
| `blame-engine-protocol` | Data only: session records, live deltas, the JSON-RPC client protocol | serde |
| `blame-engine-core` | The agent loop and its ports (traits). No I/O | protocol |
| `blame-engine-store` | `SessionStore` on embedded SQLite, replication to Blame's database | core |
| `blame-engine-providers` | `ModelProvider` for each model provider | core |
| `blame-engine-checkpoint` | `Checkpointer` on git trees | core |
| `blame-engine` | The binary: wiring, transports, tool hosts | all |
| `blame-stdio` | Keeps a process's own standard streams out of the processes it starts on Windows. The workspace's only unsafe code: one call, first thing in each binary's `main` | windows-sys |

The harness will be its own crate, with no dependency on the engine, so it can
also ship as a standalone tool server.

## Rules every crate keeps

1. **The log is the session.** A session is its ordered list of `Record`s.
   The model's history, the UI transcript and crash recovery are all computed
   from it. Nothing that matters lives only in memory.
2. **Store, then act.** A record is on disk before the engine acts on it or
   shows it. After a crash the log says exactly how far each step got.
3. **Append only.** Records are never edited or deleted. A rewind is a record.
4. **Same records, same bytes.** The context sent to a model is a pure
   function of the records, so a restarted engine keeps the provider's prompt
   cache.
5. **The engine runs where the files are.** Tools run in the engine's process
   or beside it; the client is only asked for what only it has (its own
   tools, the user's approval, credentials).
6. **No third-party type crosses a crate's public API**, reaches a stored
   record or the wire. Provider items are stored as the provider's own JSON.
7. **Light.** A dependency has to earn its place; an idle session costs
   almost nothing because it can be dropped and rebuilt from its log.

## The model catalog

The providers and models the engine offers come from models.dev
(`https://models.dev/api.json`), fetched by the engine at run time: a model
published there is offered without a Blame release, to every client through
`catalog/list` (and `blame-engine catalog`). The details, and which models.dev
provider feeds which engine provider, are in
`blame-engine-providers/src/catalog/`.

- The engine keeps the last copy in `<data-dir>/catalog/` and revalidates it
  with a conditional request on start, when a client lists a copy older than
  15 minutes, and when a client asks (`refresh: true`, at most every 30 s).
  A turn never waits for it; a failed refresh keeps the last copy.
- A snapshot is compiled in for the first start and offline use
  (`blame-engine-providers/catalog/`). The build never reaches the network;
  refresh the snapshot with:

```bash
scripts/refresh-model-catalog.sh
```

## Working on it

```bash
cargo test --workspace
```

```bash
cargo clippy --workspace --all-targets -- -D warnings
```

```bash
cargo fmt --all --check
```
