# Security policy

## Supported versions

Security fixes go into the latest release of the Blame desktop app and into the hosted services at blame.so. Blame updates itself, so make sure you are on the [latest release](https://github.com/rchrp/Blame/releases/latest) before reporting.

| Version                     | Supported |
| --------------------------- | --------- |
| Latest stable release       | Yes       |
| Current beta (prerelease)   | Yes       |
| Older releases              | No        |

## Reporting a vulnerability

Please do not report security issues in public issues, discussions, or pull requests.

Report them privately instead, in either of these ways:

- **GitHub:** open a [private vulnerability report](https://github.com/rchrp/Blame/security/advisories/new).
- **Email:** write to [support@blame.so](mailto:support@blame.so) with "Security" in the subject.

Include as much of this as you can:

- the affected component (desktop app, agent runtime, API, website, or cloud previews) and version;
- the steps to reproduce, or a proof of concept;
- the impact you expect, and any known workaround.

You will get an acknowledgement within a few days. We will keep you informed while we work on a fix, and we are happy to credit you in the advisory once it is published, if you wish.

## Scope

In scope: the code in this repository, the published desktop releases and runtime images, and the hosted services at `blame.so`, `api.blame.so`, and `download.blame.so`.

Out of scope: vulnerabilities in your own AI provider, in third-party MCP servers you connect, or in the projects agents work on; social engineering; and denial-of-service tests against hosted services.
