# Invocation-bound validation observations

Light separates process termination, reported test cases, admitted source verification and user acceptance. A successful shell exit does not establish that its subprocess tests passed.

For a catalogued Node/Vitest test task without another managed reporter, Light adds an invocation-local Node preload through the child environment. It observes the actual Vitest CLI, including a Node wrapper or the npm `vitest` executable symlink. Only the installed Vitest 3.2.4 CLI in explicit `run` mode is supported. The hook adds default and JSON reporters without changing file selection or editing the wrapper. Existing custom reporter/output options and explicit watch/browser/typecheck modes execute unchanged and remain outside this adapter.

Each invocation gets a fresh ignored `.blame/harness/test-results` directory. A complete start/end pair, runner identity, original argv hash, cwd, child exit, report hash and reporter-hook hash bind the report to that execution. Reported test files carry source hashes before and after the command. The parent command, source revisions and manifest/lock identities remain recorded. Reports, processes and returned file lists have explicit bounds; partial, absent, malformed or unsupported observations remain unknown. Installed dependencies and the complete environment are not attested by manifest hashes.

An actual failed case remains failed even when the wrapper exits zero. Collection/setup failure in a reported file also remains failed. Zero selected files remains unknown, with zero reported cases; it is neither a passed check nor an inferred code defect. Source mutation marks the invocation stale, and the file hashes expose that mismatch.

Counts follow the runner and may include repeated subprocess invocations. Vitest JSON can include configured typecheck cases: the adapter does not establish runtime-versus-typecheck mode from JSON, delivered-file typecheck membership, dependency coverage or full-project acceptance. Source verification stays unadmitted. The journal view `read_code @checks` exposes current-source observations; it launches no commands. A TypeScript compiler check of delivered tests is still separate.

Reproduction controls and adverse prototype findings are in `docs/experiments/light-harness-followup-f51-2026-10-18`. Configure `BLAME_TEST_VITEST_DEPENDENCIES` to an isolated dependency directory with Vitest 3.2.4 to run the optional real-runner integration tests. Ordinary unit controls need no Vitest installation.
