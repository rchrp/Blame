# F37: read-only installed declarations

This is a completed local mechanism cycle, not a model-task success or token-efficiency campaign. The protocol was committed as `9977de17` before implementation. Production reference: `8ceb9139`. F35/F36 artifacts and accounting remain unchanged.

The current defect is observable in F31's `2-fast-glob-dynamic-filter-baseline` zero-based tool indices22–24 and candidate indices24–25: dependency declaration navigation is refused, followed by shell discovery. F31's original [tool ledger](https://github.com/rchrp/blame-research/blob/f910066559be27eb6202062c65a88cc344abff11/experiments/light-harness-edit-boundaries-f31-2026-10-16/tool-ledger.json) is authoritative. The previous `LightWorkspace.readPath` applies the mutation-path exclusion to navigation too. Current compiler references/rename already resolve configured identity; this change extends that worker rather than adding a second index.

## Implemented behavior

Use `read_code` with `view: "declaration"` and a local `file.ts#importBinding`, optionally followed by a namespace/export/member selector. Named/default/require imports and local re-exports follow compiler identity. Namespace reads list bounded exports. Symbol reads return overload/merged declarations, package/version and source/package hashes, plus compiler project scope/warnings. Continuation retains the same local target and uses the returned byte offset. It describes the installed types, not runtime callback semantics.

No new primitive, writable alias, edit coverage, rename authority or validation admission is created. Ordinary node_modules navigation and edits remain refused. A missing config, unavailable types, ambiguous import or unsupported/local augmentation fails explicitly. Limits: existing 8s/512MB compiler worker, 2,000 roots, 6,000 observed files/64MiB; at most 16 declarations/256,000 projected bytes, 12,000 UTF-8 content bytes per page, and 64 exports/2,048 name bytes. Package identity, canonical installation ownership and protected subpaths are checked; pnpm/shared node_modules layouts work. Freshness includes content, negative lookups and realpath bindings, so retargeting a package cannot validate the old canonical file.

The read schema and its tool description intentionally change to expose this feature; system/task prompts do not change. SDK JSON serialization of the four workspace tool definitions adds516 bytes entirely in `read_code`; the other three definitions are byte-identical. This is fixed context overhead even when declaration view is unused, not billed tokens or measured provider wire/cache behavior (`schema-overhead.json`). `finish_task` is supplied separately and unchanged.

## Measurements and adverse results

The known fast-glob revision `48687898` has 79 configured roots and 221 loaded files under TypeScript5.9.3. Six lookup cases were fixed before replay, repeated three times with rotating arm order and fresh sources/sessions. Both arms received identical declaration requests. The archived reference predates support for this view and refuses them. Independent hash/package checks confirm the candidate's identity rather than relying on its success label.

| Local result | Reference | Declaration view |
|---|---:|---:|
| Correct declaration lookups | 0/18 | 18/18 |
| Serialized response bytes | 4,023 | 22,434 |
| Total lookup duration | 1.049s | 16.867s |

These are six known diagnostic lookups with dependent repeats, not18 independent tasks. The reference returns short refusals, so this is not a comparison at equal delivered quality. Compiler startup and fuller answers cost time/bytes. Terminal fallback, billing, model cache and coding-task success were not measured. JavaScript implementation inspection remains necessary for runtime behavior. No model requests or new SDK costs occurred; cumulative observed estimates USD4.68580432 + USD1.94 retained reserves = USD6.62580432.

The first local panel passed12/15, with three test-fixture errors: an ESM default tested against CommonJS declaration identity; a JS file excluded by its same-basename TS source; an existing policy refusal returned `failed` rather than the asserted `blocked`. Corrected fixtures passed15/15. Added controls cover interface members, metadata symlink escapes, declaration-count/read budgets. Final targeted suites pass52/52, including16 new cases. Original first/second/final logs are retained. Build and lint pass; the full registered suite has893 cases,891 passes, two existing skips and zero failures. Results are recorded in `validation.json`. The native editor successfully compiled the saved LaTeX source; `latex-validation.json` binds that result to its source hash. Publication checking initially rejected an absent message serialized as JSON null; normalizing only that absence fixes the witness check without altering evidence.

## Reproduction and decision

Build the installed workspace with `node packages/agent-runtime/node_modules/typescript/bin/tsc -p packages/agent-runtime`. Run `node --test packages/agent-runtime/dist/harness/light-dependency-read.test.js`. The registered package test command includes these controls. Reproduce the no-model comparison with:

```sh
node tools/terminal_bench/dependency-declaration-study/replay.mjs --output=/tmp/f37-replay.json
node tools/terminal_bench/dependency-declaration-study/verify-public.mjs
```

The replay uses F31's public upstream source archive, the SHA-bound reference runtime and candidate overlay archives here, and installed upstream node_modules (override `--dependencies=/absolute/node_modules` on another host). Candidate defaults to the frozen production overlay from `464f2e04`; `--candidate=/absolute/light-workspace.js` is an explicit custom-runtime override. Both archived arms resolve the same installed runtime dependencies; this is not a standalone offline installation. No dependencies are downloaded by the replay. `replay-primary.json` retains the first comparison; `replay-packaged.json` separately records the frozen-package reproduction. The verifier checks recorded bytes/identities/arithmetic, not model behavior; its three coherent-corruption controls preserve that distinction.

**Decision: retain the explicit read-only capability; investigate model-level utility.** The boundary/identity mechanism is locally verified, while global efficiency and success gains remain unproven. The next cycle must freeze new, unhinted cross-file tasks on a larger project and compare Light reference, declaration-Light and integrated Cline with identical effective caps/model/budgets. Do not bundle startup caching, patch recovery or accounting changes into that comparison. This phase has not registered or executed that model panel. Research has remaining concrete work; completing a local cycle does not establish an absence of further improvement.
