# Cline core

`scripts/patch-cline-core.mjs` generates the `@cline/core` patch from the pristine npm package. The SDK ships minified bundles, so each change is located by structure, not by minified names, and the script refuses to write anything when an anchor no longer matches exactly. The weekly Cline SDK update regenerates the patch automatically. To do it by hand for a version:

```bash
pnpm patch @cline/core@<version> --edit-dir /tmp/cline-core
node scripts/patch-cline-core.mjs /tmp/cline-core
pnpm patch-commit /tmp/cline-core
```

Then delete the previous `patches/@cline__core@*.patch`. Do not edit pnpm's installed dependency directories by hand.

The patch makes three changes:

- **Image budget.** Cline estimates each image at a flat 1,600 tokens. An optional `compaction.imageTokenLimit` replaces that constant, for both the compaction trigger and retained-message selection, and survives the session config sent to a hub. Blame sets it to the conservative documented 36,000 tokens only for GPT-5.6 image-capable provider/model combinations (`packages/agent-runtime/src/image-compaction.ts`). Canonical messages and image pixels are unchanged. `packages/agent-runtime/src/image-compaction.test.ts` exercises the real SDK API.
- **Planned sessions without replay.** `subscribe(…, { replay: false })` starts a new execution without replaying the events of a previous subscription; reconnects still replay missed events. Planned sessions use it, so resuming story feedback never receives the previous execution's terminal event (`cline-session-replay.test.ts`).
- **Hub identity.** The bundles carry a distinct, newer hub build identity, so an unpatched managed hub of the same version is never reused.

# Electron Builder macOS signing

The `app-builder-lib@26.8.1` patch backports electron-userland/electron-builder#10172. It passes the temporary keychain password to `security set-key-partition-list`, while preserving the certificate password for `security import`. Recent macOS runners reject the certificate password when unlocking the keychain. `node --test scripts/macos-signing.test.mjs` exercises the installed implementation with distinct certificate and keychain passwords. Remove this patch when upgrading to an upstream version containing that fix.
