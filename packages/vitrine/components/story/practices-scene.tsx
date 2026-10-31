"use client";

import gsap from "gsap";
import { ListChecks } from "lucide-react";
import { useSceneTimeline } from "@/components/story/use-scene-timeline";
import styles from "./practices-scene.module.css";

// The code practices beat, told in the presentation video's language: Blame's
// practices card, where a cursor switches the project from "Match codebase"
// to "Pro standard", each practice ticks on with the standard it now holds,
// and the agents that will follow it pop in underneath.

const practices = [
  { name: "Coding style", standard: "Explicit, typed, focused" },
  { name: "Unit tests", standard: "TDD with ZOMBIES cases" },
  { name: "Architecture", standard: "Ports and adapters" },
  { name: "Commits", standard: "Conventional Commits" },
];

const agents = [
  { name: "Claude", color: "#f97316" },
  { name: "Gemini", color: "#93c5fd" },
  { name: "GPT", color: "#6ee7b7" },
];

const CURSOR_IN = 0.8;
const CLICK = 1.7;
const ROW_START = 2.05;
const ROW_STEP = 0.3;
const AGENTS = ROW_START + practices.length * ROW_STEP + 0.12;

// Where a point of an element sits in the card's frame, in percent of the
// frame, so the cursor lands on it whatever width the card is drawn at.
function pointOn(frame: HTMLElement, target: Element, fx: number, fy: number) {
  const box = frame.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  return {
    left: `${((rect.left - box.left + rect.width * fx) / box.width) * 100}%`,
    top: `${((rect.top - box.top + rect.height * fy) / box.height) * 100}%`,
  };
}

function buildPractices(timeline: gsap.core.Timeline, root: HTMLElement) {
  const frame = root.querySelector<HTMLElement>(".pr-scale");
  const pro = root.querySelector(".pr-pro");
  if (!frame || !pro) return;
  const click = pointOn(frame, pro, 0.58, 0.62);
  gsap.set(".pr-ripple", click);

  // the copy arrives first: the headline words come in from the right, blurred
  timeline.fromTo(
    ".pr-eyebrow",
    { y: 14, opacity: 0 },
    { y: 0, opacity: 1, duration: 0.5, ease: "power2.out" },
    0,
  );
  timeline.fromTo(
    ".pr-word",
    {
      x: () => Math.min(230, window.innerWidth * 0.16),
      opacity: 0,
      filter: "blur(8px)",
    },
    {
      x: 0,
      opacity: 1,
      filter: "blur(0px)",
      duration: 0.42,
      ease: "power4.out",
      stagger: 0.045,
    },
    0.08,
  );
  timeline.fromTo(
    ".pr-copy",
    { y: 16, opacity: 0, filter: "blur(6px)" },
    { y: 0, opacity: 1, filter: "blur(0px)", duration: 0.6, ease: "power3.out" },
    0.34,
  );

  // the practices card drops in slightly blurred, still matching the codebase
  timeline.fromTo(
    ".pr-card",
    { y: -36, scale: 0.92, opacity: 0, filter: "blur(12px)" },
    {
      y: 0,
      scale: 1,
      opacity: 1,
      filter: "blur(0px)",
      duration: 0.6,
      ease: "power3.out",
    },
    0.45,
  );

  // a cursor comes up in one calm arc and presses Pro standard
  timeline.fromTo(
    ".pr-cursor",
    { opacity: 0 },
    { opacity: 1, duration: 0.3, ease: "power2.out" },
    CURSOR_IN,
  );
  timeline.fromTo(
    ".pr-cursor",
    { left: "84%" },
    { left: click.left, duration: CLICK - CURSOR_IN - 0.05, ease: "power2.inOut" },
    CURSOR_IN,
  );
  timeline.fromTo(
    ".pr-cursor",
    { top: "112%" },
    { top: click.top, duration: CLICK - CURSOR_IN - 0.05, ease: "sine.inOut" },
    CURSOR_IN,
  );
  timeline.to(".pr-segment", { scale: 0.97, duration: 0.09, ease: "power2.in" }, CLICK);
  timeline.to(".pr-segment", { scale: 1, duration: 0.25, ease: "power2.out" }, CLICK + 0.09);
  timeline.fromTo(
    ".pr-ripple",
    { scale: 0.2, opacity: 0.9 },
    {
      scale: 1.4,
      opacity: 0,
      duration: 0.55,
      ease: "power3.out",
      immediateRender: false,
    },
    CLICK,
  );

  // the switch answers: its thumb slides over and turns blue
  timeline.fromTo(
    ".pr-thumb",
    { left: "0%" },
    { left: "50%", duration: 0.45, ease: "expo.out" },
    CLICK + 0.04,
  );
  timeline.fromTo(
    ".pr-thumb-pro",
    { opacity: 0 },
    { opacity: 1, duration: 0.25, ease: "power2.out" },
    CLICK + 0.08,
  );
  timeline.fromTo(
    ".pr-codebase",
    { color: "#fafafa" },
    { color: "#a8a8a8", duration: 0.25, ease: "power2.out" },
    CLICK + 0.08,
  );
  timeline.fromTo(
    ".pr-pro",
    { color: "#93c5fd" },
    { color: "#ffffff", duration: 0.25, ease: "power2.out" },
    CLICK + 0.08,
  );

  // every practice switches on in turn, with the standard it now applies
  root.querySelectorAll<HTMLElement>(".pr-row").forEach((row, j) => {
    const t = ROW_START + j * ROW_STEP;
    const icon = row.querySelector(".pr-icon");
    timeline.fromTo(
      row.querySelector(".pr-check"),
      { opacity: 0 },
      { opacity: 1, duration: 0.18, ease: "power2.out" },
      t,
    );
    timeline.fromTo(
      icon,
      { scale: 1 },
      { scale: 1.3, duration: 0.14, ease: "power2.out" },
      t,
    );
    timeline.to(icon, { scale: 1, duration: 0.3, ease: "power2.inOut" }, t + 0.14);
    timeline.fromTo(
      row,
      { color: "#a1a1a1" },
      { color: "#fafafa", duration: 0.2, ease: "power2.out" },
      t,
    );
    timeline.fromTo(
      row.querySelector(".pr-value"),
      { x: 14, opacity: 0 },
      { x: 0, opacity: 1, duration: 0.3, ease: "power3.out" },
      t,
    );
  });

  // the cursor eases off while the practices switch on, then leaves
  timeline.to(
    ".pr-cursor",
    { left: "80%", top: "104%", duration: 1.6, ease: "power2.inOut" },
    CLICK + 0.3,
  );
  timeline.to(".pr-cursor", { opacity: 0, duration: 0.35, ease: "power2.in" }, AGENTS);

  // and every agent on the project follows it
  timeline.fromTo(
    ".pr-foot-label",
    { opacity: 0.4 },
    { opacity: 1, duration: 0.3, ease: "power2.out" },
    AGENTS - 0.1,
  );
  timeline.fromTo(
    ".pr-agent",
    { y: 8, scale: 0.6, opacity: 0 },
    {
      y: 0,
      scale: 1,
      opacity: 1,
      duration: 0.4,
      ease: "back.out(2)",
      stagger: 0.1,
    },
    AGENTS,
  );
}

export function PracticesScene() {
  const ref = useSceneTimeline<HTMLDivElement>(buildPractices);
  return (
    <div
      ref={ref}
      className="mx-auto grid max-w-7xl items-center gap-14 sm:gap-16 lg:grid-cols-2 lg:gap-16 xl:gap-24"
    >
      <div className="overflow-x-clip">
        <p className="story-eyebrow pr-eyebrow">Code practices</p>
        <h2 className="story-title mt-5 max-w-xl text-[#f5f5f7]">
          <span className="pr-word inline-block">Every</span>{" "}
          <span className="pr-word inline-block">agent</span>{" "}
          <span className="pr-word inline-block text-[#dedede]">codes</span>{" "}
          <span className="pr-word inline-block">like a pro.</span>
        </h2>
        <p className="story-copy pr-copy mt-6 max-w-xl">
          Blame holds every implementation to professional engineering
          standards: clean code, verified changes, sound architecture, and a
          commit history your team can trust.
        </p>
      </div>
      <PracticesCard />
    </div>
  );
}

function PracticesCard() {
  return (
    <div className={`${styles.frame} lg:justify-self-end`}>
      <div className={`pr-scale ${styles.scale}`}>
        <div className={`pr-card ${styles.card}`}>
          <div className={styles.head}>
            <span className={styles.tile} aria-hidden="true">
              <ListChecks strokeWidth={2.2} />
            </span>
            <p className={styles.title}>Code practices</p>
            <span className={styles.count}>4 practices</span>
          </div>
          <div className={styles.body}>
            <p className="sr-only">Standard: Pro standard.</p>
            <span className={`pr-segment ${styles.segment}`} aria-hidden="true">
              <span className={styles.track}>
                <span className={`pr-thumb ${styles.thumb}`}>
                  <span className={styles.thumbBase} />
                  <span className={`pr-thumb-pro ${styles.thumbPro}`} />
                </span>
              </span>
              <span className={`pr-codebase ${styles.option} ${styles.codebase}`}>
                Match codebase
              </span>
              <span className={`pr-pro ${styles.option} ${styles.pro}`}>
                Pro standard
              </span>
            </span>
            <ul className={styles.rows}>
              {practices.map((practice) => (
                <li key={practice.name} className={`pr-row ${styles.row}`}>
                  <span className={`pr-icon ${styles.icon}`} aria-hidden="true">
                    <span className={`pr-check ${styles.check}`}>
                      <svg
                        viewBox="0 0 14 14"
                        fill="none"
                        stroke="#ffffff"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M3 7.5l2.8 2.8L11 4.5" />
                      </svg>
                    </span>
                  </span>
                  <span className={styles.name}>{practice.name}</span>
                  <span className={`pr-value ${styles.value}`}>
                    {practice.standard}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className={styles.foot}>
            <p className={`pr-foot-label ${styles.footLabel}`}>Followed by</p>
            <ul className={styles.agents}>
              {agents.map((agent) => (
                <li key={agent.name} className={`pr-agent ${styles.agent}`}>
                  <svg viewBox="0 0 28 28" aria-hidden="true">
                    <path
                      d="M4 2.5l17 10-7.6 1.9-3.4 7.2z"
                      fill={agent.color}
                      stroke="#0b0b0f"
                      strokeWidth="1.6"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span
                    className={styles.agentName}
                    style={{ background: agent.color }}
                  >
                    {agent.name}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <span className={`pr-ripple ${styles.ripple}`} aria-hidden="true" />
        <svg
          className={`pr-cursor ${styles.cursor}`}
          viewBox="0 0 28 28"
          aria-hidden="true"
        >
          <path
            d="M4 2.5l17 10-7.6 1.9-3.4 7.2z"
            fill="#ffffff"
            stroke="#0b0b0f"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </div>
  );
}
