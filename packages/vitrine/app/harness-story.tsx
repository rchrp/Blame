import { ArrowUpRight } from "lucide-react";
import { HarnessTrace } from "@/components/harness-trace";
import { ScrollReveal } from "@/components/scroll-reveal";
import { harnessSourceUrl } from "@/lib/github";

// Built from docs/semantic-harness-study.tex by `pnpm build:study-pdf`.
const harnessStudyPdfPath = "/research/light-semantic-harness-study.pdf";

// Panel F61 of docs/semantic-harness-study.tex: audited successes and total
// tokens per arm over the same six runs.
const benchmarkMetrics = [
  {
    label: "Tasks completed, audited by hand",
    rows: [
      { name: "Blame harness", value: "6/6", share: 1, isBlame: true },
      { name: "Cline", value: "6/6", share: 1, isBlame: false },
    ],
  },
  {
    label: "Tokens used across the panel",
    rows: [
      { name: "Blame harness", value: "1.79M", share: 1_786_607 / 3_898_754, isBlame: true },
      { name: "Cline", value: "3.90M", share: 1, isBlame: false },
    ],
  },
];

export function HarnessSection() {
  return (
    <section
      id="harness"
      aria-labelledby="harness-title"
      className="scroll-mt-24 border-t-[24px] border-[#1d1d1f] bg-black px-5 py-32 sm:border-t-[32px] sm:px-8 sm:py-40 lg:border-t-[48px] lg:px-10 lg:py-48"
    >
      <div className="mx-auto max-w-7xl">
        <HarnessHeading />
        <ScrollReveal delay={120} className="mt-20 lg:mt-28">
          <HarnessTrace />
        </ScrollReveal>
        <HarnessProof />
      </div>
    </section>
  );
}

function HarnessHeading() {
  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_0.75fr] lg:items-end lg:gap-16">
      <ScrollReveal>
        <p className="story-eyebrow">Light Semantic Harness</p>
        <h2 id="harness-title" className="story-title mt-5 max-w-4xl">
          Agents that show their work.
        </h2>
      </ScrollReveal>
      <ScrollReveal delay={100}>
        <p className="story-copy max-w-xl lg:pb-2">
          Most coding agents grep, rewrite whole files, then tell you it should
          work now. Blame’s open-source harness gives every agent five guarded
          tools: it finds code by its structure, edits only what it has read,
          and keeps a record of every check it runs.
        </p>
      </ScrollReveal>
    </div>
  );
}

function HarnessProof() {
  return (
    <div className="mt-24 grid gap-14 border-t border-white/12 pt-16 sm:mt-32 lg:grid-cols-[1fr_1fr] lg:gap-24 lg:pt-20">
      <ScrollReveal>
        <p className="story-eyebrow">Measured in the open</p>
        <h3 className="mt-5 max-w-xl text-balance text-[clamp(2.125rem,3.6vw,3.5rem)] font-semibold leading-[1.04] text-white">
          <span className="block">6/6 tasks.</span>
          <span className="block">54% fewer tokens.</span>
        </h3>
        <p className="story-copy mt-7 max-w-xl">
          On fresh cross-module TypeScript tasks, audited by hand, Blame’s
          harness matched Cline’s 6/6 while using less than half the tokens,
          at a 39% lower estimated cost.
        </p>
        <div className="mt-9 flex flex-wrap gap-x-7 gap-y-3 text-sm">
          <ProofLink href={harnessStudyPdfPath}>Read the study (PDF)</ProofLink>
          <ProofLink href={harnessSourceUrl}>Browse the harness source</ProofLink>
        </div>
      </ScrollReveal>
      <ScrollReveal delay={100}>
        <BenchmarkBars />
        <p className="mt-10 max-w-xl text-xs leading-5 text-white/40">
          Panel F61, October 2026: three new cross-module requests on the
          TS-Pattern codebase, two runs each, with gpt-5.6-luna at high effort,
          compared with Cline’s agent harness on the same model. Figures hold
          for these versions and conditions.
        </p>
      </ScrollReveal>
    </div>
  );
}

function ProofLink({ children, href }: { children: string; href: string }) {
  return (
    <a
      href={href}
      className="group inline-flex items-center gap-1.5 text-white/86 underline decoration-white/24 underline-offset-[6px] transition hover:text-white hover:decoration-white/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/45"
    >
      {children}
      <ArrowUpRight className="size-4 transition group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
    </a>
  );
}

function BenchmarkBars() {
  return (
    <figure className="space-y-10">
      <figcaption className="sr-only">
        Blame harness compared with Cline on panel F61
      </figcaption>
      {benchmarkMetrics.map((metric) => (
        <div key={metric.label}>
          <p className="text-sm text-white/56">{metric.label}</p>
          <dl className="mt-4 space-y-3 border-l border-white/16">
            {metric.rows.map((row) => (
              <div
                key={row.name}
                className="grid grid-cols-[minmax(0,1fr)_3.5rem] items-center gap-x-4 gap-y-1.5 pl-px sm:grid-cols-[7.5rem_minmax(0,1fr)_3.5rem]"
              >
                <dt className="col-span-2 pl-3 text-sm text-white/72 sm:col-span-1">
                  {row.name}
                </dt>
                <dd className="flex min-w-0 items-center">
                  <span
                    className={`block h-5 rounded-r-[4px] ${row.isBlame ? "bg-[#9fd7ff]" : "bg-white/22"}`}
                    style={{ width: `${row.share * 100}%` }}
                  />
                </dd>
                <dd
                  className={`text-right text-sm tabular-nums ${row.isBlame ? "text-white" : "text-white/56"}`}
                >
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </figure>
  );
}
