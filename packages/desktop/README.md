# Blame Desktop

Electron shell for the Blame app and Cline SDK runtime IPC.

## Packaging

Build the desktop app before packaging installers:

```bash
pnpm --filter @blame/desktop build
```

Create installers for the current platform:

```bash
pnpm --filter @blame/desktop package
```

Platform-specific commands:

```bash
pnpm --filter @blame/desktop package:mac
pnpm --filter @blame/desktop package:win
pnpm --filter @blame/desktop package:linux
```

The installers are written to `packages/desktop/dist`.

## Releases

Releases are built and published by GitHub Actions from git tags. See [RELEASING.md](../../RELEASING.md).

## Prebuilt Desktop Runtimes

Windows and macOS installers use versioned runtime images so first setup only imports an image instead of installing Node, the Cline SDK, and Docker Engine with Compose.

The base images keep Cline's cloud providers, including OpenAI Codex OAuth and the Anthropic API. They exclude the native Codex and Claude CLI payloads because those binaries are only required by the dedicated local CLI providers. Enabling either local CLI provider later must include its authentication and executable-path setup.

On Arch Linux, start Docker and install `qemu-img` plus `qemu-system-x86_64`. Then set `BLAME_RUNTIME_VERSION` in `.env.local` and build both runtimes for the host architecture:

```bash
pnpm build:runtime
```

The platform-specific commands are useful while iterating:

```bash
pnpm build:runtime:windows
pnpm build:runtime:macos
```

The Windows command builds a WSL-compatible rootfs with Docker and does not require Windows, WSL, or PowerShell. The macOS command builds a Lima qcow2 image inside a temporary QEMU VM. Lima and every downloaded base image are pinned and checksum-verified.

The macOS builder also reboots the finished image and checks the runtime. Run `pnpm verify:runtime:macos` to repeat only that verification without rebuilding it.

Artifacts are written below `packages/desktop/dist/runtime/windows` and `packages/desktop/dist/runtime/macos`. Add `-- --arch amd64`, `-- --arch arm64`, `-- --arch x86_64`, or `-- --arch aarch64` to a platform command. `pnpm build:runtime:all` builds all four artifacts; foreign architectures require Docker binfmt and the matching QEMU system emulator and firmware.

Local runtime builds are only for testing. Published runtimes are built by the `Release runtime` workflow on native x86-64 and ARM64 runners; see [RELEASING.md](../../RELEASING.md).
