"use client";

import {
  createHeroScene,
  type HeroSceneController,
} from "@blame/hero-scene";
import gsap from "gsap";
import { useEffect, useRef } from "react";
import { SceneWarmup } from "@/components/scene-warmup";

// The home page's ground: one 3D scene fixed behind the hero and the whole
// story, as in the presentation video.
// - From the hero on, it has the pricing and download pages' dark vignette
//   and one wide blur towards its edges, so the story reads over it.
// - The camera pans sideways along the ground, one step per story section,
//   so the landscape moves on with every section.
// - The light rings run across the ground on the video's moments (see
//   celebrateStage), and night falls in black and white on the final
//   section.
// - A finished section fades out as it leaves the screen, so two sections are
//   rarely seen at once: it sets --leave on the section (styles in
//   globals.css).
const leaveFrom = 0.9;
const leaveOver = 0.5;
const lookUp = 7;
const panRange = 110;
const panDuration = 1.4;

let stage: HeroSceneController | null = null;

// Sends the light rings across the ground, as the video does when the name
// lands, when a story is merged, and on the end card.
export function celebrateStage() {
  stage?.celebrate();
}

export function StoryStage() {
  const rootRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const container = sceneRef.current;
    if (!root || !container) return;

    const scene = createHeroScene(container, { lookUp, panRange });
    stage = scene;

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const pan = { x: -panRange / 2 };
    scene.setPan(pan.x);
    let step = 0;
    let night = false;
    let lastStory = -1;
    const leaving = new Map<HTMLElement, number>();
    let frame = 0;

    const update = () => {
      frame = 0;
      const sections = Array.from(
        document.querySelectorAll<HTMLElement>("[data-story-section]"),
      );
      if (!sections.length) return;
      const screen = window.innerHeight;
      const tops = sections.map((section) => pageBox(section).getBoundingClientRect());

      // Behind the story's text, the pointer's light stays discreet: it dims
      // as the first section rises over the hero.
      const firstTop = tops[0].top;
      const story = clamp01((screen - firstTop) / (screen * 0.7));
      if (story !== lastStory) {
        lastStory = story;
        scene.setPointerLight(1 - story * 0.6);
      }

      // Each section fades out from when its end rises past 90% of the
      // screen to when it reaches 40%.
      sections.forEach((section, index) => {
        const travelled = screen * leaveFrom - tops[index].bottom;
        const leave = Math.round(clamp01(travelled / (screen * leaveOver)) * 100) / 100;
        if (leaving.get(section) === leave) return;
        leaving.set(section, leave);
        section.style.setProperty("--leave", String(leave));
        section.toggleAttribute("data-leaving", leave > 0);
      });

      // The step is the section across the middle of the screen; the hero
      // is step 0.
      let current = 0;
      tops.forEach((box, index) => {
        if (box.top <= screen / 2) current = index + 1;
      });
      if (current !== step) {
        step = current;
        const x = -panRange / 2 + (step * panRange) / sections.length;
        gsap.to(pan, {
          x,
          duration: reducedMotion ? 0 : panDuration,
          ease: "expo.inOut",
          overwrite: true,
          onUpdate: () => scene.setPan(pan.x),
        });
      }

      // Night falls once the final section holds the middle of the screen.
      const last = tops[tops.length - 1];
      const isNight = last.top <= screen / 2;
      if (isNight !== night) {
        night = isNight;
        scene.setNight(night);
        root.toggleAttribute("data-night", night);
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);

    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
      leaving.forEach((_, section) => {
        section.style.removeProperty("--leave");
        section.removeAttribute("data-leaving");
      });
      gsap.killTweensOf(pan);
      if (stage === scene) stage = null;
      scene.dispose();
    };
  }, []);

  return (
    <div ref={rootRef} aria-hidden="true" className="story-stage">
      <div ref={sceneRef} className="absolute inset-0" />
      <div className="story-stage-rim absolute inset-0" />
      <div className="story-stage-shade absolute inset-0" />
      <SceneWarmup />
    </div>
  );
}

// A pinned section is measured by its pin spacer, which stays in the page.
function pageBox(section: HTMLElement) {
  return section.parentElement?.classList.contains("pin-spacer")
    ? section.parentElement
    : section;
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}
