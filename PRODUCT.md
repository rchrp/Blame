# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The desktop app is Electron (macOS, Windows, Linux) rendering the shared React UI in `packages/app`; its design language is web, not native. The public website `packages/vitrine` (blame.so) is a Next.js site.

## Users

Primarily solo developers who already work with AI coding agents. They run several agents on their own projects and act as both product owner and reviewer: they write the user story, hand it to an agent, then decide what is good enough to merge.

Small product teams are the next audience: a few engineers sharing a backlog, with a lead who reviews agent output before it merges. Team use is expected but secondary today. Decisions should serve the solo developer first without closing the door on shared review.

## Product Purpose

Blame is an Agentic Development Environment (ADE). It connects tasks, coding agents, isolated Git worktrees, previews and code review in one desktop workspace, so a developer can take work from backlog to reviewed merge.

Success means the developer merges agent work because they have checked it themselves, not because they trust it, and spends less time getting to that point than they would by stitching tools together.

## Positioning

**Verifiable before merge.** Nothing merges on trust. Blame's Light Semantic Harness records explicit execution and validation evidence. Each task also runs in its own worktree with a live preview, and diffs, files, logs and terminal output sit beside the merge decision. Neighbouring agent tools can generate code; Blame's claim is that you can see why a change is right, and that you approve or reject it yourself.

Site language in use: "the ADE for verifiable agentic development"; "From story to controlled merge, one verifiable harness unifies agents, Code Practices, smart worktrees, and live Cloud Previews."

## Operating Context

- Workflow: open a Git repository or create a project → configure an AI provider and project Code Practices → write a user story → send it to an agent → review the result in its worktree and preview → request changes, reject, or approve and merge.
- Lifecycle stages a story moves through: queue, development, review, merge.
- Quick Chat is for smaller changes, debugging and code exploration outside the backlog.
- Local execution uses native worktrees on Linux, Lima on macOS and WSL on Windows. Managed Cloud Previews sync a workspace snapshot to a Vercel Sandbox, which is separate from deploying to the user's own Vercel account.
- The desktop app provides filesystem, Git, terminal and local runtime access; the web frontend alone does not.
- Users bring their own AI provider credentials. Provider usage is billed by the provider.

## Capabilities and Constraints

- Core features: backlog-driven development, isolated Git worktrees, Quick Chat, project Code Practices, integrated previews and review, bring-your-own AI providers, Light Semantic Harness, MCP servers, and a security audit area.
- Specialist agent roles named on the site include Frontend Design Specialist, Test & Verification Analyst, and Risk & Review Analyst.
- Account sync restores stories and conversations, Code Practices and preferences, provider connections, and configured MCP servers on another computer.
- Plans: the free core covers projects, backlog, conversations, local worktrees, local previews and own provider credentials. **Blame Premium is $20/month** and adds cloud voice transcription, managed Vercel previews and new hosted file uploads. Existing files stay accessible after a subscription ends.
- Licence: AGPL-3.0-only, open source at github.com/rchrp/Blame. Self-hosting is not yet turnkey (see `docs/open-source-readiness.tex`).
- Terminology to keep: ADE, user story, Code Practices, smart worktrees, Cloud Previews, Quick Chat, Light Semantic Harness, controlled merge, Blame Premium.
- Languages: the product and website are in English. The website also has French legal pages (`app/fr`); no full French UI has been confirmed.

## Brand Commitments

- Name: **Blame**, domain blame.so. (Inferred, not confirmed: the name nods to `git blame`, meaning accountability for each change.)
- The product presents verification and control as its core claim; copy should never imply that agents merge on their own.

## Evidence on Hand

- Demo video: https://youtu.be/cD6jASpIKQw, plus `packages/vitrine/public/demo.gif`.
- Desktop screenshots: `packages/vitrine/public/desktop-backlog.png`, `desktop-new-project.png`, `desktop-practices.png`, `desktop-preview.png`.
- Agent and home illustrations: `packages/vitrine/public/agents/`, `packages/vitrine/public/home-illustrations/`.
- Provider logos: `packages/vitrine/components/provider-logos.tsx`.
- Research evidence: `docs/semantic-harness-study.tex` (measured harness results and limitations), benchmark tooling in `packages/benchmark-runner` and `tools/terminal_bench`. Benchmark figures only hold for the versions and conditions under which they were measured.
- **Absent, do not fabricate:** customer testimonials, named customers or logos, user counts, press coverage, and benchmark claims beyond what the harness study reports.

## Product Principles

1. **Evidence over trust.** Every surface that leads to a merge shows what the agent did and how it was checked. Treat a missing check as something to show, not hide.
2. **The human decides.** Agents propose and the developer disposes. Approve, request changes and reject are first-class actions, never buried.
3. **One workspace, end to end.** The story, conversation, worktree, preview, diff and merge stay connected. Avoid flows that send the user to another tool to finish the job.
4. **Solo first, team-ready.** Design for one developer running several agents in parallel; keep review and status legible enough that a second person could pick them up.
5. **Your providers, your code.** Bring-your-own models, local-first execution and an open-source core. Premium sells hosted convenience, never lock-in.
