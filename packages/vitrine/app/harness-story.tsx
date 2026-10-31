import { ArrowUpRight, CircleCheck } from "lucide-react";
import type { ReactNode } from "react";
import { HarnessShowcase } from "@/components/harness-showcase";
import { SavingsCountUp } from "@/components/savings-count-up";
import { ScrollReveal } from "@/components/scroll-reveal";
import { harnessSourceUrl } from "@/lib/github";

// Built from docs/semantic-harness-study.tex by `pnpm build:study-pdf`.
const harnessStudyPdfPath = "/research/light-semantic-harness-study.pdf";

// Panel F61 of the study: 54.2% fewer tokens than Cline, both at 6/6.
const tokenSavingPercent = 54;

export function HarnessSection({
  showcase = <HarnessShowcase />,
}: {
  showcase?: ReactNode;
}) {
  return (
    <section
      id="harness"
      aria-labelledby="harness-title"
      className="scroll-mt-24 border-t-[24px] border-[#1d1d1f] bg-black px-5 py-32 sm:border-t-[32px] sm:px-8 sm:py-40 lg:border-t-[48px] lg:px-10 lg:py-48"
    >
      <div className="mx-auto max-w-7xl">
        <ScrollReveal className="text-center">
          <p className="story-eyebrow">Light Semantic Harness</p>
          <h2 id="harness-title" className="story-title mx-auto mt-5 max-w-5xl">
            Sharper tools. Smaller bills.
          </h2>
          <p className="story-copy mx-auto mt-5 max-w-3xl">
            Same model, different harness. Blame’s agents find code by its
            structure, read only what they need, and edit only what they’ve
            read.
          </p>
        </ScrollReveal>
        <HarnessSaving />
        <div className="mt-12 lg:mt-14">{showcase}</div>
      </div>
    </section>
  );
}

function HarnessSaving() {
  return (
    <ScrollReveal className="mt-8 text-center lg:mt-10">
      <p className="font-display text-[clamp(3.5rem,7vw,6rem)] leading-none">
        <SavingsCountUp value={tokenSavingPercent} />
      </p>
      <p className="mt-2 text-balance text-base text-white/72 sm:text-xl">
        tokens vs. Cline, same model, same tasks
      </p>
      <p className="mt-4 inline-flex items-center gap-2 text-sm text-white/56">
        <CircleCheck className="size-4 text-[oklch(0.8_0.17_150)]" />
        No quality lost: 6/6 audited runs, same as Cline.
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-x-7 gap-y-2 text-sm">
        <StudyLink href={harnessStudyPdfPath}>Read the study</StudyLink>
        <StudyLink href={harnessSourceUrl}>Browse the source</StudyLink>
      </div>
    </ScrollReveal>
  );
}

function StudyLink({ children, href }: { children: string; href: string }) {
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
