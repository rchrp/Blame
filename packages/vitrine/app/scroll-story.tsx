'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'
import { HeroLoop } from '@/components/demo-video'
import { GitHubMark } from '@/components/github-stars'
import { InstallCommand } from '@/components/install-command'
import { heroLoopVideo } from '@/lib/demo-media'
import { githubRepositoryUrl } from '@/lib/github'
import { HeroBacklogMockup } from '@/components/blame-mockups/backlog-mockup'
import endCard from '@/components/story/cta-scene.module.css'

// The hero follows the scroll in three steps. First the copy fades while the
// demo loop (or the mockup, while the loop is off: see lib/demo-media.ts)
// rises to the middle of the screen, straightens up from a slight tilt and
// grows a little. Then the loop stays there, flat and whole, for a while.
// Last, it tilts away and fades. With reduced motion it only rises, then
// fades.
// Those styles are written straight to the frame, copy and mockup elements
// on each frame, so React renders again only when the hero hides or shows.
// The 3D scene behind the hero is the page's story stage
// (components/story/story-stage.tsx).

const heroStageHeight = 250
const scrollProgressResponse = 14
// Where the rise and the stay end, as parts of the hero's scroll.
const riseEnd = 0.3
const stayEnd = 0.66
// From this point of its scroll on, the hero has faded and takes no input.
const hiddenFrom = 0.9
// How far the loop leans back at the top of the page, and once it leaves,
// in degrees.
const restingTilt = 12
const exitTilt = 30

// Once in the middle, the loop keeps clear of the header and of the screen's
// edges, and grows by a tenth at most.
const headerSpace = 88
const edgeSpace = 24
const sideSpace = 12
const maxGrowth = 1.1
const minScale = 0.8

// How far the loop rises to sit in the middle of the screen, and its scale
// there.
type HeroGeometry = { rise: number; scale: number }
const restingGeometry: HeroGeometry = { rise: 0, scale: 1 }

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

// From tablets up, the copy and the mockup are centered together under the
// header, so a tall screen shows no gap between them; when they don't fit,
// they start at the top and the mockup runs off the bottom of the screen. On
// phones they always start under the header.

// The server renders the top of the scroll; the browser takes over from there.
const initialFrameStyle = heroFrameStyle(0)
const initialCopyStyle = heroCopyStyle(0, false)
const initialMockupStyle = heroMockupStyle(0, false, restingGeometry)

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
          className="absolute inset-0 z-10 mx-auto flex w-full max-w-9xl flex-col justify-start px-5 pb-0 pt-24 sm:px-8 md:justify-center-safe lg:px-10"
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
    // cta-scene.module.css), with the hero's own eyebrow and subtitle.
    <div className={`${endCard.scene} ${endCard.heroScene}`}>
      <p className={endCard.heroEyebrow}>
        <span className={endCard.heroEyebrowName}>Blame ADE</span>
        <span aria-hidden="true">·</span>
        <span className="hidden sm:inline">
          The open-source agentic development environment
        </span>
        <span className="sm:hidden">Open-source agentic dev environment</span>
      </p>
      <h1 id="hero-title" className={`${endCard.title} ${endCard.heroTitle}`}>
        <span className="whitespace-nowrap">Run coding agents</span>{' '}
        <span className="whitespace-nowrap">in parallel,</span>
        <br className="hidden md:inline" />{' '}
        <span className="whitespace-nowrap">each with</span>{' '}
        <span className="whitespace-nowrap">its own</span>{' '}
        <span className={`${endCard.hl} ${endCard.hlIntro}`}>
          <span className={endCard.hlBox}>
            <span className={endCard.hlText}>live preview.</span>
          </span>
        </span>
      </h1>
      <p className={`hero-subtitle max-w-4xl text-balance text-white/76 ${endCard.heroCopy}`}>
        No conflicts: every agent gets its own ports, database, and services.
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
  let geometry = restingGeometry
  const render = (progress: number) => {
    applyLayerStyle(layers.frame.current, heroFrameStyle(progress))
    applyLayerStyle(layers.copy.current, heroCopyStyle(progress, reducedMotion))
    applyLayerStyle(
      layers.mockup.current,
      heroMockupStyle(progress, reducedMotion, geometry),
    )
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
  // The copy's and the loop's sizes change with the screen and once the
  // fonts load: the loop's place in the middle follows them.
  const measure = () => {
    geometry = measureHeroGeometry(layers.mockup.current)
    render(state.current)
  }
  const resize = () => {
    measure()
    update()
  }
  const sizes = new ResizeObserver(measure)
  for (const layer of [layers.copy.current, layers.mockup.current]) {
    if (layer) sizes.observe(layer)
  }

  render(initial)
  window.addEventListener('scroll', update, { passive: true })
  window.addEventListener('resize', resize)
  media.addEventListener('change', updateMotion)
  return () => {
    if (state.frame) window.cancelAnimationFrame(state.frame)
    sizes.disconnect()
    window.removeEventListener('scroll', update)
    window.removeEventListener('resize', resize)
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

// The frame fills the pinned screen, so the loop's offsets in it are its
// place on screen before any transform.
function measureHeroGeometry(mockup: HTMLElement | null): HeroGeometry {
  if (!mockup?.offsetHeight) return restingGeometry
  const { offsetHeight: height, offsetTop: top, offsetWidth: width } = mockup
  const room = window.innerHeight - headerSpace - 2 * edgeSpace
  const scale = clamp(
    Math.min(room / height, (window.innerWidth - 2 * sideSpace) / width),
    minScale,
    maxGrowth,
  )
  const middle = headerSpace + edgeSpace + room / 2
  return { rise: Math.min(0, middle - (top + height / 2)), scale }
}

function heroFrameStyle(progress: number): LayerStyle {
  return {
    opacity: 1 - smoothstep(hiddenFrom, 0.98, progress),
    pointerEvents: progress < hiddenFrom ? 'auto' : 'none',
  }
}

// The copy is gone before the loop reaches the middle.
function heroCopyStyle(
  progress: number,
  reducedMotion: boolean,
): LayerStyle {
  const amount = easeOut(timelineProgress(progress, 0, riseEnd * 0.75))
  if (reducedMotion) return { opacity: 1 - amount }
  return {
    opacity: 1 - amount,
    transform: `translate3d(0, ${amount * -72}px, 0) scale(${1 - amount * 0.035})`,
  }
}

function heroMockupStyle(
  progress: number,
  reducedMotion: boolean,
  geometry: HeroGeometry,
): LayerStyle {
  const rise = smoothstep(0, riseEnd, progress)
  const opacity = 1 - smoothstep(stayEnd + 0.04, hiddenFrom, progress)
  const y = geometry.rise * rise
  if (reducedMotion) return { opacity, transform: `translate3d(0, ${y}px, 0)` }
  // While it stays, it keeps growing a touch, so the scroll still shows.
  const stay = timelineProgress(progress, riseEnd, stayEnd)
  const exit = easeIn(timelineProgress(progress, stayEnd, 1))
  const scale =
    (1 + (geometry.scale - 1) * rise) * (1 + stay * 0.025) * (1 + exit * 0.3)
  const tilt = (1 - rise) * restingTilt + exit * exitTilt
  return {
    opacity,
    transform: `translate3d(0, ${y}px, 0) translate3d(0, ${exit * -30}vh, 0) perspective(1200px) rotate3d(1, -0.16, 0, ${tilt}deg) scale(${scale})`,
  }
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

function easeIn(value: number) {
  return Math.pow(clamp(value, 0, 1), 2)
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}
