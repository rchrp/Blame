import { AppWindowIcon, LoaderCircleIcon } from "lucide-react"
import type * as React from "react"

import { cn } from "@/lib/utils"

// The page's place while its app does not show: the same frame from "not
// started" to "starting" to the page, so only what it says changes. The
// backdrop (the launch clouds) lies behind what it says.
export function PreviewIdleFrame({
  backdrop,
  children,
}: {
  backdrop?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden px-4 pt-16 pb-4">
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border bg-background">
        {backdrop}
        <div className="relative h-full">{children}</div>
      </div>
    </div>
  )
}

// Clouds in the blues of a story card's glow (use-animated-border-effect)
// drifting behind the launch steps, kept small. Filling,
// they swell over the whole frame and melt into the neutral the page then
// appears out of (--preview-reveal). Only transforms and colors change,
// on a few blurred layers.
const launchClouds = [
  {
    className: "top-[22%] left-[20%] h-[34%] w-[30%]",
    color: "oklch(0.7 0.21 245)",
    radius: "58% 42% 63% 37% / 46% 55% 45% 54%",
    duration: 11,
    delay: -2,
  },
  {
    className: "top-[28%] left-[46%] h-[30%] w-[28%]",
    color: "oklch(0.62 0.22 255)",
    radius: "41% 59% 38% 62% / 57% 39% 61% 43%",
    duration: 13,
    delay: -7,
  },
  {
    className: "top-[44%] left-[28%] h-[30%] w-[30%]",
    color: "oklch(0.85 0.12 235)",
    radius: "63% 37% 52% 48% / 38% 61% 39% 62%",
    duration: 9,
    delay: -4,
  },
  {
    className: "top-[46%] left-[52%] h-[26%] w-[24%]",
    color: "oklch(0.8 0.16 240)",
    radius: "37% 63% 46% 54% / 59% 42% 58% 41%",
    duration: 15,
    delay: -10,
  },
]

export function PreviewLaunchClouds({ filling }: { filling: boolean }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 animate-in overflow-hidden duration-700 fade-in-0 motion-reduce:animate-none"
    >
      {launchClouds.map((cloud, index) => (
        <span
          key={index}
          className={cn(
            "absolute transition-transform duration-700 ease-in motion-reduce:transition-none",
            cloud.className,
            filling && "scale-[3.5]"
          )}
        >
          <span
            className="preview-ambilight-patch absolute inset-0 opacity-45 blur-[48px] transition-[background-color] duration-700 dark:opacity-60"
            style={{
              animationDelay: `${cloud.delay}s`,
              animationDuration: `${cloud.duration}s`,
              backgroundColor: filling ? "var(--preview-reveal)" : cloud.color,
              borderRadius: cloud.radius,
            }}
          />
        </span>
      ))}
      <span
        className={cn(
          "absolute inset-0 bg-(--preview-reveal) opacity-0 transition-opacity duration-700 ease-in motion-reduce:transition-none",
          filling && "opacity-100"
        )}
      />
    </div>
  )
}

export function PreviewNotStarted() {
  return (
    <PreviewIdleMessage>
      <AppWindowIcon className="size-8 text-muted-foreground" />
      <div className="space-y-1">
        <h3 className="font-heading text-lg font-semibold">
          The preview is not started
        </h3>
        <p className="max-w-sm text-sm text-pretty text-muted-foreground">
          Start the app with the run controls above: its page opens here.
        </p>
      </div>
    </PreviewIdleMessage>
  )
}

// A project's own app, started: the page opens once it answers.
export function StartedAppWaiting({ source }: { source: string }) {
  return (
    <PreviewIdleMessage>
      <LoaderCircleIcon className="size-8 animate-spin text-muted-foreground" />
      <div className="space-y-1">
        <h3 className="font-heading text-lg font-semibold">Starting the app</h3>
        <p className="text-sm text-muted-foreground">
          The preview opens as soon as {previewHost(source)} answers.
        </p>
      </div>
    </PreviewIdleMessage>
  )
}

// Each message fades in where the last one was.
export function PreviewIdleMessage({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="flex h-full w-full animate-in flex-col items-center justify-center gap-4 p-8 text-center duration-500 fade-in-0 motion-reduce:animate-none">
      {children}
    </div>
  )
}

// The arrow's tip, in its 132 × 112 box, and the way it points there.
const arrowTip = { x: 126, y: 4 }
const arrowSlope = 0.636 // across for each step up, at the tip
// How far below the Start button's edge the tip stops.
const arrowClearance = "10px"

// A hand-drawn arrow, drawn as the screen appears, from the message up to
// the Start button. The preview measures where that button is
// (--preview-start-right and --preview-start-top: its center, from the
// toolbar's right and top; --preview-start-half: half its height), and the
// tip sits on the line the arrow points along, just under it.
export function PreviewStartArrow() {
  const below = `(var(--preview-start-half) + ${arrowClearance})`
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute h-28 w-[8.25rem] animate-in text-muted-foreground/80 duration-300 fade-in-0 motion-reduce:animate-none"
      fill="none"
      style={{
        right: `calc(var(--preview-start-right) + ${below} * ${arrowSlope} - ${132 - arrowTip.x}px)`,
        top: `calc(var(--preview-start-top) + ${below} - ${arrowTip.y}px)`,
      }}
      viewBox="0 0 132 112"
    >
      <g
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.6"
      >
        <path
          className="preview-marker-stroke"
          d="M 6 104 C 36 102, 70 92, 90 70 C 106 52, 112 26, 126 4"
          pathLength={1}
        />
        <path
          className="preview-marker-stroke preview-marker-stroke-late"
          d="M 126 4 L 110.3 12.9 M 126 4 L 124.6 21.9"
          pathLength={1}
        />
      </g>
    </svg>
  )
}

function previewHost(source: string) {
  try {
    return new URL(source).host
  } catch {
    return source
  }
}
