<div align="center">

<a href="https://blame.so"><img src="packages/vitrine/public/icons/blame-icon-256.png" width="96" height="96" alt="Blame"></a>

# Blame

### The open-source ADE for AI coding agents

Hand an agent a user story. Get back a change you can check before it merges.

[![Latest release](https://img.shields.io/github/v/release/rchrp/Blame?label=release&color=3b5bdb)](https://github.com/rchrp/Blame/releases/latest)
[![CI](https://github.com/rchrp/Blame/actions/workflows/ci.yml/badge.svg)](https://github.com/rchrp/Blame/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-3b5bdb)](LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-555)](#install)
[![GitHub stars](https://img.shields.io/github/stars/rchrp/Blame?color=f7cf83)](https://github.com/rchrp/Blame/stargazers)

**[Download](#install)** · [Website](https://blame.so) · [Demo video](https://youtu.be/cD6jASpIKQw) · [Discussions](https://github.com/rchrp/Blame/discussions) · [Contributing](CONTRIBUTING.md)

<a href="https://youtu.be/cD6jASpIKQw"><img src="packages/vitrine/public/demo.gif" width="900" alt="A user story goes from the backlog to an agent, a live preview, and a reviewed merge in Blame"></a>

</div>

## Why Blame

Coding agents write code fast. Checking that code is still your job, and most tools leave you to piece it together from a chat log, a terminal, and a branch you never ran.

Blame is an Agentic Development Environment (ADE): one desktop app where each task goes from **backlog → agent → isolated worktree → live preview → review → merge**. Agents work through a harness that records what they read, what they changed, and which checks passed. You see the running app and the evidence side by side, and nothing merges until you approve it.

- **Verifiable, not vibes.** The [Light Semantic Harness](#the-light-semantic-harness) makes every agent show its work.
- **Isolated by default.** Every story gets its own branch, worktree, environment, port, and preview.
- **Your models, your machine.** Bring any of 50 AI providers. Agents, worktrees, and previews run on your computer.
- **Free and open source.** The whole app is AGPL-3.0. [Blame Premium](#free-and-premium) only adds hosted services.

## Install

Download the latest release for your platform:

| Platform                  | Download                                                                                                                                                                                                                                   | Requirements                                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| **macOS** (Apple silicon) | [`blame-mac-arm64.dmg`](https://download.blame.so/latest/blame-mac-arm64.dmg)                                                                                                                                                              | macOS 13 or later                           |
| **macOS** (Intel)         | [`blame-mac-x64.dmg`](https://download.blame.so/latest/blame-mac-x64.dmg)                                                                                                                                                                  | macOS 13 or later                           |
| **Windows** (x64)         | [`blame-win-x64.exe`](https://download.blame.so/latest/blame-win-x64.exe)                                                                                                                                                                  | Windows 10 or 11 with WSL 2                 |
| **Linux** (x86_64)        | [`AppImage`](https://download.blame.so/latest/blame-linux-x86_64.AppImage) · [`.deb`](https://download.blame.so/latest/blame-linux-amd64.deb) · [`.rpm`](https://download.blame.so/latest/blame-linux-x86_64.rpm) | Docker Engine with the Compose plugin       |

You can also pick any version, including betas, from the [releases page](https://github.com/rchrp/Blame/releases) or [blame.so/download](https://blame.so/download). Blame keeps itself up to date from those releases.

<details>
<summary><strong>Platform notes</strong></summary>

**macOS.** The app is signed and notarized. On first launch, Blame sets up a small Linux VM (based on [Lima](https://lima-vm.io)) where agents, worktrees, and previews run.

**Windows.** The installer is not code-signed yet, so SmartScreen may warn you: choose **More info → Run anyway**. Blame runs agents in its own WSL distribution. If WSL is not installed, run `wsl --install` in an administrator terminal and restart first.

**Linux.** Worktrees stay native, and previews and project services run in Docker on your machine.

```bash
# AppImage
chmod +x blame-linux-x86_64.AppImage && ./blame-linux-x86_64.AppImage

# Debian, Ubuntu
sudo apt install ./blame-linux-amd64.deb

# Fedora, RHEL
sudo dnf install ./blame-linux-x86_64.rpm
```

**Verify a download.** Each release ships a `SHA256SUMS` file:

```bash
shasum -a 256 -c SHA256SUMS --ignore-missing
```

**Beta channel.** Turn on **Settings → Desktop → Beta channel** to get prereleases as soon as they ship.

</details>

## Quick start

1. Open Blame and sign in, or create a free account.
2. Open a Git repository, or create a new project from a web stack.
3. Connect an AI provider with your own API key or subscription.
4. Write a user story in the backlog and hand it to an agent.
5. Follow the agent in its own worktree, try the result in the live preview, then request changes, reject it, or approve and merge.

For a quick fix or a question about the code, skip the backlog and use **Quick Chat**.

## The Light Semantic Harness

Most coding agents grep, rewrite whole files, and tell you it should work now. Blame gives every agent five guarded tools instead:

| Tool          | What the agent does               | What the harness guarantees                                                                                         |
| ------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `search_code` | Finds code by its structure       | Declarations come from the syntax tree and the TypeScript project, not from text matches.                          |
| `read_code`   | Reads before it writes            | Every read is recorded with the file version it saw. Unread code cannot be edited.                                  |
| `edit_code`   | Edits declarations and files      | An edit must match the exact text the agent read. Stale or ambiguous targets are refused, and batches are atomic.   |
| `run_task`    | Runs commands and tests           | Results are bound to the run and the source revision. A failing test stays failed, even behind a script that exits 0. |
| `finish_task` | Hands the work back               | Required checks run again on the final source. Missing or stale checks are reported as unverified, with the reason. |

**Measured in the open.** On fresh cross-module TypeScript tasks audited by hand, the harness matched Cline's **6/6** with **54% fewer tokens** and a 39% lower estimated cost. That is panel F61 of the [harness study](docs/semantic-harness-study.tex), which details the conditions, the other panels, and the limits of each result. The harness lives in [`packages/agent-runtime/src/harness`](packages/agent-runtime/src/harness).

## Features

| Backlog to merge                                                         | Live preview and review                                                     |
| :----------------------------------------------------------------------: | :-------------------------------------------------------------------------: |
| ![Blame backlog](packages/vitrine/public/desktop-backlog.png)            | ![Blame live preview](packages/vitrine/public/desktop-preview.png)          |
| **Code Practices**                                                       | **Project creation**                                                        |
| ![Blame Code Practices](packages/vitrine/public/desktop-practices.png)   | ![Blame project creation](packages/vitrine/public/desktop-new-project.png)  |

- **Backlog-driven development.** Each user story becomes a lane that keeps its brief, context, agent activity, review notes, and final decision through queue, development, review, and merge.
- **Smart worktrees.** Blame analyzes the project and prepares a dedicated branch, worktree, environment, port, and runtime for each story before the agent starts.
- **Live previews.** Run each worktree's app beside its story, with files, diffs, logs, and terminal output. Cloud Previews can also run it in a managed sandbox.
- **Controlled merge.** Request another pass, reject the work, or approve and merge. The agent moves fast; the decision stays yours.
- **Parallel agents, any model.** Run several agents at once across 50 AI providers, plus any OpenAI-compatible API.
- **Code Practices.** Hold every agent to your conventions, or to a stricter engineering standard, project by project.
- **Specialist agents.** Codebase, story, frontend design, verification, and risk specialists sharpen the work while one lead agent stays responsible for it.
- **MCP servers.** Connect your MCP servers to every agent.
- **Project creation.** Start from an empty folder: pick a web stack and Blame generates a project ready for agent work.
- **Account sync.** Stories, conversations, Code Practices, provider connections, and MCP servers follow you to another computer.

## Free and Premium

Blame is free and open source. Blame Premium pays for hosted services that cost money to run.

| Free, without a subscription           | Blame Premium                                                 |
| -------------------------------------- | ------------------------------------------------------------- |
| Projects, backlog, and conversations   | Cloud voice transcription                                     |
| Local worktrees and local previews     | Managed Cloud Previews                                        |
| Your own AI provider credentials       | New hosted file uploads, including deployment source archives |

Premium is **$20/month** or **$200/year**. Your AI provider bills its own usage. Files stay accessible after a subscription ends. See [blame.so/pricing](https://blame.so/pricing).

## FAQ

<details>
<summary><strong>Where does my code run?</strong></summary>

On your computer. Local execution uses a Lima VM on macOS, a WSL distribution on Windows, and native worktrees with Docker on Linux. Code is sent to the AI provider you choose when an agent needs it. Cloud Previews, a Premium feature, sync a workspace snapshot to a managed sandbox.

</details>

<details>
<summary><strong>Which AI providers can I use?</strong></summary>

Any of the 50 supported providers, with your own API key or subscription, plus any OpenAI-compatible endpoint. You can use a different model for each agent.

</details>

<details>
<summary><strong>Why do I need an account?</strong></summary>

Your account syncs stories, conversations, Code Practices, provider connections, and MCP configuration between computers, and unlocks Premium services. The account is free.

</details>

<details>
<summary><strong>Can I self-host the backend?</strong></summary>

Not as a turnkey setup yet. The development setup in [CONTRIBUTING.md](CONTRIBUTING.md) runs the whole stack locally, and the [open-source readiness summary](docs/open-source-readiness.tex) tracks what self-hosting still needs.

</details>

## Build from source

Blame is a TypeScript monorepo (pnpm and Turborepo): an Electron desktop app, a React interface, an AdonisJS API, and the agent runtime.

```bash
git clone https://github.com/rchrp/Blame.git
cd Blame
corepack enable
pnpm install --frozen-lockfile
```

You need Node.js 24, Git, and MySQL 8.4 for the API. [CONTRIBUTING.md](CONTRIBUTING.md) walks through configuring the API, running the desktop app, the checks to run, and how the repository is organized. [RELEASING.md](RELEASING.md) covers packaging and releases.

## Documentation

- [Architecture](docs/architecture-summary.tex): package boundaries, workspace execution, and the harness architecture.
- [Semantic harness study](docs/semantic-harness-study.tex): measured results, implementation guarantees, limitations, and research directions.
- [Refactoring summary](docs/refactoring-summary.tex): module responsibilities and validation.
- [Open-source readiness](docs/open-source-readiness.tex): licensing, self-hosting, and release preparation.
- [Releasing](RELEASING.md): how the desktop app and its runtimes are built and published.

## Community

- **Questions and ideas:** [GitHub Discussions](https://github.com/rchrp/Blame/discussions)
- **Bugs and feature requests:** [GitHub Issues](https://github.com/rchrp/Blame/issues)
- **Security reports:** see [SECURITY.md](SECURITY.md). Please do not open a public issue.
- **Contributing:** start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md).

If Blame is useful to you, a star helps other developers find it.

## Acknowledgements

Blame's agent runtime is built on the [Cline SDK](https://github.com/cline/cline). Its macOS runtime uses [Lima](https://lima-vm.io), and code navigation uses [ast-grep](https://ast-grep.github.io) and [Tree-sitter](https://tree-sitter.github.io).

## License

Blame is licensed under the [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`).

You may use Blame commercially. If you distribute it, you must provide the corresponding source under the same license. If you modify Blame and let users interact with it over a network, you must offer them the source of your modified version, as section 13 requires. Third-party components keep their own licenses and notices.
