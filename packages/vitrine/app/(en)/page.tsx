import { LandingRevealStyles } from '@/components/landing-reveal-styles'
import { JsonLd } from '@/components/json-ld'
import { SiteHeader } from '@/components/site-header'
import { ProductStory } from '@/app/product-story'
import { StoryMagnet } from '@/components/story/story-magnet'
import { LandingHero } from '@/app/scroll-story'
import { createIndexablePageMetadata } from '@/lib/seo'
import { homepageStructuredData } from '@/lib/structured-data'

export const metadata = createIndexablePageMetadata({
  title: 'Blame — The ADE That Sets the Standard',
  description:
    'Blame is the ADE for verifiable agentic development: Code Practices, isolated smart worktrees, live Cloud Previews, and controlled merges.',
  canonicalPath: '/',
})

export default function Home() {
  return (
    <>
      <JsonLd id="homepage-structured-data" data={homepageStructuredData} />
      <main className="marketing-page min-h-screen overflow-x-clip bg-[#050505] text-white">
        <SiteHeader />
        <LandingHero />
        <ProductStory />
        <StoryMagnet />
        <LandingRevealStyles />
      </main>
    </>
  )
}
