# Cline core

`scripts/patch-cline-core.mjs` generates the `@cline/core` patch from the pristine npm package. The SDK ships minified bundles, so each change is located by structure, not by minified names, and the script refuses to write anything when an anchor no longer matches exactly. The weekly Cline SDK update regenerates the patch automatically. To do it by hand for a version:

```bash
pnpm patch @cline/core@<version> --edit-dir /tmp/cline-core
node scripts/patch-cline-core.mjs /tmp/cline-core
pnpm patch-commit /tmp/cline-core
```

Then delete the previous `patches/@cline__core@*.patch`. Do not edit pnpm's installed dependency directories by hand.

The patch makes four changes:

- **Image budget.** Cline estimates each image at a flat 1,600 tokens. An optional `compaction.imageTokenLimit` replaces that constant, for both the compaction trigger and retained-message selection, and survives the session config sent to a hub. Blame sets it to the conservative documented 36,000 tokens only for GPT-5.6 image-capable provider/model combinations (`packages/agent-runtime/src/image-compaction.ts`). Canonical messages and image pixels are unchanged. `packages/agent-runtime/src/image-compaction.test.ts` exercises the real SDK API.
- **Planned sessions without replay.** `subscribe(…, { replay: false })` starts a new execution without replaying the events of a previous subscription; reconnects still replay missed events. Planned sessions use it, so resuming story feedback never receives the previous execution's terminal event (`cline-session-replay.test.ts`).
- **Hub identity.** The bundles carry a distinct, newer hub build identity, so an unpatched managed hub of the same version is never reused.
- **simple-git 4.** Cline pins simple-git 3.36.0, which has unsafe-option guard bypasses fixed only in 4.0.1. The workspace overrides it (`pnpm-workspace.yaml`) and the patch replaces the default import, removed in simple-git 4, with the named `simpleGit` export in the four bundles. It also bumps core's own `simple-git` dependency, since the runtime payload installs from that manifest. Cline only calls `getRemotes(true)` and `branch()`, which work unchanged under the new environment guard. Drop the change and the override once Cline imports simple-git 4 itself. The bundled copy in `dist/plugin-runtime` inlines simple-git 3.36.0 and cannot be fixed here.

The generator also adds `dist/blame-patch.json`, listing the applied changes. The runtime payload build and the runtime health checks (`scripts/runtime-sdk-check.mjs` and the provisioning scripts in `packages/desktop/resources/runtime`) require it, so a pristine core is never shipped or kept.

# Electron Builder macOS signing

The temporary keychain password fix is included upstream in electron-builder 26.18.0, so the former `app-builder-lib@26.8.1` backport is no longer needed. `node --test scripts/macos-signing.test.mjs` still exercises the installed implementation with distinct certificate and keychain passwords.
