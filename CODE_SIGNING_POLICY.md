# Code signing policy

This page describes how Blame's releases are signed. It is also published at [blame.so/code-signing-policy](https://blame.so/code-signing-policy).

## Windows

**Status: not signed yet.** Blame plans to apply to [SignPath Foundation](https://signpath.org) for free code signing for open-source projects. Until Windows releases are signed, the installer is not signed and SmartScreen may warn about it.

Once approved, Windows releases will carry this attribution:

> Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org)

What will be signed, for each Windows release:

- `Blame.exe`, the application executable;
- `blame-win-x64.exe`, the installer.

Only files built from this repository's source are signed. Third-party binaries that Blame ships unchanged (Electron's libraries, ripgrep, node-pty's helpers, pnpm) keep their upstream signature or none.

## macOS

macOS releases are signed with an Apple Developer ID certificate and notarized by Apple.

## How releases are built

Every release is built from a tag in this public repository by [GitHub Actions on GitHub-hosted runners](.github/workflows/release-desktop.yml). No release is built or signed on a personal machine. For Windows, the workflow sends the unsigned files to SignPath, and a maintainer approves each signing request by hand before SignPath signs them. [RELEASING.md](RELEASING.md) describes the whole process.

## Team roles

Blame has one maintainer, who holds every role:

| Role                     | Members                                         |
| ------------------------ | ----------------------------------------------- |
| Committers and reviewers | [Raphael Charpentier](https://github.com/rchrp) |
| Approvers                | [Raphael Charpentier](https://github.com/rchrp) |

Contributions from anyone else arrive as pull requests, which a reviewer checks before they are merged. Every team member uses multi-factor authentication on GitHub and SignPath.

## Privacy

Blame's [privacy policy](https://blame.so/privacy) describes the data the app sends, where it goes, and how to turn it off. The Windows installer shows a summary of it before installing and lets you turn off usage telemetry and the update check at launch; **Settings → Desktop → Privacy** has the same switches.

## Reporting a problem

To report a signed file that you think is malicious or misattributed, follow [SECURITY.md](SECURITY.md) or write to security@blame.so.
