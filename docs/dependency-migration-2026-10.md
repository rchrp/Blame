# October 2026 dependency migration

This migration targets desktop runtime **v13**, keeping Cline at **0.2.0** and
the runtime agent protocol at **10**. Runtime v12 remains available for existing
desktop releases.

## Compatibility decisions

- **Node 24.22.1 and pnpm 12.15.0:** repository commands require Node >=24.15.
  pnpm 12 uses a native executable. The harness resolves the installed binary
  directly, without downloading a package manager while executing a task.
  Bundled and provisioned pnpm 10.33.2 and npm 11.6.4 remain available for existing
  project pins, including Blame's current project templates.
  The workspace retains pnpm's release-age policy with exact exceptions for the
  reviewed package versions in this update.
- **TypeScript 7.0.2:** the native compiler runs builds and checks through the
  `@typescript/native` alias. The JavaScript compiler API remains available as
  `typescript` through the official `@typescript/typescript6` compatibility
  package. Semantic navigation and packaged default libraries use that API.
- **Electron 45 and Vite 8:** macOS now requires version 13 or later. Screenshot
  copying uses the asynchronous clipboard API. Sandboxed preloads only import
  Electron. Vite configuration uses Rolldown and Oxc. The obsolete electron-builder
  signing patch is removed because the updated builder includes the fix.
- **Stripe 23:** both billing clients explicitly request API
  `2026-09-30.endive`. Checkout keeps classic subscription billing, preserving
  the previous billing behavior. Unknown Checkout statuses cannot reuse an old
  session. Signed webhook handling remains compatible with existing endpoint
  versions; this change does not change the Stripe account or webhook settings.
- **OpenTelemetry 2.12 / 0.223:** the SDK and instrumentations advance together.
  SDK 3 is deferred because Cline and Langfuse still require SDK 2 and API 1.9.
  A local collector test exercises actual trace, log and metric exports and
  checks that sensitive attributes are removed.
- **ESLint:** packages with compatible plugins use version 10. The Next.js site
  stays on the latest version 9 because its React, import and accessibility
  plugins declare support through version 9.

Frontend dependencies include Shiki 4, Mermaid 12, Motion 14 and Three 0.186.
Vercel Sandbox 3 keeps the explicit image/snapshot selection used by Blame.
Unused electron-store and React Table dependencies are removed.

## Runtime images

The macOS and Windows manifests pin Node 24.22.1, Docker 29.9.2, Compose 5.6.1
and Buildx 0.38.1. macOS bundles Lima 2.2.1. Download checksums are pinned for
both architectures. Images contain npm 12.2.1, npm 11.6.4, pnpm 12.15.0, pnpm 10.33.2 and
Yarn 1.22.22. Their health checks verify both npm and pnpm generations.

After CI passes and the PR is merged, the `runtime-v13` tag builds and verifies
the four runtime images before the publication job runs. Publication must be
checked through `https://download.blame.so/runtime/v13/manifest.json` and all
four artifact URLs. Desktop installers have their own release process in
[RELEASING.md](../RELEASING.md).

## Validation

CI covers type checking, agent and desktop tests, Windows subprocess and package
manager regressions, runtime payload installation, and release scripts. API unit,
authentication and consumer contract tests run against an isolated MySQL service.
The bounded test concurrency prevents compiler-heavy harness suites from
exhausting the test runner. Local Electron smoke tests exercise the agent process,
document attachments, DevTools sessions and web research cleanup.
