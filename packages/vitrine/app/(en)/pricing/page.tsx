import { pricingBillingOptions } from "@blame/pricing-card/offer";
import { JsonLd } from "@/components/json-ld";
import { PricingCard } from "@/components/pricing-card";
import { SceneWarmup } from "@/components/scene-warmup";
import { SiteHeader } from "@/components/site-header";
import { HeroScene } from "@/app/scene/hero-scene";
import { createIndexablePageMetadata } from "@/lib/seo";
import { pricingStructuredData } from "@/lib/structured-data";

const { monthly, yearly } = pricingBillingOptions;

export const metadata = createIndexablePageMetadata({
  title: `Blame Pricing — Free and Open Source, Premium $${monthly.price}/month`,
  description: `Blame is free and open source. Blame Premium adds managed Cloud Previews, cloud voice transcription, and hosted file uploads for $${monthly.price}/month or $${yearly.price}/year.`,
  canonicalPath: "/pricing",
});

export default function PricingPage() {
  return (
    <main className="min-h-screen overflow-x-hidden bg-[#050712] text-white">
      <JsonLd id="pricing-structured-data" data={pricingStructuredData} />
      <section
        id="pricing"
        aria-labelledby="pricing-title"
        className="hero-stage relative isolate min-h-screen overflow-hidden px-5 pb-24 pt-24 sm:px-8 lg:px-10"
      >
        <HeroScene terrainPreset="pricing" />
        <SceneWarmup />
        <div className="pointer-events-none absolute -inset-8 -z-10 backdrop-blur-[12px] [mask-image:radial-gradient(ellipse_at_center,transparent_0%,transparent_48%,black_78%)]" />
        <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_center,rgba(2,4,10,0.1)_0%,rgba(2,4,10,0.26)_42%,rgba(2,4,10,0.58)_74%,rgba(2,4,10,0.9)_100%)]" />
        <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-56 bg-gradient-to-b from-[#050712]/64 to-transparent" />
        <div className="pointer-events-none absolute bottom-0 left-1/2 -z-10 h-[32rem] w-[44rem] -translate-x-1/2 rounded-full bg-[#b3acf3]/10 blur-3xl" />

        <SiteHeader />

        <div className="relative z-10 mx-auto flex min-h-[calc(100vh-6rem)] w-full max-w-7xl flex-col items-center justify-center">
          <div className="mx-auto max-w-5xl text-center">
            <h1
              id="pricing-title"
              className="landing-reveal landing-reveal-title text-balance text-[clamp(3.2rem,8vw,7.5rem)] font-semibold leading-[0.9] tracking-tighter text-white drop-shadow-[0_20px_70px_rgba(0,0,0,0.55)] sm:leading-32"
            >
              Free to build.
              <br />
              Premium for the cloud.
            </h1>
            <p className="landing-reveal landing-reveal-copy mx-auto mt-7 max-w-2xl text-balance text-base leading-7 text-white/76 sm:text-lg md:text-xl">
              Run AI coding agents with your own providers, preview locally, and
              review your changes for free. Add Premium for services hosted by
              Blame.
            </p>
          </div>

          <PricingCard />
        </div>

      </section>
    </main>
  );
}
