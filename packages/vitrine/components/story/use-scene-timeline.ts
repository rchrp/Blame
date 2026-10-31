"use client";

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useEffect, useRef } from "react";
import {
  holdScroll,
  releaseScroll,
  type ScrollHold,
} from "@/components/story/scroll-hold";

gsap.registerPlugin(ScrollTrigger);
ScrollTrigger.config({ ignoreMobileResize: true });

export type SceneTimelineBuilder<T extends HTMLElement> = (
  timeline: gsap.core.Timeline,
  root: T,
) => void;

type SceneTimelineOptions = {
  // "pin" (default): the scene's story section stays fixed on screen while
  // the timeline plays, then the page scrolls on.
  // "enter": the timeline plays once the element scrolls into view, for
  // small parts that live outside a pinned section's animation.
  mode?: "pin" | "enter";
};

// The timeline starts once the section's top rises past this point of the
// screen, so its heading is being written as the section settles at the top.
const playAt = "top 55%";
// The pin lasts this share of the screen height: room for a scroll that
// overshoots the pin to land inside it, where nothing moves.
const pinShare = 0.3;

export const storyPinIdPrefix = "story-pin-";
let pinCount = 0;

// Plays a GSAP timeline, ported from the Blame presentation video, when the
// scroll reaches its scene. The timeline runs on its own clock, as in the
// video, never scrubbed by the scroll. The story section (the closest
// [data-story-section]) pins at the top of the screen and the page is held
// there until the animation ends; scrolling down meanwhile only speeds it up.
// It plays again after the section has left the screen downwards. With
// reduced motion the scene shows its final state and nothing pins. `build`
// must be a module-level function: it adds the tweens to the timeline, and
// its selectors are scoped to the root.
export function useSceneTimeline<T extends HTMLElement>(
  build: SceneTimelineBuilder<T>,
  { mode = "pin" }: SceneTimelineOptions = {},
) {
  const rootRef = useRef<T>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const section = root.closest<HTMLElement>("[data-story-section]");
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    const context = gsap.context(() => {
      const timeline = gsap.timeline({ paused: true });
      build(timeline, root);
      // A staggered from() only renders its first target's starting state
      // up front; the others would show their final state until the
      // playhead reaches them. Render the whole timeline once, end then
      // start, so every element begins hidden where the scene says so.
      timeline.progress(1, true).progress(0, true);

      if (reducedMotion) {
        timeline.progress(1);
        return;
      }

      // Rewinds the scene once it is off screen below, so it plays again
      // the next time the visitor scrolls down to it.
      const rewind = () => {
        gsap.killTweensOf(timeline);
        timeline.timeScale(1).pause(0);
      };

      if (mode === "enter" || !section) {
        ScrollTrigger.create({
          trigger: root,
          start: "top 80%",
          onEnter: () => timeline.play(),
        });
        ScrollTrigger.create({
          trigger: root,
          start: "top bottom",
          onLeaveBack: rewind,
        });
        return;
      }

      const fit = section.querySelector<HTMLElement>("[data-story-fit]");
      const fitToScreen = () => fitSceneToScreen(section, fit);
      fitToScreen();
      ScrollTrigger.addEventListener("refreshInit", fitToScreen);

      const hold: ScrollHold = { section, timeline, end: () => pin.end };
      timeline.eventCallback("onComplete", () => releaseScroll(hold));

      // A section that still overflows the screen (on phones) pins once its
      // end reaches the bottom of the screen, so the animated picture stays
      // in view; its heading was read on the way.
      const pin = ScrollTrigger.create({
        id: `${storyPinIdPrefix}${(pinCount += 1)}`,
        trigger: section,
        start: () =>
          section.offsetHeight > window.innerHeight ? "bottom bottom" : "top top",
        end: () => `+=${Math.round(window.innerHeight * pinShare)}`,
        pin: true,
        anticipatePin: 1,
        invalidateOnRefresh: true,
        onEnter: (self) => {
          // A jump that shot past the whole pin doesn't stop on the way.
          if (self.progress >= 1 || timeline.progress() === 1) return;
          if (timeline.paused()) timeline.play();
          holdScroll(hold);
        },
        onLeaveBack: () => releaseScroll(hold),
      });
      ScrollTrigger.create({
        trigger: section,
        start: playAt,
        onEnter: () => timeline.play(),
      });
      ScrollTrigger.create({
        trigger: section,
        start: "top bottom",
        onLeaveBack: () => {
          releaseScroll(hold);
          rewind();
        },
      });

      return () => {
        releaseScroll(hold);
        ScrollTrigger.removeEventListener("refreshInit", fitToScreen);
        if (fit) fit.style.cssText = "";
      };
    }, root);

    scheduleRefresh();
    return () => context.revert();
  }, [build, mode]);

  return rootRef;
}

// On tablets and desktops, a pinned scene taller than the screen is scaled
// down just enough to fit whole while it is pinned, so nothing it animates
// happens below the fold. The negative margin gives the space back to the
// page. Phones keep the full size and pin on the section's end instead.
function fitSceneToScreen(section: HTMLElement, fit: HTMLElement | null) {
  if (!fit) return;
  fit.style.cssText = "";
  if (window.innerWidth < 768) return;
  const style = window.getComputedStyle(section);
  const room =
    window.innerHeight -
    parseFloat(style.paddingTop) -
    parseFloat(style.paddingBottom);
  const height = fit.offsetHeight;
  if (height <= room) return;
  const scale = room / height;
  fit.style.transform = `scale(${scale})`;
  fit.style.transformOrigin = "top center";
  fit.style.marginBottom = `${-(1 - scale) * height}px`;
}

// Pins change the page height: recompute every trigger once, after all the
// scenes mounted, and again when late images and fonts settle the layout.
let refreshTimer = 0;
function scheduleRefresh() {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    ScrollTrigger.sort();
    ScrollTrigger.refresh();
  }, 120);
}

if (typeof window !== "undefined") {
  window.addEventListener("load", () => ScrollTrigger.refresh());
}
