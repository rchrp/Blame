import {
  ArrowUpRight,
  BadgeCheck,
  BookOpenText,
  FileSearch,
  ShieldCheck,
  SquareTerminal,
} from "lucide-react";
import { ScrollReveal } from "@/components/scroll-reveal";
import { harnessSourceUrl } from "@/lib/github";

// Built from docs/semantic-harness-study.tex by `pnpm build:study-pdf`.
const harnessStudyPdfPath = "/research/light-semantic-harness-study.pdf";

// Panel F61 of the study: audited successes and total tokens against Cline.
const harnessResults = [
  { value: "6/6", label: "Tasks completed, same as Cline" },
  { value: "54%", label: "Fewer tokens than Cline" },
];

const harnessTools = [
  { tool: "search_code", label: "Navigates by structure", icon: FileSearch },
  { tool: "read_code", label: "Reads before editing", icon: BookOpenText },
  { tool: "edit_code", label: "Refuses stale edits", icon: ShieldCheck },
  { tool: "run_task", label: "Records every check", icon: SquareTerminal },
  { tool: "finish_task", label: "Finishes verified", icon: BadgeCheck },
];

export function HarnessSection() {
  return (
    <section
      id="harness"
      aria-labelledby="harness-title"
      className="scroll-mt-24 border-t-[24px] border-[#1d1d1f] bg-black px-5 py-32 sm:border-t-[32px] sm:px-8 sm:py-40 lg:border-t-[48px] lg:px-10 lg:py-48"
    >
      <div className="mx-auto max-w-7xl">
        <ScrollReveal className="text-center">
          <p className="story-eyebrow">Light Semantic Harness</p>
          <h2 id="harness-title" className="story-title mx-auto mt-5 max-w-6xl">
            Agents that show their work.
          </h2>
          <p className="story-copy mx-auto mt-7 max-w-3xl">
            Blame’s open-source harness makes every agent read before it edits
            and prove each check it runs.
          </p>
        </ScrollReveal>
        <HarnessResults />
        <HarnessTools />
        <HarnessFootnote />
      </div>
    </section>
  );
}

function HarnessResults() {
  return (
    <dl className="mx-auto mt-20 grid max-w-4xl grid-cols-2 lg:mt-28">
      {harnessResults.map((result, index) => (
        <ScrollReveal
          key={result.value}
          delay={index * 120}
          className="border-white/12 px-2 text-center even:border-l"
        >
          <dt className="sr-only">{result.label}</dt>
          <dd className="font-display text-[clamp(4.25rem,12vw,10rem)] leading-none text-white">
            {result.value}
          </dd>
          <dd className="mt-4 text-sm text-white/56 sm:text-lg">
            {result.label}
          </dd>
        </ScrollReveal>
      ))}
    </dl>
  );
}

function HarnessTools() {
  return (
    <ol className="mx-auto mt-20 grid max-w-6xl gap-x-6 gap-y-5 border-t border-white/12 pt-10 lg:mt-28 lg:grid-cols-5 lg:pt-12">
      {harnessTools.map(({ icon: Icon, label, tool }, index) => (
        <li key={tool}>
          <ScrollReveal
            delay={index * 70}
            className="flex items-center gap-3 lg:flex-col lg:gap-0 lg:text-center"
          >
            <Icon className="size-5 shrink-0 text-[#9fd7ff]" />
            <code className="font-mono text-sm text-white/86 lg:mt-5">
              {tool}
            </code>
            <span className="text-sm text-white/48 lg:mt-1.5">{label}</span>
          </ScrollReveal>
        </li>
      ))}
    </ol>
  );
}

function HarnessFootnote() {
  return (
    <ScrollReveal delay={120}>
      <div className="mx-auto mt-16 flex max-w-4xl flex-col items-center gap-4 text-center lg:mt-20">
        <p className="text-xs leading-5 text-white/40">
          Panel F61, October 2026: new cross-module TypeScript tasks, audited
          by hand, on the same model as Cline. 39% lower estimated cost.
        </p>
        <div className="flex flex-wrap justify-center gap-x-7 gap-y-2 text-sm">
          <FootnoteLink href={harnessStudyPdfPath}>Read the study</FootnoteLink>
          <FootnoteLink href={harnessSourceUrl}>Browse the source</FootnoteLink>
        </div>
      </div>
    </ScrollReveal>
  );
}

function FootnoteLink({ children, href }: { children: string; href: string }) {
  return (
    <a
      href={href}
      className="group inline-flex items-center gap-1 text-white/72 underline decoration-white/20 underline-offset-4 transition hover:text-white hover:decoration-white/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
    >
      {children}
      <ArrowUpRight className="size-3.5 transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
    </a>
  );
}
