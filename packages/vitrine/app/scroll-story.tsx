'use client'

import { ArrowRight, Play } from 'lucide-react'
import {
  memo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react'
import { SceneWarmup } from '@/components/scene-warmup'
import { GitHubMark } from '@/components/github-stars'
import { githubRepositoryUrl } from '@/lib/github'
import { HeroBacklogMockup } from '@/components/blame-mockups/backlog-mockup'
import { HeroScene } from './scene/hero-scene'

// The hero re-renders on every scroll frame to update its transforms; these
// subtrees take no props, so keep them out of that loop.
const StaticHeroScene = memo(HeroScene)
const StaticSceneWarmup = memo(SceneWarmup)
const StaticHeroBacklogMockup = memo(HeroBacklogMockup)

const heroStageHeight = 180
const scrollProgressResponse = 14

type ScrollAnimationState = {
  current: number
  frame: number
  lastFrameTime: number
  target: number
}

type StoryBackdropProps = {
  heroProgress: number
  progress: number
}

export function LandingHero() {
  const sectionRef = useRef<HTMLElement>(null)
  const progress = useScrollProgress(sectionRef)
  const reducedMotion = useReducedMotion()
  const backdropProgress = reducedMotion ? reducedMotionProgress(progress) : progress

  return (
    <section
      id="top"
      aria-labelledby="hero-title"
      ref={sectionRef}
      className="hero-stage relative bg-[#050505]"
      style={{ height: `${heroStageHeight}vh` }}
    >
      <span id="download" className="absolute bottom-0" />
      <div className="sticky top-0 isolate h-screen overflow-hidden">
        <StaticHeroScene />
        <StaticSceneWarmup />
        <StoryBackdrop
          heroProgress={backdropProgress}
          progress={backdropProgress}
        />
        <HeroFrame progress={progress} reducedMotion={reducedMotion} />
      </div>
    </section>
  )
}

function HeroFrame({
  progress,
  reducedMotion,
}: {
  progress: number
  reducedMotion: boolean
}) {
  const hidden = progress >= 0.72
  return (
    <div
      aria-hidden={hidden || undefined}
      className="absolute inset-0 z-10 mx-auto flex w-full max-w-9xl flex-col px-5 pb-0 pt-24 sm:px-8 lg:px-10"
      inert={hidden || undefined}
      style={heroFrameStyle(progress, reducedMotion)}
    >
      <HeroCopy progress={progress} reducedMotion={reducedMotion} />
      <HeroMockup progress={progress} reducedMotion={reducedMotion} />
    </div>
  )
}

function HeroCopy({
  progress,
  reducedMotion,
}: {
  progress: number
  reducedMotion: boolean
}) {
  return (
    <div
      className="flex flex-1 items-center justify-center pb-4 pt-8 sm:pb-6 lg:pb-8"
      style={heroCopyStyle(progress, reducedMotion)}
    >
      <div className="text-center">
        <OpenSourceAnnouncement />
        <h1
          id="hero-title"
          className="text-balance font-semibold text-white drop-shadow-[0_20px_70px_rgba(0,0,0,0.55)]"
        >
          <span className="block whitespace-nowrap">The ADE that</span>
          <span className="block whitespace-nowrap">sets the standard</span>
        </h1>
        <p className="hero-subtitle mx-auto mt-7 max-w-3xl text-balance text-white/76">
          From story to controlled merge, one verifiable harness unifies
          agents, Code Practices, smart worktrees, and live Cloud Previews.
        </p>
        <HeroActions />
      </div>
    </div>
  )
}

function HeroActions() {
  return (
    <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
      <a
        href="/download"
        className="group inline-flex min-h-12 items-center justify-center gap-2 rounded-full bg-white px-5 py-3 text-sm text-[#080808] shadow-[0_18px_60px_rgba(255,255,255,0.22)] transition duration-200 hover:-translate-y-0.5 hover:bg-[#dfe7ff] focus:outline-none focus:ring-2 focus:ring-white/60 focus:ring-offset-2 focus:ring-offset-[#050505]"
      >
        Download Blame
        <ArrowRight className="h-4 w-4 transition duration-200 group-hover:translate-x-0.5" />
      </a>
      <a
        href="#workflow"
        className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-white/14 bg-white/[0.06] px-5 py-3 text-sm text-white/90 backdrop-blur-md transition duration-200 hover:-translate-y-0.5 hover:bg-white/[0.1] focus:outline-none focus:ring-2 focus:ring-white/45 focus:ring-offset-2 focus:ring-offset-[#050505]"
      >
        <Play className="h-4 w-4 fill-current" />
        See the workflow
      </a>
    </div>
  )
}

function OpenSourceAnnouncement() {
  return (
    <a
      href={githubRepositoryUrl}
      className="group mb-7 inline-flex min-h-9 items-center gap-2.5 rounded-full border border-white/14 bg-[#070a15]/55 py-1.5 pl-3 pr-3.5 text-sm text-white/82 shadow-2xl shadow-black/20 backdrop-blur-xl transition duration-200 hover:bg-[#070a15]/70 hover:text-white focus:outline-none focus:ring-2 focus:ring-white/45 focus:ring-offset-2 focus:ring-offset-[#050505] sm:mb-9"
    >
      <GitHubMark className="size-4 shrink-0 text-white" />
      <span>Blame is now open source</span>
      <span aria-hidden="true" className="h-3.5 w-px bg-white/20" />
      <span className="inline-flex items-center gap-1 text-white">
        Star on GitHub
        <ArrowRight className="h-3.5 w-3.5 transition duration-200 group-hover:translate-x-0.5" />
      </span>
    </a>
  )
}

function HeroMockup({
  progress,
  reducedMotion,
}: {
  progress: number
  reducedMotion: boolean
}) {
  return (
    <div
      className="z-20 mx-auto mb-4 w-[90%] max-w-[61.2rem]"
      style={heroMockupStyle(progress, reducedMotion)}
    >
      <StaticHeroBacklogMockup />
    </div>
  )
}

function StoryBackdrop({ heroProgress, progress }: StoryBackdropProps) {
  const glow = 0.1 + progress * 0.24
  const veil = 0.12 + heroProgress * 0.68
  const blur = heroProgress * 18

  return (
    <div className="absolute inset-0 -z-10 overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          backdropFilter: `blur(${blur}px)`,
          WebkitBackdropFilter: `blur(${blur}px)`,
        }}
      />
      <div
        className="absolute inset-0 bg-[#050505]"
        style={{ opacity: veil }}
      />
      <div className="absolute inset-0 bg-[linear-gradient(120deg,rgba(255,255,255,0.08),transparent_28%,rgba(146,216,191,0.08)_52%,transparent_76%,rgba(247,207,131,0.08))]" />
      <div
        className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_10%,rgba(255,255,255,0.12),transparent_44%)]"
        style={{ opacity: glow }}
      />
      <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-[#050505] to-transparent" />
    </div>
  )
}

function useScrollProgress(ref: RefObject<HTMLElement | null>) {
  const [progress, setProgress] = useState(0)
  useEffect(() => connectScrollProgress(ref, setProgress), [ref])
  return progress
}

function useReducedMotion() {
  const [reducedMotion, setReducedMotion] = useState(false)
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return reducedMotion
}

function connectScrollProgress(
  ref: RefObject<HTMLElement | null>,
  setProgress: (progress: number) => void,
) {
  const initial = readScrollProgress(ref.current)
  const state = createScrollAnimationState(initial)
  const animate = (time: number) =>
    animateScrollProgress(state, setProgress, animate, time)
  const update = () => {
    state.target = readScrollProgress(ref.current)
    requestScrollFrame(state, animate)
  }

  setProgress(initial)
  window.addEventListener('scroll', update, { passive: true })
  window.addEventListener('resize', update)
  return () => {
    if (state.frame) window.cancelAnimationFrame(state.frame)
    window.removeEventListener('scroll', update)
    window.removeEventListener('resize', update)
  }
}

function animateScrollProgress(
  state: ScrollAnimationState,
  setProgress: (progress: number) => void,
  animate: (time: number) => void,
  time: number,
) {
  const delta = Math.min((time - state.lastFrameTime) / 1000, 0.05)
  const amount = 1 - Math.exp(-scrollProgressResponse * delta)
  const distance = state.target - state.current
  state.current =
    Math.abs(distance) < 0.0005
      ? state.target
      : state.current + distance * amount
  state.lastFrameTime = time
  setProgress(state.current)
  state.frame =
    state.current === state.target ? 0 : window.requestAnimationFrame(animate)
}

function requestScrollFrame(
  state: ScrollAnimationState,
  animate: (time: number) => void,
) {
  if (state.frame) return
  state.lastFrameTime = performance.now()
  state.frame = window.requestAnimationFrame(animate)
}

function createScrollAnimationState(initial: number): ScrollAnimationState {
  return {
    current: initial,
    frame: 0,
    lastFrameTime: performance.now(),
    target: initial,
  }
}

function readScrollProgress(node: HTMLElement | null) {
  if (!node) return 0
  const scrollable = node.offsetHeight - window.innerHeight
  if (scrollable <= 0) return 0
  return clamp(-node.getBoundingClientRect().top / scrollable, 0, 1)
}

function heroFrameStyle(
  progress: number,
  reducedMotion: boolean,
): CSSProperties {
  const opacity = reducedMotion
    ? reducedMotionOpacity(progress)
    : 1 - smoothstep(0.72, 0.98, progress)
  return { opacity, pointerEvents: progress < 0.72 ? 'auto' : 'none' }
}

function heroCopyStyle(
  progress: number,
  reducedMotion: boolean,
): CSSProperties {
  if (reducedMotion) return { opacity: reducedMotionOpacity(progress) }
  const amount = easeOut(timelineProgress(progress, 0, 0.68))
  return {
    opacity: 1 - amount,
    transform: `translate3d(0, ${amount * -72}px, 0) scale(${1 - amount * 0.035})`,
  }
}

function heroMockupStyle(
  progress: number,
  reducedMotion: boolean,
): CSSProperties {
  if (reducedMotion) return { opacity: reducedMotionOpacity(progress) }
  const lift = easeOut(timelineProgress(progress, 0, 0.9))
  const fade = smoothstep(0.34, 0.72, progress)
  return {
    opacity: 1 - fade,
    transform: `translate3d(0, ${lift * -42}vh, 0) perspective(1200px) rotate3d(1, -0.16, 0, ${lift * 32}deg) scale(${1 + lift * 0.42})`,
  }
}

function reducedMotionOpacity(progress: number) {
  return progress < 0.72 ? 1 : 0
}

function reducedMotionProgress(progress: number) {
  return progress < 0.72 ? 0 : 1
}

function timelineProgress(progress: number, start: number, end: number) {
  if (end <= start) return 1
  return clamp((progress - start) / (end - start), 0, 1)
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const amount = clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return amount * amount * (3 - 2 * amount)
}

function easeOut(value: number) {
  return 1 - Math.pow(1 - clamp(value, 0, 1), 3)
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}
