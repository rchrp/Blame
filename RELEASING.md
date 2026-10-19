# Releasing

Everything is built on GitHub-hosted runners and published as a GitHub Release. A release starts when you push a tag.

| Workflow                                                   | Trigger                         | Result                                                                   |
| ---------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------ |
| [CI](.github/workflows/ci.yml)                             | Pull requests, pushes to `main` | Line budgets, typecheck, and tests                                       |
| [Release desktop](.github/workflows/release-desktop.yml)   | Tag `v<semver>`                 | **Draft** release with the installers, update metadata, and `SHA256SUMS` |
| [Release runtime](.github/workflows/release-runtime.yml)   | Tag `runtime-v<version>`        | Published release with the four runtime images and their `manifest.json` |
| [Update Cline SDK](.github/workflows/cline-sdk-update.yml) | Every Monday, or manually       | Pull request updating every `@cline/*` package and the runtime version   |

Users never download from GitHub URLs directly. [`download.blame.so`](deploy/downloads) is a stable redirector, so you can change the hosting later without breaking installed apps:

| Public URL                                         | Redirects to                                                            |
| -------------------------------------------------- | ----------------------------------------------------------------------- |
| `download.blame.so/latest/<file>`                  | The latest published desktop release, `releases/latest/download/<file>` |
| `download.blame.so/runtime/v<N>/[platform/]<file>` | Release `runtime-v<N>`, `releases/download/runtime-v<N>/<file>`         |
| `download.blame.so/runtime/v1` … `v9`              | The legacy object storage bucket (published before GitHub Releases)     |

## Desktop app

1. Check that CI is green on `main`.
2. Tag and push:

   ```bash
   git tag v1.2.0
   git push origin v1.2.0
   ```

3. The workflow checks that the runtime referenced by `packages/desktop/resources/runtime/*/manifest.json` is published, builds macOS (x64 and arm64, signed and notarized), Windows, and Linux, and then creates a draft release.
4. **Pre-production test.** Only maintainers can see a draft. Download the installers from the draft on the [releases page](https://github.com/rchrp/Blame/releases) and test them.
5. Edit the generated notes and click **Publish release**. From then on, `download.blame.so/latest`, the download page, and the in-app updater serve this version.

A tag with a suffix such as `v1.2.0-beta.1` creates a prerelease. GitHub never treats a prerelease as the latest release, so it never reaches users through the updater or the download page.

If a job fails, use **Re-run failed jobs** on the workflow run. To abandon a release, delete the draft and the tag (`git push origin :v1.2.0`).

## Desktop runtime

The Windows (WSL rootfs) and macOS (Lima image) runtimes are versioned separately from the app. Release a new one whenever the runtime images change.

1. Bump `runtimeVersion` in `packages/desktop/resources/runtime/windows/manifest.json` and `packages/desktop/resources/runtime/macos/manifest.json`, then merge.
2. Tag and push. The tag must match the manifests:

   ```bash
   git tag runtime-v10
   git push origin runtime-v10
   ```

3. Wait for the release to be published (about 1h30). The workflow publishes it right away without making it the latest release, because desktop builds need to download it.
4. Release the desktop app as usual.

Never delete a runtime release that a published desktop version still references.

## Cline SDK updates

Blame pins every `@cline/*` package to one exact version. The SDK is also baked into the runtime images. Every Monday, the **Update Cline SDK** workflow compares that version with npm's latest release. When a newer one exists, it opens a pull request (or refreshes the open one) that:

- pins every `@cline/*` dependency to the new version and updates `pnpm-lock.yaml`,
- writes the new `clineSdkVersion` into both runtime manifests and bumps `runtimeVersion`,
- updates the version pinned by the sandbox runner image and the runtime provisioning script fallbacks,
- lists the releases and SDK commits since the current version.

The pull request is never merged automatically. CI runs the **Agent runtime tests**, which include a smoke test that drives a real Cline session through Blame's configuration. After merging, release the runtime and then the desktop app, as the pull request describes.

To check by hand: `pnpm update:cline-sdk check`.

New models do not wait for an SDK update. The API refreshes its catalog from the live Cline catalog every few hours, and desktop sessions fetch the metadata of a model their bundled SDK does not know yet from `GET /api/v1/providers/catalog/model`.

## Local builds

Use local builds to try a change before you tag it. They never publish anything.

```bash
pnpm build:desktop                         # installers for this machine, in packages/desktop/dist
pnpm build:desktop --mac --x64 --arm64     # both macOS architectures
pnpm build:runtime                         # runtime images for this machine, in packages/desktop/dist/runtime
```

Local desktop builds use the same update feed and published runtime as production builds. To sign macOS builds locally, put the signing variables listed below in the ignored root `.env.local`. [packages/desktop/README.md](packages/desktop/README.md) lists the runtime build prerequisites.

## Repository configuration

Secrets used for macOS signing and notarization:

```txt
APPLE_API_ISSUER
APPLE_API_KEY_ID
APPLE_API_KEY_P8_B64
MAC_CSC_KEY_PASSWORD
MAC_CSC_LINK
```

Optional variables: `BLAME_HOMEPAGE`, `BLAME_MAINTAINER_EMAIL`, `BLAME_MAINTAINER_NAME`.

For Cline SDK update pull requests:

- Allow GitHub Actions to open pull requests: **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests**.
- Optional secret `CLINE_SDK_UPDATE_TOKEN`: a fine-grained token with **Contents** and **Pull requests** write access on this repository. Pull requests opened with the default token do not trigger CI. Without this secret, close and reopen the pull request to start CI.

## Sandbox runner image

The cloud preview sandbox runner image is still published manually with `pnpm release:sandbox-runner`. It is a container image, not a GitHub Release.
