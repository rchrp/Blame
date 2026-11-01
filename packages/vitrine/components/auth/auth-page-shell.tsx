import type { ReactNode } from "react";
import { LoaderCircle } from "lucide-react";

import { HeroScene } from "@/app/scene/hero-scene";
import { SceneWarmup } from "@/components/scene-warmup";
import { SiteHeader } from "@/components/site-header";

type AuthPageShellProps = {
  celebration?: boolean;
  children: ReactNode;
};

type AuthPageContentProps = {
  actions?: ReactNode;
  description: string;
  form?: ReactNode;
  loading?: boolean;
  title: string;
};

export function AuthPageShell({
  celebration = false,
  children,
}: AuthPageShellProps) {
  return (
    <main className="min-h-screen overflow-x-hidden bg-[#050712] text-white">
      <section className="hero-stage relative isolate min-h-screen overflow-hidden px-5 pb-24 pt-24 sm:px-8 lg:px-10">
        <HeroScene terrainPreset="download" celebration={celebration} />
        <SceneWarmup />
        <div className="pointer-events-none absolute -inset-8 -z-10 backdrop-blur-[12px] [mask-image:radial-gradient(ellipse_at_center,transparent_0%,transparent_48%,black_78%)]" />
        <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_center,rgba(2,4,10,0.1)_0%,rgba(2,4,10,0.26)_42%,rgba(2,4,10,0.58)_74%,rgba(2,4,10,0.9)_100%)]" />
        <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-56 bg-gradient-to-b from-[#050712]/64 to-transparent" />
        <div className="pointer-events-none absolute bottom-0 left-1/2 -z-10 h-[34rem] w-[48rem] -translate-x-1/2 rounded-full bg-[#9fd7ff]/10 blur-3xl" />
        <SiteHeader />
        <div className="relative z-10 mx-auto flex min-h-[calc(100vh-6rem)] w-full max-w-5xl items-center justify-center py-12 text-center">
          {children}
        </div>
      </section>
    </main>
  );
}

export function AuthPageContent({
  actions,
  description,
  form,
  loading = false,
  title,
}: AuthPageContentProps) {
  return (
    <div className="w-full">
      {loading ? (
        <LoaderCircle className="landing-reveal mx-auto mb-7 size-7 animate-spin text-white/80" />
      ) : null}
      <h1 className="landing-reveal landing-reveal-title mx-auto max-w-4xl text-balance text-[clamp(3rem,8vw,7rem)] font-semibold leading-[0.9] tracking-tighter text-white drop-shadow-[0_20px_70px_rgba(0,0,0,0.55)] sm:leading-32">
        {title}
      </h1>
      <p
        aria-live="polite"
        className="landing-reveal landing-reveal-copy mx-auto mt-7 max-w-2xl text-balance text-base leading-7 text-white/76 sm:text-lg md:text-xl"
      >
        {description}
      </p>
      {form}
      {actions ? (
        <div className="landing-reveal landing-reveal-actions mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
