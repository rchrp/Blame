"use client";

import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useEffect } from "react";
import { storyPinIdPrefix } from "@/components/story/use-scene-timeline";

// Magnetic scrolling for the product story, applied when scrolling stops:
// - inside a pinned scene, the page carries on in the same direction to the
//   end of the scene (or back to its start), so its animation always finishes;
// - when the boundary between two story sections is on screen, the page
//   moves on to the next section's top (or back to the previous section's
//   bottom when scrolling up), so no two sections rest half on screen;
// - anywhere else, inside a section taller than the screen, it stays put.
export function StoryMagnet() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const magnet = ScrollTrigger.create({
      start: 0,
      end: "max",
      snap: {
        snapTo: (value, self) => snapTarget(value, self?.direction ?? 1),
        duration: { min: 0.35, max: 2.6 },
        delay: 0.12,
        ease: "power2.inOut",
        inertia: false,
      },
    });
    return () => magnet.kill();
  }, []);

  return null;
}

function snapTarget(value: number, direction: number) {
  const max = ScrollTrigger.maxScroll(window);
  if (max <= 0) return value;
  const scroll = value * max;
  const forward = direction >= 0;
  const toValue = (position: number) =>
    Math.min(1, Math.max(0, position / max));

  const activePin = ScrollTrigger.getAll().find(
    (trigger) =>
      String(trigger.vars.id ?? "").startsWith(storyPinIdPrefix) &&
      scroll > trigger.start + 2 &&
      scroll < trigger.end - 2,
  );
  if (activePin) return toValue(forward ? activePin.end : activePin.start);

  const screen = window.innerHeight;
  const tops = storySectionTops();
  for (const [index, top] of tops.entries()) {
    if (scroll > top - screen + 2 && scroll < top - 2) {
      // Above the first story section is the hero: going back up returns to
      // the top of the page.
      const back = index === 0 ? 0 : top - screen;
      return toValue(forward ? top : back);
    }
  }
  return value;
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
