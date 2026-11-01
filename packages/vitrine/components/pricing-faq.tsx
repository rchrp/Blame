import Link from "next/link";
import { Plus } from "lucide-react";

import type { FaqEntry } from "@/content/faq";

const linkClassName =
  "text-[#dedaff] underline decoration-[#b3acf3]/45 underline-offset-4 transition hover:decoration-[#dedaff] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/45";

// The pricing page's questions, as native disclosure widgets: every answer is
// in the HTML, so it reads without JavaScript and search engines index it.
export function PricingFaq({ entries }: { entries: readonly FaqEntry[] }) {
  return (
    <section
      id="faq"
      aria-labelledby="faq-title"
      className="scroll-mt-28 px-5 pb-24 sm:px-8 sm:pb-32 lg:px-10"
    >
      <div className="mx-auto w-full max-w-3xl">
        <h2
          id="faq-title"
          className="text-balance text-center text-[clamp(2.25rem,5vw,3.5rem)] font-semibold leading-[1.02] tracking-tighter text-white"
        >
          Frequently asked questions
        </h2>
        <div className="mt-12 border-t border-white/10">
          {entries.map((entry) => (
            <FaqItem key={entry.id} entry={entry} />
          ))}
        </div>
      </div>
    </section>
  );
}

function FaqItem({ entry }: { entry: FaqEntry }) {
  return (
    <details id={`faq-${entry.id}`} className="group scroll-mt-28 border-b border-white/10">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-6 rounded-lg py-6 text-left text-lg font-semibold text-white transition hover:text-white/86 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/45 [&::-webkit-details-marker]:hidden">
        {entry.question}
        <Plus
          aria-hidden="true"
          className="size-5 shrink-0 text-white/48 transition duration-200 group-open:rotate-45"
        />
      </summary>
      <div className="pb-6 pr-11 text-base leading-7 text-white/64">
        <p>{entry.answer}</p>
        {entry.link ? (
          <p className="mt-3">
            <Link className={linkClassName} href={entry.link.path}>
              {entry.link.label}
            </Link>
          </p>
        ) : null}
      </div>
    </details>
  );
}
