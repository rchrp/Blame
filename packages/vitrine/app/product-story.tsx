import type { CSSProperties, ReactNode } from "react";
import Image from "next/image";
import { KeyRound, ListChecks, MessagesSquare, ServerCog } from "lucide-react";
import {
  parallelAgentProviders,
  ProviderLogo,
} from "@/components/provider-logos";
import { FullDemoSection } from "@/components/demo-video";
import { ScrollReveal } from "@/components/scroll-reveal";
import { BacklogScene } from "@/components/story/backlog-scene";
import { CreationScene } from "@/components/story/creation-scene";
import { CtaScene } from "@/components/story/cta-scene";
import { MergeScene } from "@/components/story/merge-scene";
import { OpeningScene } from "@/components/story/opening-scene";
import { PracticesScene } from "@/components/story/practices-scene";
import { WorkspaceScene } from "@/components/story/workspace-scene";
import { fullDemoVideo } from "@/lib/demo-media";
import { HarnessSection } from "./harness-story";

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

// The page opens on the problem it solves (parallel agents share one running
// app), then what each story gets (its own branch, worktree, ports and
// containers), then one section per step of a story's life (backlog lane,
// harness, review and merge), the full demo once it is on (see
// lib/demo-media.ts), what surrounds it, and the end card.
export function ProductStory() {
  return (
    <div className="relative z-10 -mt-[48vh]">
      <OpeningSection />
      <SceneSection id="workspace">
        <WorkspaceScene />
      </SceneSection>
      <SceneSection id="workflow">
        <BacklogScene />
      </SceneSection>
      <HarnessSection />
      <SceneSection id="review">
        <MergeScene />
      </SceneSection>
      <FullDemoSection video={fullDemoVideo} />
      <ParallelAgentsSection />
      <SceneSection id="practices">
        <PracticesScene />
      </SceneSection>
      <SpecialistsSection />
      <CloudContinuitySection />
      <SceneSection id="project-creation">
        <CreationScene />
      </SceneSection>
      <FinalCtaSection />
    </div>
  );
}

function OpeningSection() {
  return (
    <section
      id="opening"
      data-story-section
      className="flex min-h-[100svh] flex-col justify-center px-5 py-24 sm:px-8 lg:px-10"
    >
      <div className="w-full" data-story-fit>
        <OpeningScene />
      </div>
    </section>
  );
}

// One full-screen step of the story. Its scene pins it while the animation
// plays, and StoryScroll settles the page on its top.
function SceneSection({
  children,
  id,
}: {
  children: ReactNode;
  id: string;
}) {
  return (
    <section
      id={id}
      data-story-section
      className="flex min-h-[100svh] flex-col justify-center px-5 py-24 sm:px-8 lg:px-10"
    >
      <div className="w-full" data-story-fit>
        {children}
      </div>
    </section>
  );
}

function ParallelAgentsSection() {
  return (
    <section
      id="parallel-agents"
      aria-labelledby="parallel-agents-title"
      data-story-section
      className="flex min-h-[100svh] flex-col justify-center px-5 py-24 sm:px-8 lg:px-10"
    >
      <div className="mx-auto w-full max-w-7xl">
        <ScrollReveal className="text-center">
          <p className="story-eyebrow">Parallel agents</p>
          <h2
            id="parallel-agents-title"
            className="story-title mx-auto mt-5 max-w-6xl"
          >
            Run every agent on the model that fits.
          </h2>
          <p className="story-copy mx-auto mt-7 max-w-3xl">
            Run up to three agents at once, each on its own model. Sign in with
            your Claude or ChatGPT plan, or use any of 50 AI providers with your
            own key.
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

function SpecialistsSection() {
  return (
    <section
      data-story-section
      data-fade="parts"
      className="flex min-h-[100svh] flex-col justify-center px-5 py-24 sm:px-8 lg:px-10"
    >
      <div className="mx-auto w-full max-w-7xl">
        <SpecialistsHeading />
        <AgentRail />
      </div>
    </section>
  );
}

function SpecialistsHeading() {
  return (
    <div className="story-fade-part grid gap-12 lg:grid-cols-[1fr_0.65fr] lg:items-end">
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
        <ScrollReveal
          key={agent.title}
          as="article"
          delay={index * 70}
          className="specialist-card story-fade-frosted group flex min-h-64 flex-col justify-between rounded-3xl border border-white/10 bg-white/[0.045] p-5 backdrop-blur-xl hover:-translate-y-1 hover:bg-white/[0.075] sm:min-h-72 sm:p-6"
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
    // A plain image, rendered on the server: the 32px pixel art needs no
    // optimizing, and it loads with the page instead of after hydration.
    <span className="relative flex size-18 shrink-0 overflow-hidden rounded-full">
      <Image
        src={agent.image}
        alt=""
        width={32}
        height={32}
        unoptimized
        className="aspect-square size-full object-cover"
        style={{ imageRendering: "pixelated" }}
      />
    </span>
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
    <section
      data-story-section
      className="flex min-h-[100svh] flex-col justify-center px-5 py-24 sm:px-8 lg:px-10"
    >
      <div className="mx-auto w-full max-w-7xl">
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
      <h3 className="mt-6 text-xl font-semibold text-white">
        {item.title}
      </h3>
      <p className="mt-3 text-sm leading-6 text-white/48">
        {item.description}
      </p>
    </li>
  );
}

function FinalCtaSection() {
  return (
    <section
      data-story-section
      className="relative isolate flex min-h-[100svh] items-center overflow-hidden px-5 py-24 sm:px-8 lg:px-10"
    >
      <CtaScene />
    </section>
  );
}

