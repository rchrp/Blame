'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'
import { HeroLoop } from '@/components/demo-video'
import { GitHubMark } from '@/components/github-stars'
import { InstallCommand } from '@/components/install-command'
import { heroLoopVideo } from '@/lib/demo-media'
import { githubRepositoryUrl } from '@/lib/github'
import { HeroBacklogMockup } from '@/components/blame-mockups/backlog-mockup'
import endCard from '@/components/story/cta-scene.module.css'

// The hero follows the scroll: its copy rises and fades, then the mockup (or
// the demo loop, once it is on: see lib/demo-media.ts) tilts up and fades.
// Those styles are written straight to the frame, copy and mockup elements
// on each frame, so React renders again only when the hero hides or shows. The 3D scene behind the hero is the page's story
// stage (components/story/story-stage.tsx).

const heroStageHeight = 180
const scrollProgressResponse = 14
// From this point of its scroll on, the hero has faded and takes no input.
const hiddenFrom = 0.72

type LayerStyle = {
  opacity: number
  pointerEvents?: 'auto' | 'none'
  transform?: string
}

type HeroLayers = {
  copy: RefObject<HTMLDivElement | null>
  frame: RefObject<HTMLDivElement | null>
  mockup: RefObject<HTMLDivElement | null>
}

// The copy and the mockup are centered together under the header, so a tall
// screen shows no gap between them; when they don't fit, they start at the
// top and the mockup runs off the bottom of the screen.

// The server renders the top of the scroll; the browser takes over from there.
const initialFrameStyle = heroFrameStyle(0, false)
const initialCopyStyle = heroCopyStyle(0, false)
const initialMockupStyle = heroMockupStyle(0, false)

type ScrollAnimationState = {
  current: number
  frame: number
  lastFrameTime: number
  target: number
}

export function LandingHero() {
  const sectionRef = useRef<HTMLElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const copyRef = useRef<HTMLDivElement>(null)
  const mockupRef = useRef<HTMLDivElement>(null)
  const [hidden, setHidden] = useState(false)

  useEffect(
    () =>
      connectHeroScroll(
        sectionRef,
        { copy: copyRef, frame: frameRef, mockup: mockupRef },
        setHidden,
      ),
    [],
  )

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
        <div
          ref={frameRef}
          aria-hidden={hidden || undefined}
          className="absolute inset-0 z-10 mx-auto flex w-full max-w-9xl flex-col justify-center-safe px-5 pb-0 pt-24 sm:px-8 lg:px-10"
          inert={hidden || undefined}
          style={initialFrameStyle}
        >
          <div
            ref={copyRef}
            className="flex items-center justify-center pb-8 pt-8"
            style={initialCopyStyle}
          >
            <HeroCopy />
          </div>
          <div
            ref={mockupRef}
            className="z-20 mx-auto mb-4 w-[90%] max-w-[61.2rem]"
            style={initialMockupStyle}
          >
            <HeroLoop
              video={heroLoopVideo}
              playing={!hidden}
              fallback={<HeroBacklogMockup />}
            />
          </div>
        </div>
      </div>
    </section>
  )
}

function HeroCopy() {
  return (
    // The end card's title, highlight, buttons and spacing (see
    // cta-scene.module.css), with the hero's own subtitle.
    <div className={`${endCard.scene} ${endCard.heroScene}`}>
      <h1 id="hero-title" className={`${endCard.title} ${endCard.heroTitle}`}>
        <span className="whitespace-nowrap">Run coding agents</span>{' '}
        <span className="whitespace-nowrap">in parallel.</span>
        <br />
        <span className={`${endCard.hl} ${endCard.hlIntro}`}>
          <span className={endCard.hlBox}>
            <span className={endCard.hlText}>No conflicts.</span>
          </span>
        </span>
      </h1>
      <p className={`hero-subtitle max-w-3xl text-balance text-white/76 ${endCard.heroCopy}`}>
        Each agent gets its own live preview, ports, and database.
      </p>
      <HeroActions />
      <InstallCommand
        className={endCard.heroInstall}
        platform="macOS"
        command="brew install --cask rchrp/tap/blame"
      />
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

// Follows the hero's scroll, smoothed, and writes each frame's styles to its
// layers. React only hears about it when the hero hides or shows again.
function connectHeroScroll(
  section: RefObject<HTMLElement | null>,
  layers: HeroLayers,
  setHidden: (hidden: boolean) => void,
) {
  const media = window.matchMedia('(prefers-reduced-motion: reduce)')
  let reducedMotion = media.matches
  let hidden = false
  const render = (progress: number) => {
    applyLayerStyle(layers.frame.current, heroFrameStyle(progress, reducedMotion))
    applyLayerStyle(layers.copy.current, heroCopyStyle(progress, reducedMotion))
    applyLayerStyle(layers.mockup.current, heroMockupStyle(progress, reducedMotion))
    if (progress >= hiddenFrom !== hidden) {
      hidden = !hidden
      setHidden(hidden)
    }
  }
  const initial = readScrollProgress(section.current)
  const state = createScrollAnimationState(initial)
  const animate = (time: number) =>
    animateScrollProgress(state, render, animate, time)
  const update = () => {
    state.target = readScrollProgress(section.current)
    requestScrollFrame(state, animate)
  }
  const updateMotion = () => {
    reducedMotion = media.matches
    render(state.current)
  }

  render(initial)
  window.addEventListener('scroll', update, { passive: true })
  window.addEventListener('resize', update)
  media.addEventListener('change', updateMotion)
  return () => {
    if (state.frame) window.cancelAnimationFrame(state.frame)
    window.removeEventListener('scroll', update)
    window.removeEventListener('resize', update)
    media.removeEventListener('change', updateMotion)
  }
}

function applyLayerStyle(node: HTMLElement | null, style: LayerStyle) {
  if (!node) return
  node.style.opacity = String(style.opacity)
  node.style.transform = style.transform ?? ''
  if (style.pointerEvents) node.style.pointerEvents = style.pointerEvents
}

function animateScrollProgress(
  state: ScrollAnimationState,
  render: (progress: number) => void,
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
  render(state.current)
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
): LayerStyle {
  const opacity = reducedMotion
    ? reducedMotionOpacity(progress)
    : 1 - smoothstep(hiddenFrom, 0.98, progress)
  return { opacity, pointerEvents: progress < hiddenFrom ? 'auto' : 'none' }
}

function heroCopyStyle(
  progress: number,
  reducedMotion: boolean,
): LayerStyle {
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
): LayerStyle {
  if (reducedMotion) return { opacity: reducedMotionOpacity(progress) }
  const lift = easeOut(timelineProgress(progress, 0, 0.9))
  const fade = smoothstep(0.34, 0.72, progress)
  return {
    opacity: 1 - fade,
    transform: `translate3d(0, ${lift * -42}vh, 0) perspective(1200px) rotate3d(1, -0.16, 0, ${lift * 32}deg) scale(${1 + lift * 0.42})`,
  }
}

function reducedMotionOpacity(progress: number) {
  return progress < hiddenFrom ? 1 : 0
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
