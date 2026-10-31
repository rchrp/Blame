"use client";

import gsap from "gsap";
import { useEffect, useRef } from "react";

export type SceneTimelineBuilder<T extends HTMLElement> = (
  timeline: gsap.core.Timeline,
  root: T,
) => void;

type SceneTimelineOptions = {
  // Where the scene must reach before it plays, as an IntersectionObserver
  // root margin. The default starts once its top passes 80% of the screen.
  rootMargin?: string;
};

// Plays a GSAP timeline, ported from the Blame presentation video, when its
// scene scrolls into view. It rewinds once the scene has fully left the
// screen, so it plays again on the way back. With reduced motion the scene
// shows its final state. `build` must be a module-level function: it adds the
// tweens to the paused timeline, and its selectors are scoped to the root.
export function useSceneTimeline<T extends HTMLElement>(
  build: SceneTimelineBuilder<T>,
  { rootMargin = "0px 0px -20% 0px" }: SceneTimelineOptions = {},
) {
  const rootRef = useRef<T>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const timeline = gsap.timeline({ paused: true });
    const context = gsap.context(() => build(timeline, root), root);

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      timeline.progress(1);
      return () => context.revert();
    }

    const enter = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting && timeline.progress() === 0) timeline.play();
      },
      { rootMargin, threshold: 0 },
    );
    const exit = new IntersectionObserver(([entry]) => {
      if (entry && !entry.isIntersecting) timeline.pause(0);
    });
    enter.observe(root);
    exit.observe(root);

    return () => {
      enter.disconnect();
      exit.disconnect();
      context.revert();
    };
  }, [build, rootMargin]);

  return rootRef;
}
