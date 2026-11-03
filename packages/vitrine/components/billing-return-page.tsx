"use client";

import Link from "next/link";
import { ArrowRight, ExternalLink } from "lucide-react";

import { SceneWarmup } from "@/components/scene-warmup";
import { SiteHeader } from "@/components/site-header";
import { buttonVariants } from "@/components/ui/button";
import { HeroScene } from "@/app/scene/hero-scene";

type BillingReturnVariant = "success" | "cancelled" | "portal";

const content = {
  success: {
    title: "Checkout complete",
    description:
      "Open Blame to verify your subscription and activate Blame Cloud.",
    action: "Open Blame and verify",
  },
  cancelled: {
    title: "Checkout closed.",
    description:
      "Your Blame Cloud subscription remains unchanged. You can continue using Blame for free.",
    action: "Return to Blame",
  },
  portal: {
    title: "Portal closed.",
    description:
      "Open Blame to refresh your Blame Cloud status after reviewing your billing settings.",
    action: "Open Blame and refresh",
  },
} as const;

export function BillingReturnPage({
  variant,
}: {
  variant: BillingReturnVariant;
}) {
  const page = content[variant];

  return (
    <main className="min-h-screen overflow-x-hidden bg-[#050712] text-white">
      <section
        aria-labelledby="billing-return-title"
        className="hero-stage relative isolate min-h-screen overflow-hidden px-5 pb-24 pt-24 sm:px-8 lg:px-10"
      >
        <HeroScene
          terrainPreset="download"
          celebration={variant === "success"}
        />
        <SceneWarmup />
        <div className="pointer-events-none absolute -inset-8 -z-10 backdrop-blur-[12px] [mask-image:radial-gradient(ellipse_at_center,transparent_0%,transparent_48%,black_78%)]" />
        <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_center,rgba(2,4,10,0.1)_0%,rgba(2,4,10,0.26)_42%,rgba(2,4,10,0.58)_74%,rgba(2,4,10,0.9)_100%)]" />
        <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-56 bg-gradient-to-b from-[#050712]/64 to-transparent" />
        <div className="pointer-events-none absolute bottom-0 left-1/2 -z-10 h-[34rem] w-[48rem] -translate-x-1/2 rounded-full bg-[#9fd7ff]/10 blur-3xl" />

        <SiteHeader />

        <div className="relative z-10 mx-auto flex min-h-[calc(100vh-6rem)] w-full max-w-5xl items-center justify-center py-12 text-center">
          <div className="w-full">
            <h1
              id="billing-return-title"
              className={`landing-reveal landing-reveal-title mx-auto max-w-4xl text-balance text-[clamp(3.2rem,8vw,7.5rem)] font-semibold leading-[0.9] tracking-tighter text-white drop-shadow-[0_20px_70px_rgba(0,0,0,0.55)] sm:leading-32 ${variant === "success" ? "billing-success-title" : ""}`}
            >
              <span
                className={
                  variant === "success"
                    ? "billing-success-title-text"
                    : undefined
                }
              >
                {page.title}
              </span>
            </h1>
            <p className="landing-reveal landing-reveal-copy mx-auto mt-7 max-w-2xl text-balance text-base leading-7 text-white/76 sm:text-lg md:text-xl">
              {page.description}
            </p>

            <div className="landing-reveal landing-reveal-actions mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <a href="blame://billing/refresh" className={buttonVariants()}>
                {page.action}
                <ArrowRight className="size-4" />
              </a>
              <Link
                href="/download"
                className={buttonVariants({ variant: "outline" })}
              >
                Download Blame
                <ExternalLink className="size-4" />
              </Link>
            </div>

            {variant !== "cancelled" ? (
              <p
                className="landing-reveal mt-6 text-sm text-white/42"
                style={{ animationDelay: "520ms" }}
              >
                Blame didn&apos;t open? Use the button above.
              </p>
            ) : null}
          </div>
        </div>

        {variant === "success" ? (
          <style>{`
            .billing-success-title {
              position: relative;
            }

            .billing-success-title-text {
              display: inline-block;
              color: transparent;
              background-image: linear-gradient(105deg, #fff 28%, #fff 40%, #8fdcff 48%, #fff 56%, #fff 72%);
              background-size: 300% 100%;
              background-position: 100% 0;
              background-clip: text;
              -webkit-background-clip: text;
              animation: billingTitleSweep 1350ms cubic-bezier(0.22, 1, 0.36, 1) 850ms forwards;
            }

            @keyframes billingTitleSweep {
              0% { background-position: 100% 0; filter: drop-shadow(0 0 0 rgba(143, 220, 255, 0)); }
              52% { filter: drop-shadow(0 0 18px rgba(143, 220, 255, 0.5)); }
              100% { background-position: 0 0; filter: drop-shadow(0 0 0 rgba(143, 220, 255, 0)); }
            }

            @media (prefers-reduced-motion: reduce) {
              .billing-success-title-text {
                color: white;
                background: none;
                animation: none;
                filter: none;
              }
            }
          `}</style>
        ) : null}
      </section>
    </main>
  );
}
