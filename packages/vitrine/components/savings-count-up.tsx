"use client";

import { useEffect, useRef, useState } from "react";

const countDurationMs = 1800;

// Counts from 0 to the measured saving each time the figure scrolls into
// view, as ScrollReveal fades it in. The final value stays in the layout and
// the counting value is drawn over it, so the figure never shifts sideways.
export function SavingsCountUp({ value }: { value: number }) {
  const figureRef = useRef<HTMLSpanElement>(null);
  const [current, setCurrent] = useState(value);

  useEffect(() => {
    const figure = figureRef.current;
    if (!figure || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let frame = 0;
    let armed = true;
    const count = () => {
      window.cancelAnimationFrame(frame);
      setCurrent(0);
      const start = performance.now();
      const tick = (time: number) => {
        const progress = Math.min((time - start) / countDurationMs, 1);
        setCurrent(Math.round(value * easeOutCubic(progress)));
        if (progress < 1) frame = window.requestAnimationFrame(tick);
      };
      frame = window.requestAnimationFrame(tick);
    };
    // Same trigger as ScrollReveal, so the count starts while it fades in.
    const enter = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting || !armed) return;
        armed = false;
        count();
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0 },
    );
    // Count again only after the figure has fully left the screen.
    const exit = new IntersectionObserver(([entry]) => {
      if (entry && !entry.isIntersecting) armed = true;
    });
    enter.observe(figure);
    exit.observe(figure);
    return () => {
      enter.disconnect();
      exit.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [value]);

  return (
    <span ref={figureRef} className="relative inline-block">
      <span aria-hidden="true" className="invisible">
        −{value}%
      </span>
      <span
        aria-hidden="true"
        className="workspace-smart-sweep absolute right-0 top-0 whitespace-nowrap"
      >
        −{current}%
      </span>
      <span className="sr-only">{value}% fewer</span>
    </span>
  );
}

function easeOutCubic(progress: number) {
  return 1 - Math.pow(1 - progress, 3);
}
