import Link from 'next/link'
import { ArrowRight, ShieldAlert } from 'lucide-react'
import { InstallCommand } from '@/components/install-command'
import { SceneWarmup } from '@/components/scene-warmup'
import { SiteHeader } from '@/components/site-header'
import { HeroScene } from '@/app/scene/hero-scene'
import { GitHubMark } from '@/components/github-stars'
import { JsonLd } from '@/components/json-ld'
import { githubReleasesUrl, githubRepositoryUrl } from '@/lib/github'
import { createIndexablePageMetadata } from '@/lib/seo'
import { downloadStructuredData } from '@/lib/structured-data'
import { DownloadClientSection } from './download-client-section'
import { loadLatestRelease } from './latest-release'
import { artifactUrl, primaryArtifacts } from './artifacts'

export const metadata = createIndexablePageMetadata({
  title: 'Download Blame ADE for macOS, Windows, and Linux',
  description:
    'Download Blame ADE, free and open source, for macOS (Apple silicon and Intel), Windows x64, and Linux (AppImage, Debian, and RPM packages), or install it with Homebrew. No account needed.',
  canonicalPath: '/download',
})

export default async function DownloadPage() {
  const { tag, artifacts } = await loadLatestRelease(primaryArtifacts)

  return (
    <main className="min-h-screen overflow-x-hidden bg-[#050712] text-white">
      <JsonLd
        id="download-structured-data"
        data={downloadStructuredData({
          tag,
          downloadUrls: artifacts.map((artifact) => artifactUrl(artifact.fileName)),
        })}
      />
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
              Free and open source. No account needed: open the app, choose
              Continue without an account, and your agents, worktrees, and
              previews run on your machine.
            </p>

            <DownloadClientSection artifacts={artifacts} mode="actions" />
            <CommandLineInstall />
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
                <WindowsSigningNotice />
                <OpenSourceNotice />
              </div>
            </div>
          </div>
        </div>

      </section>
    </main>
  )
}

const linkClassName =
  'text-white/86 underline decoration-white/24 underline-offset-4 transition hover:text-white hover:decoration-white/60'

// Homebrew and winget. The winget package (Blame.Blame) is waiting for
// Microsoft's review: once it is published
// (https://github.com/microsoft/winget-pkgs/pull/468422), drop its note.
function CommandLineInstall() {
  return (
    <section
      aria-labelledby="command-line-install-title"
      className="landing-reveal landing-reveal-actions mt-10 max-w-xl"
    >
      <h2
        id="command-line-install-title"
        className="text-sm font-semibold text-white/86"
      >
        Or install from the command line
      </h2>
      <dl className="mt-4 grid gap-4">
        <div>
          <dt className="text-xs font-medium text-white/52">macOS · Homebrew</dt>
          <dd className="mt-2">
            <InstallCommand
              platform="macOS"
              command="brew install --cask rchrp/tap/blame"
              showPlatform={false}
            />
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-white/52">Windows · winget</dt>
          <dd className="mt-2">
            <InstallCommand
              platform="Windows"
              command="winget install Blame.Blame"
              showPlatform={false}
            />
            <p className="mt-2 text-xs leading-5 text-white/48">
              The winget package is in review. Until Microsoft publishes it,
              use the installer.
            </p>
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-white/52">Linux</dt>
          <dd className="mt-2 text-sm leading-6 text-white/60">
            Download the AppImage, or the Debian and RPM packages from the{' '}
            <a className={linkClassName} href={githubReleasesUrl}>
              releases page
            </a>
            . An AUR package is coming soon.
          </dd>
        </div>
      </dl>
      <Link
        href="/docs/install"
        className="group mt-6 inline-flex items-center gap-1.5 text-sm text-white/80 underline decoration-white/24 underline-offset-4 transition hover:text-white hover:decoration-white/60"
      >
        Install guide: requirements, checksums, and betas
        <ArrowRight className="size-3.5 transition group-hover:translate-x-0.5" />
      </Link>
    </section>
  )
}

function WindowsSigningNotice() {
  return (
    <p className="mt-5 flex gap-3 border-t border-white/12 pt-5 text-sm leading-6 text-white/60">
      <ShieldAlert className="mt-1 size-4 shrink-0 text-white/80" />
      <span>
        The Windows installer is not code-signed yet, so SmartScreen may warn
        you: choose <strong className="font-semibold text-white/86">More info</strong>, then{' '}
        <strong className="font-semibold text-white/86">Run anyway</strong>. Signing
        through SignPath Foundation is planned: see the{' '}
        <Link className={linkClassName} href="/code-signing-policy">
          code signing policy
        </Link>
        .
      </span>
    </p>
  )
}

function OpenSourceNotice() {
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
        is on GitHub. How releases are signed:{' '}
        <Link className={linkClassName} href="/code-signing-policy">
          Code signing policy
        </Link>
        .
      </span>
    </p>
  )
}

