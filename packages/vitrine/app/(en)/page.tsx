import { JsonLd } from '@/components/json-ld'
import { SiteHeader } from '@/components/site-header'
import { ProductStory } from '@/app/product-story'
import { StoryScroll } from '@/components/story/story-scroll'
import { StoryStage } from '@/components/story/story-stage'
import { LandingHero } from '@/app/scroll-story'
import { createIndexablePageMetadata } from '@/lib/seo'
import { homepageStructuredData } from '@/lib/structured-data'

export const metadata = createIndexablePageMetadata({
  title: 'Blame ADE — Run coding agents in parallel, each with its own live preview',
  description:
    'Free, open-source desktop app: run up to three coding agents at once, each with its own worktree, ports, database, and live preview. No account needed.',
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
      </main>
    </>
  )
}
