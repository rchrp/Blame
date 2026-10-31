"use client";

import gsap from "gsap";
import { FolderPlus } from "lucide-react";
import { useSceneTimeline } from "@/components/story/use-scene-timeline";
import styles from "./creation-scene.module.css";

// The project creation beat, told in the presentation video's language: a new
// project card where a cursor picks a web stack and presses Create project,
// Blame generates what the project needs one piece after the other, and the
// empty folder turns agent-ready.

const stacks = [
  { name: "Next.js", recommended: true },
  { name: "React + Vite" },
  { name: "Nuxt" },
  { name: "Vue + Vite" },
  { name: "SvelteKit" },
];

const generated = [
  { name: "Structure", value: "Routes and components" },
  { name: "Tooling", value: "pnpm, ESLint, Prettier" },
  { name: "Environment files", value: ".env.example" },
  { name: "Preview configuration", value: "Blame preview" },
];

const CURSOR_IN = 0.8;
const PICK = 1.7;
const CREATE = 2.75;
const ROW_START = 3.05;
const ROW_STEP = 0.3;
const READY = ROW_START + generated.length * ROW_STEP + 0.12;

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

// The button press of the video: a quick dip, then back.
function press(timeline: gsap.core.Timeline, target: string, at: number) {
  timeline.to(target, { scale: 0.93, duration: 0.09, ease: "power2.in" }, at);
  timeline.to(target, { scale: 1, duration: 0.25, ease: "power2.out" }, at + 0.09);
}

function ripple(timeline: gsap.core.Timeline, target: string, at: number) {
  timeline.fromTo(
    target,
    { scale: 0.2, opacity: 0.9 },
    {
      scale: 1.4,
      opacity: 0,
      duration: 0.55,
      ease: "power3.out",
      immediateRender: false,
    },
    at,
  );
}

function buildCreation(timeline: gsap.core.Timeline, root: HTMLElement) {
  const frame = root.querySelector<HTMLElement>(".cr-scale");
  const stack = root.querySelector(".cr-stack-picked");
  const create = root.querySelector(".cr-create");
  if (!frame || !stack || !create) return;
  const onStack = pointOn(frame, stack, 0.3, 0.62);
  const onCreate = pointOn(frame, create, 0.55, 0.62);
  gsap.set(".cr-ripple-stack", onStack);
  gsap.set(".cr-ripple-create", onCreate);

  // the copy arrives first: the headline words come in from the right, blurred
  timeline.fromTo(
    ".cr-eyebrow",
    { y: 14, opacity: 0 },
    { y: 0, opacity: 1, duration: 0.5, ease: "power2.out" },
    0,
  );
  timeline.fromTo(
    ".cr-word",
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
    ".cr-copy",
    { y: 16, opacity: 0, filter: "blur(6px)" },
    { y: 0, opacity: 1, filter: "blur(0px)", duration: 0.6, ease: "power3.out" },
    0.34,
  );

  // the new project card drops in slightly blurred, still an empty folder
  timeline.fromTo(
    ".cr-card",
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

  // a cursor comes up in one calm arc and picks Next.js
  timeline.fromTo(
    ".cr-cursor",
    { opacity: 0 },
    { opacity: 1, duration: 0.3, ease: "power2.out" },
    CURSOR_IN,
  );
  timeline.fromTo(
    ".cr-cursor",
    { left: "82%" },
    { left: onStack.left, duration: PICK - CURSOR_IN - 0.05, ease: "power2.inOut" },
    CURSOR_IN,
  );
  timeline.fromTo(
    ".cr-cursor",
    { top: "112%" },
    { top: onStack.top, duration: PICK - CURSOR_IN - 0.05, ease: "sine.inOut" },
    CURSOR_IN,
  );
  press(timeline, ".cr-stack-picked", PICK);
  ripple(timeline, ".cr-ripple-stack", PICK);
  timeline.fromTo(
    ".cr-picked",
    { opacity: 0 },
    { opacity: 1, duration: 0.2, ease: "power2.out" },
    PICK + 0.05,
  );

  // then on to Create project
  timeline.to(
    ".cr-cursor",
    { left: onCreate.left, duration: CREATE - PICK - 0.3, ease: "power2.inOut" },
    PICK + 0.25,
  );
  timeline.to(
    ".cr-cursor",
    { top: onCreate.top, duration: CREATE - PICK - 0.3, ease: "sine.inOut" },
    PICK + 0.25,
  );
  press(timeline, ".cr-create", CREATE);
  ripple(timeline, ".cr-ripple-create", CREATE);
  timeline.fromTo(
    ".cr-flash",
    { opacity: 0.7 },
    { opacity: 0, duration: 0.4, ease: "power2.out", immediateRender: false },
    CREATE + 0.02,
  );

  // Blame generates the project, one piece after the other
  root.querySelectorAll<HTMLElement>(".cr-row").forEach((row, j) => {
    const t = ROW_START + j * ROW_STEP;
    const icon = row.querySelector(".cr-icon");
    timeline.fromTo(
      row.querySelector(".cr-check"),
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
      row.querySelector(".cr-value"),
      { x: 14, opacity: 0 },
      { x: 0, opacity: 1, duration: 0.3, ease: "power3.out" },
      t,
    );
  });

  // the empty folder is agent-ready: badge, preview and button all answer
  timeline.fromTo(
    ".cr-empty",
    { opacity: 1 },
    { opacity: 0, duration: 0.2, ease: "power2.in" },
    READY,
  );
  timeline.fromTo(
    ".cr-ready",
    { opacity: 0, scale: 0.8 },
    { opacity: 1, scale: 1, duration: 0.35, ease: "back.out(2)" },
    READY + 0.1,
  );
  timeline.fromTo(
    ".cr-dot",
    { backgroundColor: "#525252", boxShadow: "0 0 0em rgba(16, 185, 129, 0)" },
    {
      backgroundColor: "#10b981",
      boxShadow: "0 0 0.6em rgba(16, 185, 129, 1)",
      duration: 0.25,
      ease: "power2.out",
    },
    READY,
  );
  timeline.fromTo(
    ".cr-created",
    { opacity: 0 },
    { opacity: 1, duration: 0.2, ease: "power2.out" },
    READY,
  );

  // the cursor eases off and leaves
  timeline.to(
    ".cr-cursor",
    { left: "76%", top: "106%", duration: 1.2, ease: "power2.inOut" },
    CREATE + 0.3,
  );
  timeline.to(".cr-cursor", { opacity: 0, duration: 0.35, ease: "power2.in" }, READY);
}

export function CreationScene() {
  const ref = useSceneTimeline<HTMLDivElement>(buildCreation);
  return (
    <div
      ref={ref}
      className="mx-auto grid max-w-7xl items-center gap-14 sm:gap-16 lg:grid-cols-2 lg:gap-16 xl:gap-24"
    >
      <div className="overflow-x-clip lg:col-start-2 lg:row-start-1">
        <p className="story-eyebrow cr-eyebrow">Project creation</p>
        <h2 className="story-title mt-5 max-w-xl text-[#f5f5f7]">
          <span className="cr-word inline-block text-[#dedede]">From</span>{" "}
          <span className="cr-word inline-block">empty</span>{" "}
          <span className="cr-word inline-block">folder</span>{" "}
          <span className="cr-word inline-block text-[#dedede]">to</span>{" "}
          <span className="cr-word inline-block">agent-ready.</span>
        </h2>
        <p className="story-copy cr-copy mt-6 max-w-xl">
          Choose a web stack. Blame generates the structure, tooling,
          environment files, and preview configuration inside the same
          workflow.
        </p>
      </div>
      <CreationCard />
    </div>
  );
}

function CreationCard() {
  return (
    <div
      className={`${styles.frame} lg:col-start-1 lg:row-start-1 lg:justify-self-start`}
    >
      <div className={`cr-scale ${styles.scale}`}>
        <div className={`cr-card ${styles.card}`}>
          <div className={styles.head}>
            <span className={styles.label}>
              <FolderPlus aria-hidden="true" strokeWidth={2} />
              New project
            </span>
            <span className={styles.badges}>
              <span
                className={`cr-empty ${styles.badge} ${styles.empty}`}
                aria-hidden="true"
              >
                Empty folder
              </span>
              <span className={`cr-ready ${styles.badge} ${styles.ready}`}>
                Agent-ready
              </span>
            </span>
          </div>
          <p className={styles.title}>storefront</p>
          <p className={styles.stackLabel}>Web stack</p>
          <ul className={styles.stacks}>
            {stacks.map((stack) => (
              <li
                key={stack.name}
                className={`${stack.recommended ? "cr-stack-picked" : ""} ${styles.stack}`}
              >
                {stack.recommended ? (
                  <span
                    className={`cr-picked ${styles.picked}`}
                    aria-hidden="true"
                  />
                ) : null}
                {stack.name}
                {stack.recommended ? (
                  <span className={styles.recommended}>
                    Recommended<span className="sr-only">, selected</span>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          <ul className={styles.rows}>
            {generated.map((piece) => (
              <li key={piece.name} className={`cr-row ${styles.row}`}>
                <span className={`cr-icon ${styles.icon}`} aria-hidden="true">
                  <span className={`cr-check ${styles.check}`}>
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
                <span className={styles.name}>{piece.name}</span>
                <span className={`cr-value ${styles.value}`}>{piece.value}</span>
              </li>
            ))}
          </ul>
          <div className={styles.foot}>
            <span className={styles.localhost}>
              <span className={`cr-dot ${styles.dot}`} aria-hidden="true" />
              localhost:3000
            </span>
            <span className={`cr-create ${styles.create}`} aria-hidden="true">
              Create project
              <span className={`cr-flash ${styles.flash}`} />
              <span className={`cr-created ${styles.created}`}>
                <svg
                  viewBox="0 0 14 14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 7.5l2.8 2.8L11 4.5" />
                </svg>
                Created
              </span>
            </span>
          </div>
        </div>
        <span
          className={`cr-ripple-stack ${styles.ripple}`}
          aria-hidden="true"
        />
        <span
          className={`cr-ripple-create ${styles.ripple} ${styles.green}`}
          aria-hidden="true"
        />
        <svg
          className={`cr-cursor ${styles.cursor}`}
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
