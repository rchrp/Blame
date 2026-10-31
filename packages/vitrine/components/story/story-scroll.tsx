"use client";

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { useEffect } from "react";
import { connectScrollHolds } from "@/components/story/scroll-hold";
import { storyPinIdPrefix } from "@/components/story/use-scene-timeline";

// How long the page rests, once the visitor stops scrolling, before the
// magnet settles it.
const settleDelay = 0.15;

// The product story's scroll. Lenis owns it: wheel and trackpad scrolling
// glide on one clock with the GSAP animations, a scene stops the page exactly
// where it pins (see scroll-hold), and the magnet moves the page with the
// same physics instead of correcting the browser after the fact. Touch keeps
// the browser's own scrolling. With reduced motion the page scrolls natively
// and nothing holds or snaps.
export function StoryScroll() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const lenis = new Lenis({ autoRaf: false });
    // The holds listen first, so ScrollTrigger only ever sees a held page.
    const disconnectHolds = connectScrollHolds(lenis);
    const stopUpdates = lenis.on("scroll", ScrollTrigger.update);
    const stopMagnet = startMagnet(lenis);
    const tick = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);

    return () => {
      gsap.ticker.remove(tick);
      gsap.ticker.lagSmoothing(500, 33);
      stopMagnet();
      stopUpdates();
      disconnectHolds();
      lenis.destroy();
    };
  }, []);

  return null;
}

// Magnetic scrolling for the product story, applied when scrolling stops:
// - inside a pinned scene's pin, the page carries on in the same direction to
//   its end (or back to its start);
// - when the boundary between two story sections is on screen, the page
//   moves on to the next section's top (or back to the previous section's
//   bottom when scrolling up), so no two sections rest half on screen;
// - anywhere else, inside a section taller than the screen, it stays put.
function startMagnet(lenis: Lenis) {
  let direction = 1;
  let settle: gsap.core.Tween | null = null;

  const wait = () => {
    settle?.kill();
    settle = gsap.delayedCall(settleDelay, () => {
      if (lenis.isStopped || lenis.isTouching || lenis.isScrolling === "smooth") {
        return;
      }
      const scroll = lenis.scroll;
      const target = snapTarget(scroll, direction);
      const distance = Math.abs(target - scroll);
      if (distance < 2) return;
      lenis.scrollTo(target, {
        duration: Math.min(1.1, Math.max(0.45, (distance / window.innerHeight) * 1.2)),
        easing: easeInOutCubic,
      });
    });
  };

  const stopScroll = lenis.on("scroll", () => {
    if (lenis.direction) direction = lenis.direction;
    wait();
  });
  // A finger lifted without moving the page still settles it.
  const stopInput = lenis.on("virtual-scroll", wait);

  return () => {
    settle?.kill();
    stopScroll();
    stopInput();
  };
}

function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
}

function snapTarget(scroll: number, direction: number) {
  const forward = direction >= 0;
  const activePin = ScrollTrigger.getAll().find(
    (trigger) =>
      String(trigger.vars.id ?? "").startsWith(storyPinIdPrefix) &&
      scroll > trigger.start + 2 &&
      scroll < trigger.end - 2,
  );
  if (activePin) return forward ? activePin.end : activePin.start;

  const screen = window.innerHeight;
  for (const [index, top] of storySectionTops().entries()) {
    if (scroll > top - screen + 2 && scroll < top - 2) {
      // Above the first story section is the hero: going back up returns to
      // the top of the page.
      const back = index === 0 ? 0 : top - screen;
      return forward ? top : back;
    }
  }
  return scroll;
}

// Where each story section's top meets the top of the screen, in page
// scroll positions. A pinned section is measured by its pin spacer, which
// stays in the page flow while the section itself is fixed.
function storySectionTops() {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-story-section]"),
  ).map((section) => {
    const box = section.parentElement?.classList.contains("pin-spacer")
      ? section.parentElement
      : section;
    return box.getBoundingClientRect().top + window.scrollY;
  });
}
