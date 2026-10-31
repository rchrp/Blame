'use client'

import { useMemo, useSyncExternalStore } from 'react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { ArrowRight, Download } from 'lucide-react'

import { AnimatedBorderFrame } from '@/components/animated-border/animated-border-frame'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { OsLogo } from './os-logo'
import type { DownloadArtifact } from './page'

const downloadBaseUrl = 'https://download.blame.so/latest'

type DetectedOs = DownloadArtifact['os']

type DownloadClientSectionProps = {
  artifacts: DownloadArtifact[]
  mode: 'actions' | 'cards'
}

const osLabels = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
} satisfies Record<DetectedOs, string>

export function DownloadClientSection({ artifacts, mode }: DownloadClientSectionProps) {
  const detectedOs = useDetectedOs()
  const recommendedArtifact = useMemo(
    () => selectRecommendedArtifact(artifacts, detectedOs),
    [artifacts, detectedOs],
  )

  if (mode === 'actions') {
    return <DownloadActions artifact={recommendedArtifact} />
  }

  const artifactGroups = groupArtifactsForOs(artifacts, detectedOs)

  return (
    <div className="mt-6 grid gap-3">
      {artifactGroups.map((group) => (
        <div
          key={group.os}
          className="grid gap-3 sm:data-[macos=true]:grid-cols-2"
          data-macos={group.os === 'macos'}
        >
          {group.artifacts.map((artifact) => (
            <DownloadCard
              key={artifact.fileName}
              artifact={artifact}
              isRecommended={artifact.id === recommendedArtifact.id}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

function DownloadActions({ artifact }: { artifact: DownloadArtifact }) {
  return (
    <div className="landing-reveal landing-reveal-actions mt-9 flex max-w-xl flex-col items-start gap-3">
      <Link
        href={artifactUrl(artifact.fileName)}
        className={cn(
          buttonVariants(),
          'min-h-14 px-7 py-4 text-base shadow-[0_22px_70px_rgba(255,255,255,0.26)] sm:text-lg',
        )}
      >
        <OsLogo os={artifact.os} className="h-5 w-5" />
        Download for {osLabels[artifact.os]}
        <ArrowRight className="h-5 w-5" />
      </Link>
      <DownloadLegalNotice />
    </div>
  )
}

function DownloadLegalNotice() {
  const legalLinkClassName = 'text-white/80 underline underline-offset-2 hover:text-white'

  return (
    <p className="text-sm leading-6 text-white/56">
      By downloading or using Blame, you agree to the{' '}
      <Link className={legalLinkClassName} href="/terms-of-service">Terms of Service</Link>{' '}
      and acknowledge the{' '}
      <Link className={legalLinkClassName} href="/privacy">Privacy Policy</Link>. Paid
      subscriptions are also subject to our{' '}
      <Link className={legalLinkClassName} href="/refund-policy">Refund Policy</Link>{' '}
      and applicable{' '}
      <Link className={legalLinkClassName} href="/withdraw">withdrawal rights</Link>.
    </p>
  )
}

function DownloadCard({
  artifact,
  isRecommended,
}: {
  artifact: DownloadArtifact
  isRecommended: boolean
}) {
  return (
    <DownloadCardFrame isRecommended={isRecommended}>
      <Link
        href={artifactUrl(artifact.fileName)}
        className="group relative z-[1] block h-full rounded-2xl border border-white/12 bg-white/[0.06] p-4 text-white backdrop-blur-xl transition duration-200 hover:bg-white/[0.1] focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 data-[recommended=true]:border-transparent data-[recommended=true]:bg-white data-[recommended=true]:bg-clip-padding data-[recommended=true]:text-[#111] data-[recommended=true]:shadow-[0_22px_58px_rgba(0,0,0,0.24)]"
        data-recommended={isRecommended}
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <OsLogo os={artifact.os} className="h-4 w-4 shrink-0" />
              <h3 className="text-lg font-semibold tracking-[-0.03em]">
                {artifact.platform}
              </h3>
              <span className="whitespace-nowrap rounded-full bg-white/10 px-2.5 py-1 text-xs font-semibold text-white/70 group-data-[recommended=true]:bg-black/[0.06] group-data-[recommended=true]:text-[#111]/62">
                {artifact.architecture}
              </span>
              {isRecommended ? (
                <span className="whitespace-nowrap rounded-full bg-[#111] px-2.5 py-1 text-xs font-semibold text-white">
                  For this device
                </span>
              ) : null}
            </div>
            <p className="mt-3 break-all text-xs text-white/44 group-data-[recommended=true]:text-[#111]/44">
              {artifact.fileName}
            </p>
          </div>
          <div className="flex shrink-0 items-center justify-between gap-4 sm:block sm:text-right">
            <div>
              <p className="text-sm font-semibold">{artifact.size}</p>
              <p className="mt-1 text-xs text-white/44 group-data-[recommended=true]:text-[#111]/44">
                {artifact.updatedAt}
              </p>
            </div>
            <span className="mt-3 inline-flex h-9 w-9 items-center justify-center rounded-full bg-white text-[#111] transition duration-200 group-hover:scale-105 group-data-[recommended=true]:bg-[#111] group-data-[recommended=true]:text-white">
              <Download className="h-4 w-4" />
            </span>
          </div>
        </div>
      </Link>
    </DownloadCardFrame>
  )
}

function DownloadCardFrame({
  children,
  isRecommended,
}: {
  children: ReactNode
  isRecommended: boolean
}) {
  if (!isRecommended) {
    return children
  }

  // Same animated border as the workspace section on the homepage. The shader
  // strokes just inside this frame, so the card keeps its border transparent,
  // and its glow is boosted to stand out against the glass panel.
  return (
    <AnimatedBorderFrame
      className="user-story-state-effect rounded-2xl [&>canvas]:[filter:brightness(1.25)_saturate(1.4)_drop-shadow(0_0_5px_oklch(0.68_0.22_250/0.9))_drop-shadow(0_0_14px_oklch(0.65_0.22_255/0.6))]"
      effect="story-progress"
    >
      {children}
    </AnimatedBorderFrame>
  )
}

function useDetectedOs() {
  return useSyncExternalStore(subscribeToStaticOs, detectOs, getServerOs)
}

function subscribeToStaticOs() {
  return () => undefined
}

function getServerOs(): DetectedOs {
  return 'macos'
}

function detectOs(): DetectedOs {
  const userAgentDataPlatform = getUserAgentDataPlatform()
  const platform = (userAgentDataPlatform || navigator.platform || '').toLowerCase()
  const userAgent = navigator.userAgent.toLowerCase()
  const osSource = `${platform} ${userAgent}`

  if (/win/.test(osSource)) {
    return 'windows'
  }

  if (/linux|x11/.test(osSource)) {
    return 'linux'
  }

  return 'macos'
}

function getUserAgentDataPlatform() {
  const navigatorWithUserAgentData = navigator as Navigator & {
    userAgentData?: { platform?: string }
  }

  return navigatorWithUserAgentData.userAgentData?.platform
}

function selectRecommendedArtifact(
  artifacts: DownloadArtifact[],
  detectedOs: DetectedOs,
) {
  return (
    artifacts.find((artifact) => artifact.os === detectedOs) ??
    artifacts.find((artifact) => artifact.os === 'macos') ??
    artifacts[0]
  )
}

function groupArtifactsForOs(
  artifacts: DownloadArtifact[],
  detectedOs: DetectedOs,
) {
  const sortedArtifacts = sortArtifactsForOs(artifacts, detectedOs)
  const groups: { os: DetectedOs; artifacts: DownloadArtifact[] }[] = []

  for (const artifact of sortedArtifacts) {
    const existingGroup = groups.find((group) => group.os === artifact.os)

    if (existingGroup) {
      existingGroup.artifacts.push(artifact)
      continue
    }

    groups.push({ os: artifact.os, artifacts: [artifact] })
  }

  return groups
}

function sortArtifactsForOs(
  artifacts: DownloadArtifact[],
  detectedOs: DetectedOs,
) {
  return [...artifacts].sort((left, right) => {
    const osRankDifference =
      osPriority(left.os, detectedOs) - osPriority(right.os, detectedOs)

    if (osRankDifference !== 0) {
      return osRankDifference
    }

    return artifactArchitectureRank(left) - artifactArchitectureRank(right)
  })
}

function osPriority(os: DetectedOs, detectedOs: DetectedOs) {
  if (os === detectedOs) {
    return 0
  }

  const defaultPriority = { macos: 1, windows: 2, linux: 3 }

  return defaultPriority[os]
}

function artifactArchitectureRank(artifact: DownloadArtifact) {
  if (artifact.id === 'macos-arm64') {
    return 0
  }

  if (artifact.id === 'macos-x64') {
    return 1
  }

  return 0
}

function artifactUrl(fileName: string) {
  return `${downloadBaseUrl}/${fileName}`
}
