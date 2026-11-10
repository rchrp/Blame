import { premiumBenefits, pricingBillingOptions } from "@blame/pricing-card/offer";
import { artifactUrl, type DownloadArtifact } from "@/app/(en)/download/artifacts";
import { pricingFaq, type FaqEntry } from "@/content/faq";
import {
  githubReleasesUrl,
  githubRepositoryUrl,
  harnessSourceUrl,
} from "@/lib/github";
import { isMarkdownPagePath, markdownUrlPath } from "@/lib/markdown-paths";
import { publisher } from "@/lib/publisher";
import { absoluteSiteUrl } from "@/lib/site";

// The product pages as Markdown for AI agents. The text follows the pages
// (app/product-story.tsx, app/harness-story.tsx, components/story/*, the
// pricing and download pages) and the repository README; keep them in step
// when the copy changes.

const { monthly, yearly } = pricingBillingOptions;
const premiumPrice = `$${monthly.price}/month or $${yearly.price}/year`;
const demoVideoUrl = "https://youtu.be/cD6jASpIKQw";
const studyUrl = absoluteSiteUrl("/research/light-semantic-harness-study.pdf");

export const productSummary =
  "Blame ADE is a free, open-source desktop app for macOS, Windows, and Linux that runs coding agents in parallel, each with its own live preview. Every story gets its own branch, worktree, ports, and containers for the app and its services, so up to three agents work at once without conflicts, and nothing merges until you approve it. No account needed: it works with your Claude or ChatGPT plan, or 50 AI providers with your own key.";

const installCommands = [
  "- macOS: `brew install --cask rchrp/tap/blame`",
  `- Windows: the installer from ${absoluteSiteUrl("/download")}. A winget package is coming soon.`,
  "- Linux: the AppImage, `.deb`, or `.rpm` package from the download page. An AUR package is coming soon.",
].join("\n");

const keyLinks = [
  `- Website: ${absoluteSiteUrl("/")}`,
  `- Download: ${absoluteSiteUrl("/download")} (Markdown: ${absoluteSiteUrl("/download.md")})`,
  `- Blame Cloud: ${absoluteSiteUrl("/cloud")} — the app is free and open source; Blame Cloud adds hosted services for ${premiumPrice}`,
  `- Source code: ${githubRepositoryUrl} (AGPL-3.0-only)`,
  `- Releases: ${githubReleasesUrl}`,
  `- Code signing policy: ${absoluteSiteUrl("/code-signing-policy")}`,
  `- Demo video: ${demoVideoUrl}`,
].join("\n");

export function homeMarkdown() {
  return `# Blame ADE — Run coding agents in parallel, each with its own live preview

> ${productSummary}

${keyLinks}

Plan stories in a backlog, then run up to three agents at once. Each gets its own ports, database, and services, so you try every change in its running app before you review and merge it.

Free and open source · No account needed · Works with your Claude or ChatGPT plan

## Install

${installCommands}

Then open Blame and choose Continue without an account. Install guide: ${absoluteSiteUrl("/docs/install")}

## Worktrees isolate the code. Blame isolates the running app.

Run three agents in three worktrees and they still share one localhost:3000, one database, and one .env. Blame gives each story its own running app, from first prompt to merge.

## Three stories, three running apps, no conflicts

Before an agent starts, Blame gives its story:

- its own branch and worktree;
- its own ports;
- its own containers for the app and its services: database, cache, workers.

Up to three agents run at once, and you try each change in its own running app. Previews today cover web apps and APIs that run on Linux (the page in a built-in browser) and Linux GUI, Electron, and Tauri apps (a screen of the running app).

## How a story goes from backlog to merge

1. Open Blame and choose Continue without an account, or sign in.
2. Connect an AI provider: sign in with your Claude or ChatGPT plan, or paste an API key.
3. Open a Git repository, or create a new project from a web stack. Blame prepares how the project runs in a preview.
4. Write two or three user stories in the backlog and start an agent on each. They run at the same time.
5. Open each story's Preview tab to try its own running copy of the app, then request changes, reject the work, or approve and merge.

For a quick fix or a question about the code, skip the backlog and use Quick Chat.

## The backlog: every request gets a lane

Write the outcome once. Blame gives it a lane that keeps the brief, the agent’s work, the review, and your decision together, from first draft to merge.

## Light Semantic Harness: sharper tools, smaller bills

Same model, different harness. Blame’s agents find code by its structure, read only what they need, and edit only what they’ve read. Every agent works through five guarded tools:

| Tool | What the agent does | What the harness guarantees |
| --- | --- | --- |
| \`search_code\` | Finds code by its structure | Declarations come from the syntax tree and the TypeScript project, not from text matches. |
| \`read_code\` | Reads before it writes | Every read is recorded with the file version it saw. Unread code cannot be edited. |
| \`edit_code\` | Edits declarations and files | An edit must match the exact text the agent read. Stale or ambiguous targets are refused, and batches are atomic. |
| \`run_task\` | Runs commands and tests | Results are bound to the run and the source revision. A failing test stays failed, even behind a script that exits 0. |
| \`finish_task\` | Hands the work back | Required checks run again on the final source. Missing or stale checks are reported as unverified, with the reason. |

Measured in the open: on six fresh cross-module TypeScript tasks audited by hand, the harness matched Cline’s 6/6 with 54% fewer tokens and a 39% lower estimated cost, with the same model (panel F61 of the study).

- Study (PDF): ${studyUrl}
- Harness source: ${harnessSourceUrl}

## Live previews and review: merge when it earns it

Open the running app beside the story, read the diff and the checks, then approve, request changes, or reject. The agent moves fast. The decision stays yours. Cloud Previews, part of Blame Cloud, can also run a worktree's app in a managed sandbox.

## Parallel agents: run every agent on the model that fits

Run up to three agents at once, each on its own model. Sign in with your Claude or ChatGPT plan, or use any of 50 AI providers, such as OpenAI, Anthropic, Google, xAI, and Mistral, with your own key, plus any OpenAI-compatible API.

## Code Practices: same rules for every agent

Four practices, set project by project: coding style, unit tests, architecture, and commit messages. For each, agents either match what the codebase already does, or apply a stricter standard: explicit, typed, focused code with deliberate error handling; a TDD loop with ZOMBIES cases; Clean, Onion, and Hexagonal Architecture with ports and adapters; exact Conventional Commits. Blame detects which practices the project already follows.

## Specialist agents: more perspective, only when it matters

Focused specialists sharpen context, interface quality, verification, and risk. One lead agent stays responsible for the implementation.

- Codebase Analyst: finds the right context.
- Story Analyst: tightens the brief.
- Frontend Design Specialist: refines the interface.
- Test & Verification Analyst: plans the proof.
- Risk & Review Analyst: challenges merge readiness.

## Blame Cloud: change computers, keep every detail

Open the same project on another computer and Blame restores the context around it.

- Stories and conversations: every user story and its full conversation history stays linked to the project.
- Code practices and preferences: your enabled practices and project preferences return exactly as you set them.
- Provider connections: tokens and OAuth connections stay ready, so each provider works without another setup.
- MCP configurations: every configured MCP server is restored when you move to another computer.

## Project creation: from empty folder to agent-ready

Choose a web stack. Blame generates the structure, tooling, environment files, and preview configuration inside the same workflow.

## Platforms

- macOS 13 or later, Apple silicon and Intel. Agents, worktrees, and previews run in a small Linux VM (Lima) that Blame sets up on first launch.
- Windows 10 or 11 with WSL 2. Blame runs agents in its own WSL distribution.
- Linux x86_64 (AppImage, Debian, and RPM packages). Worktrees stay native; previews and project services run in Docker (Docker Engine with the Compose plugin).

## Frequently asked questions

${faqMarkdown(pricingFaq)}

### How is Blame built?

Blame is a TypeScript monorepo: an Electron desktop app, a React interface, an AdonisJS API, and an agent runtime built on the Cline SDK. Code navigation uses ast-grep and Tree-sitter.

## License and publisher

Blame is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only). It is published by Raphael Charpentier EI, operating under the trade name MK Holding (SIREN ${publisher.siren}, Lyon, France). Contact: support@blame.so.
`;
}

export function pricingMarkdown() {
  return `# Blame Cloud

> Free to build. Cloud when you need it. Run AI coding agents with your own providers, preview locally, and review your changes for free. Add Blame Cloud for services hosted by Blame.

Page: ${absoluteSiteUrl("/cloud")}

## Free, without a subscription

The whole app is free and open source (AGPL-3.0).

- Projects, backlog, and conversations
- Local worktrees and local previews
- Your own AI provider credentials (API key or subscription)

## Blame Cloud

${monthly.label}: $${monthly.price} (${monthly.suffix}). ${yearly.label}: $${yearly.price} (${yearly.suffix}).

${premiumBenefits.map((benefit) => `- ${benefit}`).join("\n")}

Your AI provider bills its own usage. Files stay accessible after a subscription ends.

## Frequently asked questions

${faqMarkdown(pricingFaq)}

## Policies

- Terms of Service: ${absoluteSiteUrl("/terms-of-service.md")}
- Privacy Policy: ${absoluteSiteUrl("/privacy.md")}
- Code signing policy: ${absoluteSiteUrl("/code-signing-policy.md")}
- Refund Policy: ${absoluteSiteUrl("/refund-policy.md")}
- Withdrawal (14-day consumer right): ${absoluteSiteUrl("/withdraw")}
`;
}

export function downloadMarkdown(release: {
  tag: string | null;
  artifacts: readonly DownloadArtifact[];
}) {
  const rows = release.artifacts.map(
    (artifact) =>
      `| ${artifact.platform} | ${artifact.architecture} | [${artifact.fileName}](${artifactUrl(artifact.fileName)}) | ${artifact.size}B | ${artifact.updatedAt} |`,
  );
  return `# Download Blame ADE

> Free and open source, for macOS, Windows, and Linux. No account needed: open the app, choose Continue without an account, and your agents, worktrees, and previews run on your machine.

Page: ${absoluteSiteUrl("/download")}

## Install from the command line

${installCommands}

Install guide: ${absoluteSiteUrl("/docs/install")}

## Latest release${release.tag ? `: ${release.tag}` : ""}

| Platform | Architecture | File | Size | Updated |
| --- | --- | --- | --- | --- |
${rows.join("\n")}

Linux packages: [Debian (.deb)](${artifactUrl("blame-linux-amd64.deb")}) · [RPM (.rpm)](${artifactUrl("blame-linux-x86_64.rpm")}). Checksums (\`SHA256SUMS\`), betas, and every past version are on the releases page: ${githubReleasesUrl}. Blame keeps itself up to date from those releases.

## Requirements

- macOS 13 or later (Apple silicon or Intel). The app is signed and notarized. On first launch, Blame sets up a small Linux VM (Lima) where agents, worktrees, and previews run.
- Windows 10 or 11 with WSL 2. The installer is not code-signed yet (signing through SignPath Foundation is planned: ${absoluteSiteUrl("/code-signing-policy")}), so SmartScreen may warn: choose More info, then Run anyway. If WSL is missing, run \`wsl --install\` in an administrator terminal and restart.
- Linux x86_64 with Docker Engine and the Compose plugin. Worktrees stay native; previews and project services run in Docker.

## Install on Linux

\`\`\`bash
# AppImage
chmod +x blame-linux-x86_64.AppImage && ./blame-linux-x86_64.AppImage

# Debian, Ubuntu
sudo apt install ./blame-linux-amd64.deb

# Fedora, RHEL
sudo dnf install ./blame-linux-x86_64.rpm
\`\`\`

## Verify a download

\`\`\`bash
shasum -a 256 -c SHA256SUMS --ignore-missing
\`\`\`

Blame is open source under the AGPL-3.0; the source code is on GitHub: ${githubRepositoryUrl}. How releases are signed: [Code signing policy](${absoluteSiteUrl("/code-signing-policy")}).
`;
}

// The questions as Markdown, each linking to the Markdown version of the
// page it points to when there is one.
function faqMarkdown(entries: readonly FaqEntry[]) {
  return entries
    .map((entry) => {
      const link = entry.link
        ? ` ${entry.link.label}: ${absoluteSiteUrl(
            isMarkdownPagePath(entry.link.path)
              ? markdownUrlPath(entry.link.path)
              : entry.link.path,
          )}`
        : "";
      return `### ${entry.question}\n\n${entry.answer}${link}`;
    })
    .join("\n\n");
}
