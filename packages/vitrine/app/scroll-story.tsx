'use client'

import {
  memo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react'
import { GitHubMark } from '@/components/github-stars'
import { githubRepositoryUrl } from '@/lib/github'
import { HeroBacklogMockup } from '@/components/blame-mockups/backlog-mockup'
import endCard from '@/components/story/cta-scene.module.css'

// The hero re-renders on every scroll frame to update its transforms; this
// subtree takes no props, so keep it out of that loop. The 3D scene behind
// the hero is the page's story stage (components/story/story-stage.tsx).
const StaticHeroBacklogMockup = memo(HeroBacklogMockup)

const heroStageHeight = 180
const scrollProgressResponse = 14

type ScrollAnimationState = {
  current: number
  frame: number
  lastFrameTime: number
  target: number
}

export function LandingHero() {
  const sectionRef = useRef<HTMLElement>(null)
  const progress = useScrollProgress(sectionRef)
  const reducedMotion = useReducedMotion()

  return (
    <section
      id="top"
      aria-labelledby="hero-title"
      ref={sectionRef}
      className="hero-stage relative"
      style={{ height: `${heroStageHeight}vh` }}
    >
      <span id="download" className="absolute bottom-0" />
      <div className="sticky top-0 isolate h-screen overflow-hidden">
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
      {/* The end card's title, highlight, button and spacing (see
          cta-scene.module.css), with the hero's own subtitle. */}
      <div className={endCard.scene}>
        <h1 id="hero-title" className={`${endCard.title} ${endCard.heroTitle}`}>
          <span className={endCard.word}>The</span>{' '}
          <span className={`${endCard.hl} ${endCard.hlIntro}`}>
            <span className={endCard.hlBox}>
              <span className={endCard.hlText}>Open Source</span>
            </span>
          </span>{' '}
          <span aria-hidden="true" className={`${endCard.break} ${endCard.phoneBreak}`} />
          <span className={endCard.word}>ADE</span>{' '}
          <span className={endCard.word}>that</span>{' '}
          <span aria-hidden="true" className={endCard.break} />
          <span className={endCard.word}>sets</span>{' '}
          <span className={endCard.word}>the</span>{' '}
          <span className={endCard.word}>standard</span>
        </h1>
        <p className={`hero-subtitle max-w-3xl text-balance text-white/76 ${endCard.heroCopy}`}>
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
    <div className={`${endCard.actions} ${endCard.heroActions}`}>
      <a href="/download" className={endCard.button}>
        <span className={endCard.buttonLabel}>
          Download Blame
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={endCard.arrow}
          >
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </span>
      </a>
      <a href={githubRepositoryUrl} className={`${endCard.button} ${endCard.buttonSecondary}`}>
        <span className={endCard.buttonLabel}>
          <GitHubMark className={endCard.arrow} />
          Star on GitHub
        </span>
      </a>
    </div>
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
