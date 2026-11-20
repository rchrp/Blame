# blame-harness

Blame's Light Semantic Harness in Rust: the tools a model uses to work on
code (`search_code`, `read_code`, then `edit_code`, `run_task`,
`finish_task`). It depends on no `blame-engine-*` crate, has no async
runtime, and ships as one binary that speaks a JSON-lines protocol; the
engine runs it as its workspace harness (`blame-harness serve --asks`), and
any other agent can.

It is the only implementation: the TypeScript harness it was ported from is
gone, and the modules below name what each part was ported from. The tools
are the read side, `edit_code`, `run_task` (commands, project tasks, managed
runs, the dependency operation, deterministic Prettier edits, check
observation), `finish_task` and the opt-in symbolic analysis, with the
compiler tier in a Node side process. The TypeScript runner-only
`experimentalSearchExpansion` option was not ported (no production caller
set it).

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
- `cancel` aborts the request or call with that id. A command that became a
  managed run is still stopped by its call's cancel after the call
  answered; a cancelled `run_task` or `finish_task` answers with its own
  result (an interrupted check, a refused finish). Closing stdin aborts
  everything in flight.
- A request may carry `commandCredentials` (`{ githubToken?, githubCli? }`,
  set by the desktop for managed runtimes) and `workspaceOptions`
  (`{ initialCommandWaitMs }`, part of the workspace's identity).
- Internal requests serve the behavioural suite's test client:
  `task_runner` (the runner alone), `edit_service` (the edit service
  alone), `replace_files` (a formatter commit) and `unit` (one of the
  harness's functions on JSON arguments, `src/units.rs`).

Without `serve`, one request is read from stdin and its result printed.

### What run_task takes from the TypeScript package

- `BLAME_HARNESS_NODE_ASSETS`: the directory of `node-event-reporter.js`
  and `invocation-test-preload.js` (`packages/agent-runtime/dist/harness`),
  the Node test reporter and the Vitest preload hook added to owned test
  invocations; without it those invocations run without them.
- `BLAME_HARNESS_NODE_MODULES`: the node_modules holding the bundled
  package managers (`npm`, `pnpm`, `yarn`, `npm-legacy`, `pnpm-legacy`),
  after the provisioned roots and before PATH, as in TypeScript.
- `BLAME_HARNESS_RIPGREP_DIRECTORY`: the bundled `rg`, appended to the
  commands' PATH.

### The compiler side process

What must stay on the TypeScript compiler (references and renames,
dependency declarations, the import index behind `links`, TypeScript, JSONC
and Prisma content validation, the symbolic analysis's hints and its Z3
program) is answered by
`packages/agent-runtime/src/harness/rust-harness-compiler.ts`, a small Node
entry next to the modules it reuses unchanged. Give the harness its command:

```bash
blame-harness serve --compiler-command '["node","packages/agent-runtime/dist/harness/rust-harness-compiler.js"]'
```

(or `BLAME_HARNESS_COMPILER`). The harness starts it on the first query that
needs it. Inside it, one compiler worker per workspace root (at most three,
each stopped after 30 s idle, as in-process); the side process itself exits
after `BLAME_HARNESS_COMPILER_IDLE_MS` (60 s) without a query and is
started again when needed: a stopped worker's memory stays in its process
until the process exits. Without a command, or without Node, the compiler
tier is unavailable: references fall back to lexical search with
`worker_failed`, the declaration view is refused, reads carry no `links`,
and TypeScript/JSONC/Prisma edits are validated as unsupported.

## Layers

| Module | Role | Ported from (deleted TypeScript) |
| --- | --- | --- |
| `files`, `pathx`, `identity` | Path safety, reads, git snapshots and source revisions (directory walk without git) | `workspace-files.ts`, `light-identity.ts` |
| `journal`, `coverage`, `attention`, `aliases` | Session state, journaled in the same file and format | `session-journal.ts`, `read-coverage.ts`, `light-attention.ts`, `light-aliases.ts` |
| `lock` | The workspace write lock, compatible with `proper-lockfile` | `light-commit.ts` |
| `syntax`, `languages` | Symbols, bodies, structural levels, syntax diagnostics, Vue/Svelte units, Python bodies | `code-intelligence.ts`, `component-symbols.ts`, `language-capabilities.ts`, `light-capabilities.ts` |
| `fold`, `navigation`, `read_results` | Folded views and their economics, edit targets, read result shapes | `light-fold-view.ts`, `light-fold-economics.ts`, `light-navigation.ts`, `light-read-results.ts` |
| `lexical`, `search_results`, `search` | ripgrep's engine in process, ranking, pages, scopes, symbol/reference/declaration discovery | `lexical-search.ts`, `light-search-results.ts`, `light-code-search.ts`, `light-reference-search.ts`, `light-reference-candidates.ts` |
| `workspace` | One session on one workspace: `read_code` routing, `search_code`, `edit_code`, what run_task adds (coverage, failure snippets, validation state, repair plan), `analyze` | `light-workspace.ts`, `light-path-recovery.ts`, `light-images.ts`, `light-symbolic-analysis.ts` |
| `turn` | One session's operations take turns; a managed run refuses edits and lets reads through | `light-commit.ts` (SessionTurn) |
| `run::*` | run_task: shell words and policy, task catalog, process and environment, command changes, failure assessment, check observation and test reports, managed reports, formatter, dependency operation, shell inspection, the runner | `light-task-runner.ts` and the modules it imports |
| `checks`, `finish` | `@checks`, the validation state after edits, the repair plan; finish_task's completion decision and memory candidate | `light-validation-report.ts`, `light-check-repair.ts`, `light-finish-service.ts`, `light-completion.ts`, `project-memory.ts` |
| `edit`, `patch`, `cline_patch`, `diff`, `symbol_edit`, `commit`, `validation` | edit_code: planning, Cline patches (its parser ported), jsdiff's line diff, symbol replacements, atomic commit with `pending.json` recovery, final content validation | `light-edit.ts`, `light-patch.ts`, `@cline/core` apply-patch, `diff` 9, `light-symbol-replacement.ts`, `python-body.ts`, `patch-symbol-attribution.ts`, `light-commit.ts`, `content-validation.ts` |
| `tools`, `validate`, `present` | The model-facing surface: definitions, validation, presentation | `light-tools.ts`, `light-contracts.ts`, `tool-result-envelope.ts`, `security-secret-redaction.ts` |
| `harness`, `server` | Workspace cache, request and call execution, the protocol | `light-executor.ts`, `engine-tools.ts`, `semantic-harness-runner.ts` (its serve mode) |
| `compiler` | The compiler tier's port and its Node side process client | `semantic-reference-*.ts`, `import-index*.ts`, `dependency-declaration.ts` |

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

## Behavioural suite

`packages/agent-runtime/src/harness/*.test.ts` are the harness's tests. They
drive the binary through a thin test client
(`packages/agent-runtime/src/harness/test-client/`): its tools by `call`,
its workspace operations by `request`, and the few functions some tests call
directly by the `unit` request. There is no TypeScript implementation behind
it. The binary is `BLAME_HARNESS_BIN`, else this checkout's debug build.

```bash
cargo build -p blame-harness
```

```bash
pnpm --filter @blame/agent-runtime test
```

`conformance/run.mjs --binary target/release/blame-harness` runs the same
files one by one against another build and prints each file's counts.
