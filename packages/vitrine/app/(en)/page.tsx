import { LandingRevealStyles } from '@/components/landing-reveal-styles'
import { JsonLd } from '@/components/json-ld'
import { SiteHeader } from '@/components/site-header'
import { ProductStory } from '@/app/product-story'
import { StoryScroll } from '@/components/story/story-scroll'
import { StoryStage } from '@/components/story/story-stage'
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
      {/* No background here: the story stage is fixed behind the page. */}
      <main className="marketing-page min-h-screen overflow-x-clip text-white">
        <StoryStage />
        <SiteHeader />
        <LandingHero />
        <ProductStory />
        <StoryScroll />
        <LandingRevealStyles />
      </main>
    </>
  )
}
