# Cline core

`patches/@cline__core@0.2.0.patch` is kept only while the TypeScript harness
imports `@cline/sdk` (`createTool`, `computePatchChanges`), which loads
`@cline/core`. The workspace overrides core's simple-git 3.36.0, which has
unsafe-option guard bypasses fixed only in 4.0.1, with simple-git 4
(`pnpm-workspace.yaml`); the patch replaces core's default import, removed in
simple-git 4, with the named `simpleGit` export, so core still loads. Its other
changes served Cline sessions, which Blame no longer runs. Delete the patch,
the override and the `@cline/*` entries of `minimumReleaseAgeExclude` with the
TypeScript harness.

# Electron Builder macOS signing

The temporary keychain password fix is included upstream in electron-builder 26.18.0, so the former `app-builder-lib@26.8.1` backport is no longer needed. `node --test scripts/macos-signing.test.mjs` still exercises the installed implementation with distinct certificate and keychain passwords.
