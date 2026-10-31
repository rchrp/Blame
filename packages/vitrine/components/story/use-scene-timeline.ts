"use client";

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useEffect, useRef } from "react";

gsap.registerPlugin(ScrollTrigger);
ScrollTrigger.config({ ignoreMobileResize: true });

export type SceneTimelineBuilder<T extends HTMLElement> = (
  timeline: gsap.core.Timeline,
  root: T,
) => void;

type SceneTimelineOptions = {
  // "pin" (default): the scene's story section stays fixed on screen while
  // scrolling plays the timeline, then the page scrolls on.
  // "enter": the timeline plays once the element scrolls into view, for
  // small parts that live outside a pinned section's animation.
  mode?: "pin" | "enter";
};

// Scroll for one second of animation, as a share of the screen height.
const scrollPerSecond = 0.26;
// The timeline starts while the section rises into view, so its heading is
// already written when the section reaches the top and pins.
const approachShare = 0.6;

export const storyPinIdPrefix = "story-pin-";
let pinCount = 0;

// Drives a GSAP timeline, ported from the Blame presentation video, from the
// page scroll. The story section (the closest [data-story-section]) pins at
// the top of the screen for as long as the animation needs, and the scroll
// position is the animation's progress, so a scene can't be skipped half
// played. With reduced motion the scene shows its final state and nothing
// pins. `build` must be a module-level function: it adds the tweens to the
// timeline, and its selectors are scoped to the root.
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

      if (reducedMotion) {
        timeline.progress(1);
        return;
      }

      if (mode === "enter" || !section) {
        ScrollTrigger.create({
          trigger: root,
          start: "top 80%",
          onEnter: () => timeline.play(),
          onLeaveBack: () => timeline.pause(0),
        });
        return;
      }

      const pinDistance = () =>
        Math.round(timeline.duration() * scrollPerSecond * window.innerHeight);
      const fit = section.querySelector<HTMLElement>("[data-story-fit]");
      const fitToScreen = () => fitSceneToScreen(section, fit);
      fitToScreen();
      ScrollTrigger.addEventListener("refreshInit", fitToScreen);

      // A section that still overflows the screen (on phones) pins once its
      // end reaches the bottom of the screen, so the animated picture stays
      // in view; its heading was read on the way.
      const pin = ScrollTrigger.create({
        id: `${storyPinIdPrefix}${(pinCount += 1)}`,
        trigger: section,
        start: () =>
          section.offsetHeight > window.innerHeight ? "bottom bottom" : "top top",
        end: () => `+=${pinDistance()}`,
        pin: true,
        anticipatePin: 1,
        invalidateOnRefresh: true,
      });
      ScrollTrigger.create({
        trigger: section,
        start: `top ${100 - approachShare * 100}%`,
        end: () => pin.end,
        scrub: 0.5,
        animation: timeline,
        invalidateOnRefresh: true,
      });

      return () => {
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
