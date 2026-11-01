import Link from "next/link";
import { ArrowLeft, FileText } from "lucide-react";

import { SiteHeader } from "@/components/site-header";
import { buttonVariants } from "@/components/ui/button";

export function LegalPlaceholderPage({
  eyebrow,
  title,
}: {
  eyebrow: string;
  title: string;
}) {
  return (
    <main className="min-h-screen overflow-hidden bg-[#050712] text-white">
      <SiteHeader />
      <section className="relative isolate flex min-h-screen items-center px-5 pb-16 pt-28 sm:px-8 lg:px-10">
        <div className="pointer-events-none absolute inset-0 -z-20 bg-[radial-gradient(circle_at_48%_12%,rgba(179,172,243,0.14),transparent_34%),linear-gradient(180deg,#070a17_0%,#050712_72%)]" />
        <article className="mx-auto w-full max-w-4xl">
          <div className="landing-reveal landing-reveal-actions rounded-[2rem] border border-white/12 bg-white/[0.055] p-2 shadow-[0_32px_120px_rgba(0,0,0,0.4)] backdrop-blur-2xl">
            <div className="rounded-[1.55rem] border border-white/10 bg-[#090c18]/90 px-6 py-10 sm:px-12 sm:py-14">
              <div className="grid size-14 place-items-center rounded-2xl bg-[#b3acf3]/12 text-[#dedaff] ring-1 ring-[#b3acf3]/20">
                <FileText className="size-6" aria-hidden="true" />
              </div>
              <p className="landing-reveal landing-reveal-eyebrow mt-8 inline-flex rounded-full border border-[#b3acf3]/30 bg-[#b3acf3]/10 px-3.5 py-1 text-sm text-[#dedaff]">
                {eyebrow}
              </p>
              <h1 className="landing-reveal landing-reveal-title mt-4 text-balance text-[clamp(3rem,8vw,6rem)] font-semibold leading-[0.92] tracking-[-0.065em]">
                {title}
              </h1>
              <div className="landing-reveal landing-reveal-copy mt-10 border-t border-white/10 pt-8">
                <p className="max-w-2xl text-lg leading-8 text-white/58">
                  This document is being prepared and will be published before
                  Blame becomes commercially available.
                </p>
                <p className="mt-5 text-sm text-white/38">
                  Last updated: not yet published.
                </p>
              </div>
              <div className="landing-reveal landing-reveal-actions mt-10">
                <Link
                  href="/"
                  className={buttonVariants({ variant: "outline" })}
                >
                  <ArrowLeft className="size-4" />
                  Back to Blame
                </Link>
              </div>
            </div>
          </div>
        </article>
      </section>
    </main>
  );
}
