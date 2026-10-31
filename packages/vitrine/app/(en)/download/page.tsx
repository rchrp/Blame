import { LandingRevealStyles } from '@/components/landing-reveal-styles'
import { SceneWarmup } from '@/components/scene-warmup'
import { SiteHeader } from '@/components/site-header'
import { HeroScene } from '@/app/scene/hero-scene'
import { GitHubMark } from '@/components/github-stars'
import { githubReleasesUrl, githubRepositoryUrl } from '@/lib/github'
import { createIndexablePageMetadata } from '@/lib/seo'
import { DownloadClientSection } from './download-client-section'
import { loadLatestRelease } from './latest-release'

export const metadata = createIndexablePageMetadata({
  title: 'Download · Blame',
  description:
    'Download the latest Blame desktop app for macOS, Windows, and Linux.',
  canonicalPath: '/download',
})

type DownloadArtifact = {
  id: 'macos-arm64' | 'macos-x64' | 'windows-x64' | 'linux-x86_64'
  os: 'macos' | 'windows' | 'linux'
  platform: string
  architecture: string
  fileName: string
  size: string
  updatedAt: string
}

const primaryArtifacts = [
  {
    id: 'macos-arm64',
    os: 'macos',
    platform: 'macOS',
    architecture: 'Apple silicon',
    fileName: 'blame-mac-arm64.dmg',
    size: '269M',
    updatedAt: '16 Jun 2026',
  },
  {
    id: 'macos-x64',
    os: 'macos',
    platform: 'macOS',
    architecture: 'Intel',
    fileName: 'blame-mac-x64.dmg',
    size: '277M',
    updatedAt: '16 Jun 2026',
  },
  {
    id: 'windows-x64',
    os: 'windows',
    platform: 'Windows',
    architecture: 'x64',
    fileName: 'blame-win-x64.exe',
    size: '215M',
    updatedAt: '28 Jun 2026',
  },
  {
    id: 'linux-x86_64',
    os: 'linux',
    platform: 'Linux',
    architecture: 'x86_64',
    fileName: 'blame-linux-x86_64.AppImage',
    size: '295M',
    updatedAt: '28 Jun 2026',
  },
] satisfies DownloadArtifact[]

export default async function DownloadPage() {
  const { tag, artifacts } = await loadLatestRelease(primaryArtifacts)

  return (
    <main className="min-h-screen overflow-x-hidden bg-[#050712] text-white">
      <section
        id="download"
        aria-labelledby="download-title"
        className="hero-stage relative isolate min-h-screen overflow-hidden px-5 pb-24 pt-24 sm:px-8 lg:px-10"
      >
        <HeroScene terrainPreset="download" />
        <SceneWarmup />
        <div className="pointer-events-none absolute -inset-8 -z-10 backdrop-blur-[12px] [mask-image:radial-gradient(ellipse_at_center,transparent_0%,transparent_48%,black_78%)]" />
        <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_center,rgba(2,4,10,0.1)_0%,rgba(2,4,10,0.26)_42%,rgba(2,4,10,0.58)_74%,rgba(2,4,10,0.9)_100%)]" />
        <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-56 bg-gradient-to-b from-[#050712]/64 to-transparent" />
        <div className="pointer-events-none absolute bottom-0 left-1/2 -z-10 h-[34rem] w-[48rem] -translate-x-1/2 rounded-full bg-[#9fd7ff]/10 blur-3xl" />

        <SiteHeader />

        <div className="relative z-10 mx-auto grid min-h-[calc(100vh-6rem)] w-full max-w-7xl items-center gap-12 py-12 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16">
          <div>
            <h1
              id="download-title"
              className="landing-reveal landing-reveal-title max-w-4xl text-balance text-[clamp(3.2rem,8vw,7.5rem)] font-semibold leading-[0.9] tracking-tighter text-white drop-shadow-[0_20px_70px_rgba(0,0,0,0.55)] sm:leading-32"
            >
              Download Blame.
            </h1>
            <p className="landing-reveal landing-reveal-copy mt-7 max-w-2xl text-balance text-base leading-7 text-white/76 sm:text-lg md:text-xl">
              Install the desktop app and keep agent execution close to your
              code: isolated worktrees, live previews, diffs, and controlled
              merges on your machine.
            </p>

            <DownloadClientSection artifacts={artifacts} mode="actions" />
          </div>

          <div
            id="all-downloads"
            className="landing-reveal landing-reveal-actions scroll-mt-28"
          >
            <div className="relative overflow-hidden rounded-[2rem] border border-white/18 bg-white/[0.08] p-5 shadow-[0_34px_120px_rgba(0,0,0,0.42)] backdrop-blur-2xl sm:p-6">
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_0%,rgba(255,255,255,0.18),transparent_28%),radial-gradient(circle_at_80%_18%,rgba(159,215,255,0.2),transparent_36%)]" />
              <div className="relative">
                <h2 className="text-2xl font-semibold tracking-[-0.04em] text-white">
                  {tag ?? 'Latest release'}
                </h2>

                <DownloadClientSection artifacts={artifacts} mode="cards" />
                <OpenSourceNotice />
              </div>
            </div>
          </div>
        </div>

        <LandingRevealStyles />
      </section>
    </main>
  )
}

function OpenSourceNotice() {
  const linkClassName =
    'text-white/86 underline decoration-white/24 underline-offset-4 transition hover:text-white hover:decoration-white/60'

  return (
    <p className="mt-5 flex gap-3 border-t border-white/12 pt-5 text-sm leading-6 text-white/60">
      <GitHubMark className="mt-1 size-4 shrink-0 text-white/80" />
      <span>
        Blame is open source under the AGPL-3.0. Debian and RPM packages,
        checksums and every past version are on the{' '}
        <a className={linkClassName} href={githubReleasesUrl}>
          releases page
        </a>
        , and the{' '}
        <a className={linkClassName} href={githubRepositoryUrl}>
          source code
        </a>{' '}
        is on GitHub.
      </span>
    </p>
  )
}

export type { DownloadArtifact }
