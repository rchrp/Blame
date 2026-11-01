import { premiumBenefits, pricingBillingOptions } from "@blame/pricing-card/offer";
import { artifactUrl, type DownloadArtifact } from "@/app/(en)/download/artifacts";
import {
  githubReleasesUrl,
  githubRepositoryUrl,
  harnessSourceUrl,
} from "@/lib/github";
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
  "Blame is an open-source Agentic Development Environment (ADE) for AI coding agents: a desktop app for macOS, Windows, and Linux where each task goes from backlog to agent, isolated worktree, live preview, review, and controlled merge. Agents work through a verifiable harness, and nothing merges until you approve it.";

const keyLinks = [
  `- Website: ${absoluteSiteUrl("/")}`,
  `- Download: ${absoluteSiteUrl("/download")} (Markdown: ${absoluteSiteUrl("/download.md")})`,
  `- Pricing: ${absoluteSiteUrl("/pricing")} — free and open source; Blame Premium adds hosted services for ${premiumPrice}`,
  `- Source code: ${githubRepositoryUrl} (AGPL-3.0-only)`,
  `- Releases: ${githubReleasesUrl}`,
  `- Demo video: ${demoVideoUrl}`,
].join("\n");

export function homeMarkdown() {
  return `# Blame — the open-source ADE for AI coding agents

> ${productSummary}

${keyLinks}

AI can write the code. Blame makes it shippable. From story to controlled merge, one verifiable harness unifies agents, Code Practices, smart worktrees, and live Cloud Previews.

## How a story goes from backlog to merge

1. Open Blame and sign in, or create a free account.
2. Open a Git repository, or create a new project from a web stack.
3. Connect an AI provider with your own API key or subscription.
4. Write a user story in the backlog and hand it to an agent.
5. Follow the agent in its own worktree, try the result in the live preview, then request changes, reject it, or approve and merge.

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

Measured in the open: on fresh cross-module TypeScript tasks audited by hand, the harness matched Cline’s 6/6 with 54% fewer tokens and a 39% lower estimated cost, with the same model (panel F61 of the study).

- Study (PDF): ${studyUrl}
- Harness source: ${harnessSourceUrl}

## Smart workspaces: one story, its own workspace

Isolated by default. Blame analyzes your project, works out what each story needs, and prepares a dedicated branch, worktree, environment, port, and runtime before the agent starts.

## Live previews and review: merge when it earns it

Open the running app beside the story, read the diff and the checks, then approve, request changes, or reject. The agent moves fast. The decision stays yours. Cloud Previews, a Premium feature, can also run a worktree's app in a managed sandbox.

## Parallel agents: run every agent on the model that fits

Launch multiple agents in parallel, even across different providers. Blame supports 50 AI providers, such as OpenAI, Anthropic, Google, xAI, and Mistral, plus any OpenAI-compatible API, so every task can use the model that fits it best.

## Code Practices: every agent codes like a pro

Blame holds every implementation to professional engineering standards: clean code, verified changes, sound architecture, and a commit history your team can trust. Practices are set project by project.

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

### Is Blame free?

Yes. The whole app is free and open source under the AGPL-3.0. Blame Premium (${premiumPrice}) only adds hosted services: managed Cloud Previews, cloud voice transcription, and hosted file uploads. Your AI provider bills its own usage.

### Where does my code run?

On your computer. Local execution uses a Lima VM on macOS, a WSL distribution on Windows, and native worktrees with Docker on Linux. Code is sent to the AI provider you choose when an agent needs it. Cloud Previews, a Premium feature, sync a workspace snapshot to a managed sandbox.

### Which AI providers can I use?

Any of the 50 supported providers, with your own API key or subscription, plus any OpenAI-compatible endpoint. You can use a different model for each agent.

### Why do I need an account?

Your account syncs stories, conversations, Code Practices, provider connections, and MCP configuration between computers, and unlocks Premium services. The account is free.

### Can I self-host the backend?

Not as a turnkey setup yet. The development setup in the repository's CONTRIBUTING.md runs the whole stack locally.

### How is Blame built?

Blame is a TypeScript monorepo: an Electron desktop app, a React interface, an AdonisJS API, and an agent runtime built on the Cline SDK. Code navigation uses ast-grep and Tree-sitter.

## License and publisher

Blame is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only). It is published by Raphael Charpentier EI, operating under the trade name MK Holding (SIREN 984 448 217, Lyon, France). Contact: support@blame.so.
`;
}

export function pricingMarkdown() {
  return `# Blame pricing

> Free to build. Premium for the cloud. Run AI coding agents with your own providers, preview locally, and review your changes for free. Add Blame Premium for services hosted by Blame.

Page: ${absoluteSiteUrl("/pricing")}

## Free, without a subscription

The whole app is free and open source (AGPL-3.0).

- Projects, backlog, and conversations
- Local worktrees and local previews
- Your own AI provider credentials (API key or subscription)

## Blame Premium

${monthly.label}: $${monthly.price} (${monthly.suffix}). ${yearly.label}: $${yearly.price} (${yearly.suffix}).

${premiumBenefits.map((benefit) => `- ${benefit}`).join("\n")}

Your AI provider bills its own usage. Files stay accessible after a subscription ends.

## Policies

- Terms of Service: ${absoluteSiteUrl("/terms-of-service.md")}
- Privacy Policy: ${absoluteSiteUrl("/privacy.md")}
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
  return `# Download Blame

> Install the Blame desktop app and keep agent execution close to your code: isolated worktrees, live previews, diffs, and controlled merges on your machine.

Page: ${absoluteSiteUrl("/download")}

## Latest release${release.tag ? `: ${release.tag}` : ""}

| Platform | Architecture | File | Size | Updated |
| --- | --- | --- | --- | --- |
${rows.join("\n")}

Linux packages: [Debian (.deb)](${artifactUrl("blame-linux-amd64.deb")}) · [RPM (.rpm)](${artifactUrl("blame-linux-x86_64.rpm")}). Checksums (\`SHA256SUMS\`), betas, and every past version are on the releases page: ${githubReleasesUrl}. Blame keeps itself up to date from those releases.

## Requirements

- macOS 13 or later (Apple silicon or Intel). The app is signed and notarized. On first launch, Blame sets up a small Linux VM (Lima) where agents, worktrees, and previews run.
- Windows 10 or 11 with WSL 2. The installer is not code-signed yet, so SmartScreen may warn: choose More info, then Run anyway. If WSL is missing, run \`wsl --install\` in an administrator terminal and restart.
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

Blame is open source under the AGPL-3.0; the source code is on GitHub: ${githubRepositoryUrl}.
`;
}
