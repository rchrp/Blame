# Releasing

Everything is built on GitHub-hosted runners and published as a GitHub Release. A release starts when you push a tag.

| Workflow                                                   | Trigger                         | Result                                                                   |
| ---------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------ |
| [CI](.github/workflows/ci.yml)                             | Pull requests, pushes to `main` | Line budgets, typecheck, and tests                                       |
| [Release desktop](.github/workflows/release-desktop.yml)   | Tag `v<semver>`                 | **Draft** release with the installers, update metadata, and `SHA256SUMS` |
| [Release cache](.github/workflows/release-cache.yml)       | Lockfile changes, twice a week  | pnpm store caches on `main` for the macOS and Windows release runners    |
| [Release packages](.github/workflows/release-packages.yml) | Stable release published        | Homebrew tap commit, winget-pkgs pull request, and AUR push              |
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

3. The workflow checks that the runtime referenced by `packages/desktop/resources/runtime/*/manifest.json` is published while it builds macOS (x64 and arm64, both packaged on Apple Silicon, signed and notarized), Windows, and Linux, and then creates a draft release.
   Once Windows signing is configured, **approve two signing requests in SignPath** while the Windows job runs: `Blame.exe` first, then the installer (see [Windows signing](#windows-signing)).
4. **Pre-production test.** Only maintainers can see a draft. Download the installers from the draft on the [releases page](https://github.com/rchrp/Blame/releases) and test them.
5. Edit the generated notes and click **Publish release**. From then on, `download.blame.so/latest`, the download page, and the in-app updater serve this version.
6. Publishing starts **Release packages**, which updates the package managers (see below).

### Windows signing

[SignPath Foundation](https://signpath.org) signs the Windows app for free, as an open-source project; the [Code signing policy](CODE_SIGNING_POLICY.md) is the public side of it. Until the `SIGNPATH_API_TOKEN` secret exists, the Windows job builds an unsigned installer and says so in a notice. Once it exists, the Windows job of **Release desktop**:

1. builds the app folder only, with the publisher check on (below);
2. uploads `Blame.exe` and submits it to SignPath with the `windows-app` artifact configuration;
3. waits for the request to be approved and signed, checks the signature, and packages the installer around the signed `Blame.exe` (`scripts/windows-signing.mjs installer`);
4. uploads the installer and submits it with the `windows-installer` configuration;
5. waits again, checks the signature, and rebuilds `latest.yml` (sha512, size) and the blockmap for the signed installer (`scripts/windows-signing.mjs update-info`). `SHA256SUMS` is computed afterwards from these files, so the in-app updater, Homebrew and winget all see the signed installer.

**Every release, betas included, needs two approvals** in SignPath (**Signing requests**, or the link in the job log): the app, then the installer, a few minutes apart. Each one waits up to two hours; after that the job fails, and **Re-run failed jobs** submits new requests. SignPath requires a manual approval for every request: there is no way to automate it.

**Publisher check.** Signed builds record `SignPath Foundation` as the only publisher whose updates they install (electron-updater's `publisherName`). Today's unsigned versions have no such check, so they update to the first signed version normally. From then on:

- never publish an unsigned Windows build again: signed installs would refuse it and stay on their version;
- if the certificate's publisher ever changes, first ship a version that lists both names (`BLAME_WINDOWS_PUBLISHER_NAME` in the workflow, `win.signtoolOptions.publisherName` in `packages/desktop/electron-builder.config.ts`).

**Set up once SignPath approves Blame:**

1. In SignPath, enable multi-factor authentication for every member, add the predefined trusted build system **GitHub.com** to the organization and link it to the project, and install the SignPath GitHub App on this repository.
2. Create the project (slug `blame`) with the signing policy `release-signing`, and two artifact configurations whose slugs and contents come from [`packaging/signpath/`](packaging/signpath): `windows-app` and `windows-installer`. They restrict signing to files whose product name is `Blame` and whose product version is the release's.
3. Create a CI user with the **Submitter** role on that signing policy, and add its API token as the `SIGNPATH_API_TOKEN` secret.
4. Add the organization ID as the `SIGNPATH_ORGANIZATION_ID` variable. If the project or signing policy slug differs, set `SIGNPATH_PROJECT_SLUG` or `SIGNPATH_SIGNING_POLICY_SLUG`.
5. Push a beta tag and approve both requests. If SignPath rejects a file over its product version, compare it with the file's properties (`Blame.exe` carries `1.2.0.0`, the installer `1.2.0` or `1.2.0-beta.1`) and adjust the configuration.
6. Install that beta over an unsigned version and check that it updates, then that the next beta updates too.
7. Once a signed version is published, set `windowsSigningApproved` to `true` in `packages/vitrine/content/code-signing-policy.ts`, and update the Windows status in [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md) and the Windows platform note in the README.

### Beta channel

To try a version in the app before releasing it, push a beta tag:

```bash
git tag v1.2.0-beta.1
git push origin v1.2.0-beta.1
```

A tag with a suffix is published right away as a prerelease, without a draft. GitHub never treats a prerelease as the latest release, so `download.blame.so/latest` and apps on the stable channel never see it. Apps with **Settings → Desktop → Beta channel** turned on update to the newest published release, prereleases included, by reading its update metadata from GitHub. Once `v1.2.0` is published, they move to it, since it is newer than its betas. Turning the channel off keeps the installed beta until a newer stable release ships.

If a job fails, use **Re-run failed jobs** on the workflow run. To abandon a release, delete the draft and the tag (`git push origin :v1.2.0`).

### Package managers

| Channel  | Install command                        | Updated by                                                                                                    |
| -------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Homebrew | `brew install --cask rchrp/tap/blame`  | A commit to `Casks/blame.rb` in [rchrp/homebrew-tap](https://github.com/rchrp/homebrew-tap)                   |
| winget   | `winget install Blame.Blame`           | A pull request to [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs), merged by its moderators |
| AUR      | `yay -S blame-bin` (not published yet) | A push to [blame-bin](https://aur.archlinux.org/packages/blame-bin)                                           |

The package sources are templates in [`packaging/`](packaging). [`scripts/packaging.mjs`](scripts/packaging.mjs) fills them with the version and the SHA-256 sums from the release's `SHA256SUMS`, and refuses anything but an `x.y.z` version:

```bash
node scripts/packaging.mjs render 1.2.0 SHA256SUMS out
```

**Release packages** runs when a release is published as stable (`released`), never for a prerelease, and checks again that the release is neither a draft nor a prerelease. Each channel whose secret is missing is skipped with a notice in the run summary. To retry a channel or backfill a version, run the workflow manually with the tag. A version already in the tap, winget-pkgs or AUR is left alone.

Homebrew and AUR update right away. winget users get the version once the pull request passes validation and is merged, usually within a day. The app updates itself from Homebrew and winget installs; on Arch, pacman updates it, and the AUR package removes the marker that the in-app updater uses on Linux.

**AUR is not published yet**: AUR account registration was closed in November 2026. Until `AUR_SSH_PRIVATE_KEY` exists, the AUR job is skipped and the README lists no AUR command. Once registration reopens:

1. Create the AUR account and add the public half of an AUR-only SSH key (**My Account → SSH Public Key**).
2. Add the private half as the `AUR_SSH_PRIVATE_KEY` secret.
3. Run **Release packages** manually with the latest stable tag: pushing to `blame-bin` creates the package.
4. Add `yay -S blame-bin` to the Install section of the README.

The official `homebrew/cask` repository needs a more notable GitHub repository; until then, the tap is the Homebrew channel.

## Desktop runtime

The Windows (WSL rootfs) and macOS (Lima image) runtimes are versioned separately from the app. Release a new one whenever the runtime images change.

1. Bump `runtimeVersion` in `packages/desktop/resources/runtime/windows/manifest.json` and `packages/desktop/resources/runtime/macos/manifest.json`, then merge.
2. Tag and push. The tag must match the manifests:

   ```bash
   git tag runtime-v10
   git push origin runtime-v10
   ```

3. Wait for the release to be published (about 20 minutes). The workflow publishes it right away without making it the latest release, because desktop builds need to download it.
4. Release the desktop app as usual.

The macOS images are provisioned natively in a chroot on runners of their architecture; only the final verification boots them, under emulation on the Arm runner, which has no KVM. To build and verify the images without publishing, run **Release runtime** manually from the Actions tab.

Never delete a runtime release that a published desktop version still references.

## Cline SDK updates

Blame pins every `@cline/*` package to one exact version. The SDK is also baked into the runtime images. Every Monday, the **Update Cline SDK** workflow compares that version with npm's latest release. When a newer one exists, it opens a pull request (or refreshes the open one) that:

- pins every `@cline/*` dependency to the new version and updates `pnpm-lock.yaml`,
- writes the new `clineSdkVersion` into both runtime manifests and bumps `runtimeVersion`,
- updates the version pinned by the sandbox runner image and the runtime provisioning script fallbacks,
- regenerates Blame's `@cline/core` patch with `scripts/patch-cline-core.mjs` (see `patches/README.md`),
- lists the releases and SDK commits since the current version.

When the patch cannot be regenerated, the pull request opens as a draft that names it. Once a maintainer has pushed commits to the pull request, the workflow no longer overwrites it and comments when a newer Cline release appears.

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

For Windows signing (optional until SignPath approves Blame; see [Windows signing](#windows-signing)):

- Secret `SIGNPATH_API_TOKEN`: the API token of a SignPath user with the **Submitter** role on the signing policy.
- Variable `SIGNPATH_ORGANIZATION_ID`: the SignPath organization ID.
- Optional variables `SIGNPATH_PROJECT_SLUG` (default `blame`) and `SIGNPATH_SIGNING_POLICY_SLUG` (default `release-signing`).

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

For the package managers (each one is optional):

- `HOMEBREW_TAP_TOKEN`: a fine-grained token limited to `rchrp/homebrew-tap`, with **Contents** read and write access.
- `WINGET_TOKEN`: a classic token with the `public_repo` scope only. winget-pkgs belongs to Microsoft, which fine-grained tokens cannot open pull requests on. `wingetcreate` pushes the manifests to the token owner's fork of winget-pkgs and opens the pull request from it.
- `AUR_SSH_PRIVATE_KEY`: the private half of an SSH key without a passphrase, used only for AUR. Add its public half to the AUR account that maintains `blame-bin` (**My Account → SSH Public Key**).

## Sandbox runner image

The cloud preview sandbox runner image is published by the **Release sandbox runner** workflow, run by hand from the Actions tab on `main`. It is a container image, not a GitHub Release.

1. Bump the runner version on `main` in `packages/sandbox-runner/package.json`, `src/version.ts` and the `Dockerfile`'s `BLAME_RUNNER_VERSION`; a test fails if they differ. The workflow refuses a version that is already published.
2. Run the workflow. It builds the amd64 image, scans it with grype, pushes it to the Vercel registry, signs its digest with Sigstore using the workflow's GitHub identity (no browser), and opens a pull request that writes the image and version into `packages/api/config/sandbox_runner_pin.ts`.
3. Merge that pull request. The API deploys with the new runner; code and runner always change together.

Setup, once:

- A GitHub environment `sandbox-runner-release`, with required reviewers, holding the secret `VERCEL_TOKEN` (a Vercel token that can read the `blame-sandbox-runtime` project's environment).
- Repository variables `VERCEL_TEAM_ID`, `VERCEL_RUNNER_PROJECT_ID` (the `blame-sandbox-runtime` project) and `BLAME_SANDBOX_RUNNER_REPOSITORY` (for example `vcr.vercel.com/<team>/<project>/blame-runner`).
- GitHub Actions allowed to open pull requests, as for the Cline SDK update. The optional `CLINE_SDK_UPDATE_TOKEN` also lets the pin pull request start CI.
- Remove `BLAME_SANDBOX_RUNNER_IMAGE` and `BLAME_SANDBOX_RUNNER_VERSION` from the production API environment once the first pin is merged: when set, they override the pin. Self-hosted deployments that publish their own runner set both instead.

The workflow's signature is verifiable by anyone: `cosign verify-blob` with the bundle from the `-signatures` image, `--certificate-identity-regexp 'https://github.com/rchrp/Blame/.github/workflows/release-sandbox-runner.yml@.*'` and `--certificate-oidc-issuer https://token.actions.githubusercontent.com`.

To publish from a workstation instead, log Docker in to the registry with a fresh OIDC token (it expires after 12 hours) from the linked `blame-sandbox-runtime` Vercel project (`vercel env pull`, then `docker login vcr.vercel.com -u oidc --password-stdin` with `VERCEL_OIDC_TOKEN`) and run `pnpm release:sandbox-runner -- --pin`. Signing then asks you to approve a Sigstore login in the browser. If that code expires after the image was pushed, sign the published digest without rebuilding: `node scripts/sandbox-runner-release.mjs sign sha256:<digest> --pin`.

`packages/sandbox-runner/grype.yaml` lists the critical findings the release scans accept because no fixed upstream build exists yet. Remove each entry once its fix ships.

## Preview surfaces and GUI images

Run the `Release preview images` workflow with an immutable version. It builds
amd64 and arm64 display, GUI Node and GUI Tauri images, signs their digests with
Sigstore, and exports package inventories, notices and distribution source
archives. The workflow also attaches these files to the permanent GitHub release. Keep
those release assets while distributing the images.

Download the three `.image` files to one folder and run
`node scripts/preview-image-pins.mjs <folder>`. Review and commit the generated
pins. Never replace a missing release with a mutable tag or an invented digest.
Rebuild the runtime images to prefetch the display image after updating the pins.

Publish sandbox runner 0.3.0 with the **Release sandbox runner** workflow and
merge its pin pull request: the API runner version and its verified image
digest change together. Older runners keep serving version 2 web plans;
terminal and display plans require version 3. Keep `BLAME_EXPERIMENTAL_SURFACES`
enabled only for the surfaces being validated until the spec's acceptance matrix
has passed. The first-use desktop ttyd installer supports runtimes predating
this release and verifies the same hashes as the runner image.
