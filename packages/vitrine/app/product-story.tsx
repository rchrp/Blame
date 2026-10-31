import Image from "next/image";
import Link from "next/link";
import type { CSSProperties } from "react";
import {
  ArrowRight,
  Check,
  FileDiff,
  GitBranch,
  GitMerge,
  KeyRound,
  ListChecks,
  MessagesSquare,
  MonitorPlay,
  ServerCog,
  Sparkles,
  Workflow,
} from "lucide-react";
import { AnimatedBorderFrame } from "@/components/animated-border/animated-border-frame";
import { HighlightsCarousel } from "@/components/highlights-carousel";
import { PipelineBacklogMockup } from "@/components/blame-mockups/backlog-mockup";
import { LivePreviewMockup } from "@/components/blame-mockups/preview-mockup";
import { ProjectCreationMockup } from "@/components/blame-mockups/project-creation-mockup";
import {
  projectCreationAccentClassName,
  projectCreationPanelClassName,
} from "@/components/project-creation-theme";
import {
  parallelAgentProviders,
  ProviderLogo,
} from "@/components/provider-logos";
import { CodePracticesCarousel } from "@/components/code-practices-carousel";
import { ScrollReveal } from "@/components/scroll-reveal";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { GitHubMark } from "@/components/github-stars";
import { githubRepositoryUrl } from "@/lib/github";
import { HarnessSection } from "./harness-story";
import { FinalCtaScene } from "./scene/final-cta-scene";

const workspaceSignals = [
  { title: "Worktree ready", icon: GitBranch },
  { title: "Environment synced", icon: Check },
  { title: "Preview attached", icon: MonitorPlay },
];

const specialistAgents = [
  {
    title: "Codebase Analyst",
    description: "Finds the right context.",
    image: "/agents/codebase-analyst.png",
    tone: "oklch(0.78 0.16 195)",
    glow: "oklch(0.72 0.19 195 / 28%)",
  },
  {
    title: "Story Analyst",
    description: "Tightens the brief.",
    image: "/agents/story-analyst.png",
    tone: "oklch(0.72 0.22 300)",
    glow: "oklch(0.67 0.23 300 / 28%)",
  },
  {
    title: "Frontend Design Specialist",
    description: "Refines the interface.",
    image: "/agents/frontend-design-specialist.png",
    tone: "oklch(0.75 0.23 350)",
    glow: "oklch(0.7 0.24 350 / 28%)",
  },
  {
    title: "Test & Verification Analyst",
    description: "Plans the proof.",
    image: "/agents/test-verification-analyst.png",
    tone: "oklch(0.76 0.2 145)",
    glow: "oklch(0.7 0.2 145 / 28%)",
  },
  {
    title: "Risk & Review Analyst",
    description: "Challenges merge readiness.",
    image: "/agents/risk-review-analyst.png",
    tone: "oklch(0.78 0.19 55)",
    glow: "oklch(0.72 0.2 55 / 28%)",
  },
];

const cloudContinuityItems = [
  {
    title: "Stories & conversations",
    description:
      "Every user story and its full conversation history stays linked to the project.",
    icon: MessagesSquare,
  },
  {
    title: "Code practices & preferences",
    description:
      "Your enabled practices and project preferences return exactly as you set them.",
    icon: ListChecks,
  },
  {
    title: "Provider connections",
    description:
      "Tokens and OAuth connections stay ready, so each provider works without another setup.",
    icon: KeyRound,
  },
  {
    title: "MCP configurations",
    description:
      "Every configured MCP server is restored when you move to another computer.",
    icon: ServerCog,
  },
];

const reviewActions = [
  { label: "Review the evidence", icon: FileDiff },
  { label: "Request another pass", icon: Workflow },
  { label: "Approve and merge", icon: GitMerge },
];

export function ProductStory() {
  return (
    <div className="relative z-10 -mt-[48vh] bg-[#1d1d1f]">
      <HeroFadeOut />
      <StoryOpening />
      <HighlightsCarousel />
      <WorkflowSection />
      <WorkspaceSection />
      <HarnessSection />
      <PreviewSection />
      <ParallelAgentsSection />
      <PracticesSection />
      <SpecialistsSection />
      <CloudContinuitySection />
      <ProjectCreationSection />
      <FinalCtaSection />
    </div>
  );
}

// This page slides over the pinned hero; fade its top edge into the hero
// instead of cutting the mockup with a hard black band.
function HeroFadeOut() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 bottom-full h-[45vh] bg-[linear-gradient(to_bottom,rgb(5_5_5/0%)_0%,rgb(5_5_5/18%)_30%,rgb(5_5_5/55%)_62%,rgb(5_5_5/88%)_86%,#050505_100%)]"
    />
  );
}

function StoryOpening() {
  return (
    <section className="flex min-h-[100svh] items-center bg-[#050505] px-5 py-24 sm:px-8 sm:py-32 lg:px-10 lg:py-40">
      <div className="mx-auto w-full max-w-7xl">
        <ScrollReveal>
          <p className="story-eyebrow">Beyond the prompt</p>
        </ScrollReveal>
        <ScrollReveal delay={90} distance={36}>
          <h2 className="mt-7 max-w-5xl text-balance text-[clamp(2.625rem,5.5vw,5.625rem)] font-semibold leading-none text-white">
            <span className="text-[#86868b]">AI can write the code. </span>
            Blame makes it shippable.
          </h2>
        </ScrollReveal>
        <ScrollReveal delay={180}>
          <p className="story-copy mt-9 max-w-3xl text-balance">
            Turn an idea into a user story, give it an isolated workspace, see
            it run, review every change, then decide what ships.
          </p>
        </ScrollReveal>
      </div>
    </section>
  );
}

function WorkflowSection() {
  return (
    <section
      id="workflow"
      aria-labelledby="workflow-title"
      className="scroll-mt-24 border-t-[24px] border-[#1d1d1f] bg-black px-5 py-32 sm:border-t-[32px] sm:px-8 sm:py-40 lg:border-t-[48px] lg:px-10 lg:py-48"
    >
      <div className="mx-auto max-w-7xl">
        <WorkflowHeading />
        <ScrollReveal delay={110} className="mt-20 sm:mt-28">
          <PipelineBacklogMockup />
        </ScrollReveal>
        <ScrollReveal delay={160}>
          <p className="story-copy mx-auto mt-12 max-w-4xl text-center sm:mt-16">
            Write the outcome once and Blame turns it into a durable lane for
            the entire development cycle. The brief, relevant context, agent
            activity, implementation state, review notes, and final decision
            stay attached to the same story, from the first backlog draft to the
            merge you approve.
          </p>
        </ScrollReveal>
      </div>
    </section>
  );
}

function WorkflowHeading() {
  return (
    <ScrollReveal className="text-center">
      <div>
        <p className="story-eyebrow">The backlog</p>
        <h2 id="workflow-title" className="story-title mx-auto mt-5 max-w-5xl">
          Every request gets a lane.
        </h2>
      </div>
    </ScrollReveal>
  );
}

function WorkspaceSection() {
  return (
    <section className="bg-[#1d1d1f] px-3 py-24 sm:px-6 sm:py-32 lg:px-8 lg:py-40">
      <ScrollReveal className="mx-auto max-w-[1480px]" distance={0}>
        <AnimatedBorderFrame
          className="user-story-state-effect rounded-[2rem] sm:rounded-[3rem]"
          effect="story-progress"
        >
          <div className="relative z-[1] min-h-[680px] overflow-hidden rounded-[2rem] border border-white/10 sm:min-h-[760px] sm:rounded-[3rem]">
            <WorkspacePhoto />
            <div className="absolute inset-x-0 bottom-0 z-10 p-8 sm:p-14 lg:p-20">
              <p className="story-eyebrow">Isolated by default</p>
              <h2 className="mt-5 max-w-5xl text-balance text-[clamp(2.375rem,4.8vw,4.75rem)] font-semibold leading-[1.02] text-white">
                One story. Its own{" "}
                <span className="workspace-smart-sweep">
                  smart workspace.
                </span>
              </h2>
              <p className="section-subtitle mt-8 max-w-3xl text-white/68">
                Blame automatically analyzes your project, determines what the
                story needs, and prepares a dedicated branch, worktree,
                environment, port, and local runtime before implementation
                starts.
              </p>
              <WorkspaceSignals />
            </div>
          </div>
        </AnimatedBorderFrame>
      </ScrollReveal>
    </section>
  );
}

function WorkspacePhoto() {
  return (
    <>
      <Image
        src="/home-illustrations/1.jpg"
        alt=""
        fill
        sizes="(max-width: 768px) 100vw, 1480px"
        className="object-cover grayscale-[0.25]"
      />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(5,5,5,0.68)_0%,rgba(5,5,5,0.12)_24%,rgba(5,5,5,0.2)_42%,rgba(5,5,5,0.96)_100%)]" />
    </>
  );
}

function WorkspaceSignals() {
  return (
    <ul className="mt-12 grid max-w-3xl gap-px overflow-hidden rounded-2xl border border-white/14 bg-white/14 sm:grid-cols-3">
      {workspaceSignals.map(({ icon: Icon, title }) => (
        <li
          key={title}
          className="flex items-center gap-3 bg-[#090b0f]/78 px-5 py-4 text-sm text-white/78 backdrop-blur-xl"
        >
          <Icon className="h-4 w-4 text-[#9fd7ff]" />
          {title}
        </li>
      ))}
    </ul>
  );
}

function PreviewSection() {
  return (
    <section className="overflow-hidden border-t-[24px] border-[#1d1d1f] bg-[linear-gradient(180deg,#000_0%,#000_76%,#101012_100%)] px-5 py-32 sm:border-t-[32px] sm:px-8 sm:py-40 lg:border-t-[48px] lg:px-10 lg:py-48">
      <div className="mx-auto max-w-7xl">
        <PreviewHeading />
        <ScrollReveal delay={120} className="mt-20 sm:mt-28">
          <LivePreviewMockup />
        </ScrollReveal>
        <ReviewStory />
      </div>
    </section>
  );
}

function PreviewHeading() {
  return (
    <ScrollReveal className="text-center">
      <p className="story-eyebrow">Live preview</p>
      <h2 className="story-title mx-auto mt-5 max-w-6xl">
        See each isolated worktree in action.
      </h2>
      <p className="story-copy mx-auto mt-7 max-w-3xl">
        Open the running app beside the story. Inspect files, terminal output,
        and every change without chasing branches, ports, or browser tabs.
      </p>
    </ScrollReveal>
  );
}

function ReviewStory() {
  return (
    <div className="mt-24 grid gap-16 border-t border-white/12 pt-16 sm:mt-32 lg:grid-cols-[1fr_0.85fr] lg:gap-24 lg:pt-20">
      <ScrollReveal>
        <p className="story-eyebrow">Human decision</p>
        <h3 className="mt-5 max-w-2xl text-balance text-[clamp(2.125rem,3.6vw,3.5rem)] font-semibold leading-[1.04]">
          Your call, all the way to merge.
        </h3>
      </ScrollReveal>
      <ScrollReveal delay={100}>
        <p className="story-copy">
          Request changes, reject the work, or approve and merge when it earns
          it. The agent moves fast. The decision stays yours.
        </p>
        <ReviewActions />
      </ScrollReveal>
    </div>
  );
}

function ReviewActions() {
  return (
    <ul className="mt-10 divide-y divide-white/10 border-y border-white/10">
      {reviewActions.map(({ icon: Icon, label }) => (
        <li key={label} className="flex items-center gap-4 py-4">
          <Icon className="h-5 w-5 text-white/42" />
          <span className="text-white/78">{label}</span>
        </li>
      ))}
    </ul>
  );
}

function ParallelAgentsSection() {
  return (
    <section
      id="parallel-agents"
      aria-labelledby="parallel-agents-title"
      className="border-y-[24px] border-[#1d1d1f] bg-black px-5 py-32 sm:border-y-[32px] sm:px-8 sm:py-40 lg:border-y-[48px] lg:px-10 lg:py-48"
    >
      <div className="mx-auto max-w-7xl">
        <ScrollReveal className="text-center">
          <p className="story-eyebrow">Parallel agents</p>
          <h2
            id="parallel-agents-title"
            className="story-title mx-auto mt-5 max-w-6xl"
          >
            Run every agent on the model that fits.
          </h2>
          <p className="story-copy mx-auto mt-7 max-w-3xl">
            Launch multiple agents in parallel, even across different
            providers. Blame supports 50 AI providers, so every task can use the
            model that fits it best.
          </p>
        </ScrollReveal>
        <ProviderRail />
      </div>
    </section>
  );
}

function ProviderRail() {
  return (
    <div className="mt-20 lg:mt-28">
      <ul className="mx-auto grid max-w-4xl grid-cols-3 gap-x-10 gap-y-14 sm:gap-x-20 sm:gap-y-20">
        {parallelAgentProviders.map((provider, index) => (
          <li key={provider.name}>
            <ScrollReveal delay={index * 60} className="flex justify-center">
              <ProviderLogo
                provider={provider}
                className="size-12 text-white sm:size-16"
              />
            </ScrollReveal>
          </li>
        ))}
      </ul>
      <ScrollReveal delay={360}>
        <p className="mt-14 text-center text-sm text-white/46 sm:mt-20 sm:text-base">
          + any OpenAI-compatible API
        </p>
      </ScrollReveal>
    </div>
  );
}

function PracticesSection() {
  return (
    <section className="bg-[#1d1d1f] px-3 py-24 sm:px-6 sm:py-32 lg:px-8 lg:py-40">
      <ScrollReveal className="mx-auto max-w-[1480px]" distance={0}>
        <div className="overflow-hidden rounded-[2rem] bg-[#eef0ff] text-[#11131a] ring-1 ring-black/[0.04] sm:rounded-[3rem]">
          <div className="grid gap-16 p-8 sm:p-14 lg:grid-cols-[0.68fr_1.32fr] lg:items-center lg:p-20 xl:p-24">
            <PracticesCopy />
            <CodePracticesCarousel />
          </div>
        </div>
      </ScrollReveal>
    </section>
  );
}

function PracticesCopy() {
  return (
    <div>
      <p className="text-[clamp(1.0625rem,1.7vw,1.5rem)] leading-[1.2] text-[#3545ad]">
        Code practices
      </p>
      <h2 className="mt-5 text-balance text-[clamp(2.125rem,3.1vw,3.25rem)] font-semibold leading-[1.04]">
        Every agent codes like a pro.
      </h2>
      <p className="section-subtitle mt-8 max-w-xl text-[#11131a]/62">
        Blame holds every implementation to professional engineering standards:
        clean code, verified changes, sound architecture, and a commit history
        your team can trust.
      </p>
    </div>
  );
}

function SpecialistsSection() {
  return (
    <section className="border-y-[24px] border-[#1d1d1f] bg-black px-5 py-32 sm:border-y-[32px] sm:px-8 sm:py-40 lg:border-y-[48px] lg:px-10 lg:py-48">
      <div className="mx-auto max-w-7xl">
        <SpecialistsHeading />
        <AgentRail />
      </div>
    </section>
  );
}

function SpecialistsHeading() {
  return (
    <div className="grid gap-12 lg:grid-cols-[1fr_0.65fr] lg:items-end">
      <ScrollReveal>
        <p className="story-eyebrow">Specialist agents</p>
        <h2 className="story-title mt-5 max-w-5xl">
          More perspective. Only when it matters.
        </h2>
      </ScrollReveal>
      <ScrollReveal delay={100}>
        <p className="story-copy max-w-xl lg:pb-2">
          Focused specialists sharpen context, interface quality, verification,
          and risk. One lead agent stays responsible for the implementation.
        </p>
      </ScrollReveal>
    </div>
  );
}

function AgentRail() {
  return (
    <div className="mt-20 grid gap-4 sm:grid-cols-2 lg:mt-28 lg:grid-cols-5">
      {specialistAgents.map((agent, index) => (
        <ScrollReveal key={agent.title} delay={index * 70}>
          <article
            className="specialist-card group flex min-h-64 flex-col justify-between rounded-3xl border border-white/10 bg-white/[0.045] p-5 transition duration-300 hover:-translate-y-1 hover:bg-white/[0.075] sm:min-h-72 sm:p-6"
            style={specialistCardStyle(agent)}
          >
            <AgentPortrait agent={agent} />
            <div>
              <h3 className="text-lg font-semibold leading-tight text-white">
                {agent.title}
              </h3>
              <p className="mt-2 text-sm leading-6 text-white/48">
                {agent.description}
              </p>
            </div>
          </article>
        </ScrollReveal>
      ))}
    </div>
  );
}

function AgentPortrait({
  agent,
}: {
  agent: (typeof specialistAgents)[number];
}) {
  return (
    <Avatar className="size-18">
      <AvatarImage
        src={agent.image}
        alt=""
        style={{ imageRendering: "pixelated" }}
      />
      <AvatarFallback aria-label={agent.title}>A</AvatarFallback>
    </Avatar>
  );
}

function specialistCardStyle(agent: (typeof specialistAgents)[number]) {
  return {
    "--agent-response-color": agent.tone,
    "--agent-response-glow-color": agent.glow,
  } as CSSProperties;
}

function CloudContinuitySection() {
  return (
    <section className="bg-[#1d1d1f] px-5 py-32 sm:px-8 sm:py-40 lg:px-10 lg:py-48">
      <div className="mx-auto max-w-7xl">
        <ScrollReveal className="text-center">
          <p className="story-eyebrow">Blame Cloud</p>
          <h2 className="story-title mx-auto mt-5 max-w-6xl">
            Change computers. Keep every detail.
          </h2>
          <p className="story-copy mx-auto mt-7 max-w-3xl">
            Open the same project on another computer and Blame restores the
            context around it. No rebuilding your workflow from scratch.
          </p>
        </ScrollReveal>
        <CloudContinuityPanel />
      </div>
    </section>
  );
}

function CloudContinuityPanel() {
  return (
    <ScrollReveal delay={120} className="mx-auto mt-20 max-w-5xl lg:mt-28">
      <div className="overflow-hidden rounded-[2rem] border border-white/12 bg-[#0a0a0c] shadow-[0_24px_80px_rgba(0,0,0,0.28)]">
        <ul className="grid sm:grid-cols-2">
          {cloudContinuityItems.map((item) => (
            <CloudContinuityItem key={item.title} item={item} />
          ))}
        </ul>
      </div>
    </ScrollReveal>
  );
}

function CloudContinuityItem({
  item,
}: {
  item: (typeof cloudContinuityItems)[number];
}) {
  const Icon = item.icon;

  return (
    <li className="border-b border-white/10 p-8 last:border-b-0 sm:border-r sm:p-10 sm:even:border-r-0 sm:[&:nth-last-child(-n+2)]:border-b-0">
      <Icon className="size-6 text-[#9fd7ff]" />
      <h4 className="mt-6 text-xl font-semibold text-white">
        {item.title}
      </h4>
      <p className="mt-3 text-sm leading-6 text-white/48">
        {item.description}
      </p>
    </li>
  );
}

function ProjectCreationSection() {
  return (
    <section className="bg-black px-3 pb-24 pt-24 sm:px-6 sm:pb-32 sm:pt-32 lg:px-8 lg:pb-40 lg:pt-40">
      <ScrollReveal className="mx-auto max-w-[1480px]" distance={0}>
        <div
          className={`overflow-hidden rounded-[2rem] ring-1 ring-white/[0.08] sm:rounded-[3rem] ${projectCreationPanelClassName}`}
        >
          <div className="grid gap-16 p-8 sm:p-14 lg:grid-cols-[0.68fr_1.32fr] lg:items-center lg:p-20 xl:p-24">
            <ProjectCreationCopy />
            <ProjectCreationImage />
          </div>
        </div>
      </ScrollReveal>
    </section>
  );
}

function ProjectCreationCopy() {
  return (
    <div>
      <p
        className={`text-[clamp(1.0625rem,1.7vw,1.5rem)] leading-[1.2] ${projectCreationAccentClassName}`}
      >
        Project creation
      </p>
      <h2 className="mt-5 text-balance text-[clamp(2.125rem,3.1vw,3.25rem)] font-semibold leading-[1.04]">
        From empty folder to agent-ready
      </h2>
      <p className="section-subtitle mt-8 max-w-lg text-white/62">
        Choose a web stack. Blame generates the structure, tooling, environment
        files, and preview configuration inside the same workflow.
      </p>
    </div>
  );
}

function ProjectCreationImage() {
  return (
    <div className="overflow-hidden lg:translate-x-8 xl:translate-x-12">
      <ProjectCreationMockup />
    </div>
  );
}

function FinalCtaSection() {
  return (
    <section className="relative isolate flex min-h-[100svh] items-center overflow-hidden bg-black px-5 py-32 sm:px-8 sm:py-40 lg:px-10">
      <FinalCtaBackdrop />
      <ScrollReveal className="relative z-10 mx-auto w-full max-w-7xl text-center">
        <p className="story-eyebrow">Free and open source</p>
        <h2 className="mx-auto mt-6 max-w-5xl text-balance text-[clamp(2.625rem,5.5vw,5.625rem)] font-semibold leading-none text-white">
          Let agents move fast. Keep the final say.
        </h2>
        <p className="story-copy mx-auto mt-10 max-w-2xl text-white/62">
          Available for macOS, Windows, and Linux. Bring the AI provider you
          already use, and read every line of the code it runs on.
        </p>
        <FinalCtaActions />
        <Link
          href="/pricing"
          className="mt-8 inline-block text-sm text-white/56 underline decoration-white/20 underline-offset-4 transition hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
        >
          Compare the free core and Blame Premium
        </Link>
      </ScrollReveal>
    </section>
  );
}

function FinalCtaBackdrop() {
  return (
    <div className="absolute inset-0 -z-10 overflow-hidden bg-black">
      <FinalCtaScene />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_48%,rgba(0,0,0,0.16)_0%,rgba(0,0,0,0.42)_52%,#050505_92%),linear-gradient(180deg,#050505_0%,rgba(5,5,5,0.3)_34%,rgba(5,5,5,0.72)_100%)]" />
    </div>
  );
}

function FinalCtaActions() {
  return (
    <div className="mt-12 flex flex-col items-center justify-center gap-3 sm:flex-row">
      <Link
        href="/download"
        className="group inline-flex min-h-14 items-center justify-center gap-2.5 rounded-full bg-white px-7 py-4 text-base text-[#080808] shadow-[0_18px_60px_rgba(255,255,255,0.2)] transition duration-200 hover:-translate-y-0.5 hover:bg-[#dfe7ff] focus:outline-none focus:ring-2 focus:ring-white/60 focus:ring-offset-2 focus:ring-offset-[#050505]"
      >
        Download Blame
        <ArrowRight className="h-5 w-5 transition duration-200 group-hover:translate-x-0.5" />
      </Link>
      <FinalCtaGitHubLink />
    </div>
  );
}

function FinalCtaGitHubLink() {
  return (
    <a
      href={githubRepositoryUrl}
      className="group inline-flex min-h-14 items-center justify-center gap-2.5 rounded-full border border-white/14 bg-white/[0.07] px-7 py-4 text-base text-white/90 backdrop-blur-md transition duration-200 hover:-translate-y-0.5 hover:bg-white/[0.11] focus:outline-none focus:ring-2 focus:ring-white/45 focus:ring-offset-2 focus:ring-offset-[#050505]"
    >
      <GitHubMark className="size-5 shrink-0" />
      Star on GitHub
    </a>
  );
}
