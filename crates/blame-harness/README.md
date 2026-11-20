# blame-harness

Blame's Light Semantic Harness in Rust: the tools a model uses to work on
code (`search_code`, `read_code`, then `edit_code`, `run_task`,
`finish_task`). It depends on no `blame-engine-*` crate, has no async
runtime, and ships as one binary that speaks the JSON-lines protocol of
`packages/agent-runtime/src/harness/semantic-harness-runner.ts --serve`, so
the engine (or any other agent) can run it in place of the TypeScript
harness.

This first part ports the foundations and the read side. Editing, `run_task`,
completion, the compiler tier and symbolic analysis answer that they are not
available yet; their seams are described below.

## Running it

```bash
cargo run --release -p blame-harness -- serve
```

```text
→ {"ready":true,"protocol":1}
← {"id":"1","describe":{}}
→ {"id":"1","tools":[{"name":"search_code","description":"…","inputSchema":{…},"effect":"read_only","endsTurn":false},…]}
← {"id":"2","request":{"tool":"search_code","workspaceRoot":"/repo","input":{"query":"parseCode"},"taskContract":{"session_id":"s1"}}}
→ {"id":"2","result":{"status":"ok","data":{…}}}
← {"id":"3","call":{"tool":"read_code","workspaceRoot":"/repo","input":{"target":"src/a.ts"},"toolContext":{"sessionId":"s1"}}}
→ {"id":"3","presented":{"ok":true,"content":"…what the model reads…"}}
← {"id":"3","cancel":true}
```

- `request` runs a workspace operation and answers its raw `LightToolResult`.
- `call` runs a model's tool call as the in-process tools do: lenient repair
  of JSON sent as strings, validation with zod's messages, secret redaction
  and the `blame_tool_result_v2` envelope.
- `describe` lists the five tools with the exact descriptions and JSON
  Schemas of the TypeScript harness (`schemas/*.json`).
- `cancel` aborts the request or call with that id. Closing stdin aborts
  everything in flight.

Without `serve`, one request is read from stdin and its result printed.

## Layers

| Module | Role | TypeScript source |
| --- | --- | --- |
| `files`, `pathx`, `identity` | Path safety, reads, git snapshots and source revisions (directory walk without git) | `workspace-files.ts`, `light-identity.ts` |
| `journal`, `coverage`, `attention`, `aliases` | Session state, journaled in the same file and format | `session-journal.ts`, `read-coverage.ts`, `light-attention.ts`, `light-aliases.ts` |
| `lock` | The workspace write lock, compatible with `proper-lockfile` | `light-commit.ts` |
| `syntax`, `languages` | Symbols, bodies, structural levels, syntax diagnostics, Vue/Svelte units, Python bodies | `code-intelligence.ts`, `component-symbols.ts`, `language-capabilities.ts`, `light-capabilities.ts` |
| `fold`, `navigation`, `read_results` | Folded views and their economics, edit targets, read result shapes | `light-fold-view.ts`, `light-fold-economics.ts`, `light-navigation.ts`, `light-read-results.ts` |
| `lexical`, `search_results`, `search` | ripgrep's engine in process, ranking, pages, scopes, symbol/reference/declaration discovery | `lexical-search.ts`, `light-search-results.ts`, `light-code-search.ts`, `light-reference-search.ts`, `light-reference-candidates.ts` |
| `workspace` | One session on one workspace: `read_code` routing, `search_code` | `light-workspace.ts`, `light-path-recovery.ts`, `light-images.ts` |
| `tools`, `validate`, `present` | The model-facing surface: definitions, validation, presentation | `light-tools.ts`, `light-contracts.ts`, `tool-result-envelope.ts`, `security-secret-redaction.ts` |
| `harness`, `server` | Workspace cache, request and call execution, the protocol | `light-executor.ts`, `engine-tools.ts`, `semantic-harness-runner.ts` |
| `compiler` | The port of the compiler tier (Node side process, later) | `semantic-reference-*.ts`, `import-index*.ts`, `dependency-declaration.ts` |

A standalone tool server (MCP or another agent's plugin format) needs
`tools::tool_definitions` and `harness::Harness::call`, nothing else.

## Fidelity

The text the model reads was tuned by experiments, so the port reproduces it
byte for byte, including JavaScript's semantics where they show:

- parsers: ast-grep-core 0.51.0 over the grammar versions the TypeScript
  harness loads (`@ast-grep/napi` 0.51.0 and the `@ast-grep/lang-*` packages);
- text search: `grep-searcher`/`grep-regex` configured as the ripgrep
  command line was, with its file order (named files in candidate order, a
  walk in directory order past 24,000 path characters) and binary handling;
- strings: UTF-16 lengths and slices, ECMAScript white space, ICU root
  collation for `localeCompare` (ASCII exactly; other characters by code
  point), `toFixed` rounding, `JSON.stringify` output and object key order
  (the crate's own ordered `json::Json`);
- zod 4.6 validation messages and union rules, checked against
  `tests/fixtures/input-validation.jsonl` (zod's own verdicts).

## Conformance

The TypeScript behavioural tests drive the binary through an adapter
(`packages/agent-runtime/src/harness/rust-harness-adapter.ts`, loaded by the
module hooks of `rust-harness-hooks.ts`):

```bash
pnpm --filter @blame/agent-runtime build
```

```bash
cargo build --release -p blame-harness
```

```bash
node crates/blame-harness/conformance/run.mjs --binary target/release/blame-harness
```

It runs every harness test file three ways: as is (TypeScript), with the
workspace in Rust, and in compare mode, where the tests read TypeScript
results while every `search_code`/`read_code` also runs in Rust on its own
session journal and is compared byte for byte.

## Seams for the next parts

- `edit_code`, `run_task`, `finish_task`: `tools::ToolDefinition::available`
  is false and `Harness::execute` answers that they are not available. The
  journal already replays `change`, `validation` and `terminal` events, and
  the lock refuses a read while `pending.json` waits for recovery.
- `@checks`: refused until validations are recorded by `run_task`.
- Compiler tier: `compiler::CompilerPort` (references, dependency
  declarations, the import index behind `links`). `NoCompiler` answers what
  the TypeScript harness answers when its worker cannot start
  (`worker_failed`), and reads carry no `links`.
- Symbolic analysis (`BLAME_AGENT_SYMBOLIC_ANALYSIS`): not ported; reads
  carry no `symbolicAnalysis` hints.
