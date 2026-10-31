"use client";

import { useSceneTimeline } from "@/components/story/use-scene-timeline";
import styles from "./workspace-scene.module.css";

// The presentation video's "smart workspace" beat: three stories get three
// isolated worktrees side by side, each with its own named agent cursor, their
// setup checks tick on in parallel, and a cursor opens a ready preview.

const worktrees = [
  {
    story: "US-706",
    title: "Build repository insights panel",
    branch: "blame/us-706-insights",
    port: "46021",
    agent: "Claude",
    color: "#f97316",
  },
  {
    story: "US-708",
    title: "Add secure credential vault",
    branch: "blame/us-708-vault",
    port: "46023",
    agent: "Gemini",
    color: "#93c5fd",
  },
  {
    story: "US-709",
    title: "Build project activity timeline",
    branch: "blame/us-709-timeline",
    port: "46025",
    agent: "GPT",
    color: "#6ee7b7",
  },
];

// The worktree whose Open Preview gets clicked, the middle one as in the video.
const FOCUS = 1;

// Cursor stops, as percentages of the worktree card's width and height: in
// from an edge, parked by the card top while Blame sets the workspace up, a
// small drift while waiting, then onto the card's Open Preview button.
const CURSOR_START = [
  [-52, 10],
  [50, 150],
  [152, 2],
];
const CURSOR_PARK = [
  [38, -14.2],
  [38, -9.2],
  [44, -14.2],
];
const CURSOR_DRIFT = [3.6, 2.5];
const CURSOR_BUTTON = [74.4, 90];
// on the button too, but below its label, where a hand rests after a click
const CURSOR_REST = [72, 93];

const ROW_START = 1.25;
const ROW_STEP = 0.32;
const READY = 2.85;
const CLICK = 4.3;

function buildWorkspace(timeline: gsap.core.Timeline, root: HTMLElement) {
  const slots = Array.from(root.querySelectorAll<HTMLElement>(".ws-slot"));
  const inSlot = (slot: HTMLElement, selector: string) =>
    slot.querySelector<HTMLElement>(selector);

  // the copy arrives first: the headline words come in from the right, blurred
  timeline.fromTo(
    ".ws-eyebrow",
    { y: 14, opacity: 0 },
    { y: 0, opacity: 1, duration: 0.5, ease: "power2.out" },
    0,
  );
  timeline.fromTo(
    ".ws-word",
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
    ".ws-copy",
    { y: 16, opacity: 0, filter: "blur(6px)" },
    { y: 0, opacity: 1, filter: "blur(0px)", duration: 0.6, ease: "power3.out" },
    0.34,
  );

  // the three worktrees drop in slightly blurred, in reading order (the phone
  // layout puts the focused worktree first)
  const reading = [...slots].sort((a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    return ra.top - rb.top || ra.left - rb.left;
  });
  reading.forEach((slot, k) => {
    timeline.fromTo(
      inSlot(slot, ".ws-card"),
      { y: -36, scale: 0.9, opacity: 0, filter: "blur(12px)" },
      {
        y: 0,
        scale: 1,
        opacity: 1,
        filter: "blur(0px)",
        duration: 0.6,
        ease: "power3.out",
      },
      0.5 + k * 0.14,
    );
  });

  // Blame prepares all three at once: branch, worktree, environment, port, runtime
  slots.forEach((slot, i) => {
    slot.querySelectorAll<HTMLElement>(".ws-row").forEach((row, j) => {
      const t = ROW_START + j * ROW_STEP + i * 0.05;
      const icon = row.querySelector(".ws-icon");
      timeline.to(
        row.querySelector(".ws-check"),
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
      timeline.to(row, { color: "#fafafa", duration: 0.2, ease: "power2.out" }, t);
      timeline.fromTo(
        row.querySelector(".ws-value"),
        { x: 14, opacity: 0 },
        { x: 0, opacity: 1, duration: 0.3, ease: "power3.out" },
        t,
      );
    });
  });

  // each agent: in from an edge, waits by its card while the workspace is
  // prepared, then goes to its Open Preview once the story runs
  const leg = (cursor: HTMLElement | null, t0: number, t1: number, to: number[]) => {
    timeline.to(cursor, { left: `${to[0]}%`, duration: t1 - t0, ease: "power2.inOut" }, t0);
    timeline.to(cursor, { top: `${to[1]}%`, duration: t1 - t0, ease: "sine.inOut" }, t0);
  };
  slots.forEach((slot, i) => {
    const cursor = inSlot(slot, ".ws-agent");
    const d = i * 0.16;
    const [startX, startY] = CURSOR_START[i];
    const [parkX, parkY] = CURSOR_PARK[i];
    timeline.fromTo(
      cursor,
      { left: `${startX}%` },
      { left: `${parkX}%`, duration: 0.75, ease: "power2.inOut" },
      0.2,
    );
    timeline.fromTo(
      cursor,
      { top: `${startY}%` },
      { top: `${parkY}%`, duration: 0.75, ease: "sine.inOut" },
      0.2,
    );
    timeline.fromTo(cursor, { opacity: 0 }, { opacity: 1, duration: 0.3 }, 0.2);
    leg(cursor, 0.95, READY + d, [parkX + CURSOR_DRIFT[0], parkY + CURSOR_DRIFT[1]]);

    // the workspace is ready: the story runs, its port is live, its preview can open
    const ready = READY + d;
    const button = inSlot(slot, ".ws-button");
    timeline.to(inSlot(slot, ".ws-wait"), { opacity: 0, duration: 0.2, ease: "power2.in" }, ready);
    timeline.to(inSlot(slot, ".ws-run"), { opacity: 1, duration: 0.2, ease: "power2.out" }, ready + 0.1);
    timeline.to(inSlot(slot, ".ws-light"), { opacity: 1, duration: 0.35, ease: "power2.out" }, ready);
    timeline.to(inSlot(slot, ".ws-button-on"), { opacity: 1, duration: 0.2, ease: "power2.out" }, ready);
    timeline.fromTo(button, { scale: 1 }, { scale: 1.08, duration: 0.16, ease: "power2.out" }, ready);
    timeline.to(button, { scale: 1, duration: 0.3, ease: "power2.inOut" }, ready + 0.16);
    timeline.to(
      inSlot(slot, ".ws-dot"),
      { backgroundColor: "#10b981", boxShadow: "0 0 10px #10b981", duration: 0.2 },
      ready,
    );
    leg(cursor, ready, ready + 1.05, i === FOCUS ? CURSOR_BUTTON : CURSOR_REST);
  });

  // what it adds up to
  timeline.fromTo(
    ".ws-chip",
    { y: 24, opacity: 0, filter: "blur(8px)" },
    {
      y: 0,
      opacity: 1,
      filter: "blur(0px)",
      duration: 0.45,
      ease: "power3.out",
      stagger: 0.16,
    },
    3.35,
  );

  // click Open Preview on the middle worktree
  const focus = slots[FOCUS];
  const focusButton = inSlot(focus, ".ws-button");
  timeline.to(inSlot(focus, ".ws-agent svg"), { scale: 0.86, duration: 0.09, ease: "power2.in", transformOrigin: "14% 9%" }, CLICK);
  timeline.to(inSlot(focus, ".ws-agent svg"), { scale: 1, duration: 0.22, ease: "power2.out" }, CLICK + 0.09);
  timeline.to(focusButton, { scale: 0.93, duration: 0.09, ease: "power2.in" }, CLICK);
  timeline.to(focusButton, { scale: 1, duration: 0.22, ease: "power2.out" }, CLICK + 0.09);
  timeline.set(inSlot(focus, ".ws-ring"), { scale: 0.3, opacity: 0.9 }, CLICK + 0.04);
  timeline.to(
    inSlot(focus, ".ws-ring"),
    { scale: 1.9, opacity: 0, duration: 0.6, ease: "power2.out" },
    CLICK + 0.04,
  );
  // then the hand moves off the label, so the opened worktree reads clearly
  leg(inSlot(focus, ".ws-agent"), CLICK + 0.45, CLICK + 1.1, CURSOR_REST);
}

const rowsOf = (worktree: (typeof worktrees)[number]) => [
  { label: "Branch", value: worktree.branch },
  { label: "Worktree", value: `story-${worktree.story}` },
  { label: "Environment", value: ".env synced" },
  { label: "Port", value: `:${worktree.port}`, port: true },
  { label: "Runtime", value: "dev server up" },
];

export function WorkspaceScene() {
  const ref = useSceneTimeline<HTMLDivElement>(buildWorkspace);

  return (
    <div ref={ref} className="relative mx-auto max-w-7xl overflow-x-clip">
      <div className="text-center">
        <p className="story-eyebrow ws-eyebrow">Isolated by default</p>
        <h2 className="story-title mx-auto mt-5 max-w-6xl text-[#f5f5f7]">
          <span className="ws-word inline-block">One</span>{" "}
          <span className="ws-word inline-block">story.</span>{" "}
          <span className="ws-word inline-block text-[#dedede]">Its</span>{" "}
          <span className="ws-word inline-block text-[#dedede]">own</span>{" "}
          <span className="ws-word workspace-smart-sweep">smart workspace.</span>
        </h2>
        <p className="story-copy ws-copy mx-auto mt-6 max-w-3xl">
          Blame analyzes your project, works out what each story needs, and
          prepares a dedicated branch, worktree, environment, port, and runtime
          before the agent starts.
        </p>
      </div>

      <ul className="mx-auto mt-16 flex max-w-[420px] flex-col gap-3.5 sm:mt-20 lg:mt-24 lg:grid lg:max-w-none lg:grid-cols-3 lg:gap-10 lg:px-4 xl:gap-12">
        {worktrees.map((worktree, i) => (
          <li
            key={worktree.story}
            className={`ws-slot ${styles.slot} ${i === FOCUS ? styles.focus : styles.compact}`}
          >
            <div className={`ws-card ${styles.card}`}>
              <span className={`ws-light ${styles.light}`} aria-hidden="true">
                <span
                  className={styles.spin}
                  style={{ animationDelay: `${-0.94 * i}s` }}
                />
              </span>
              <div className={styles.head}>
                <span>{worktree.story}</span>
                <span className={styles.badges}>
                  <span className={`ws-wait ${styles.badge}`} aria-hidden="true">
                    Setting up
                  </span>
                  <span className={`ws-run ${styles.badge} ${styles.running}`}>
                    Running
                  </span>
                </span>
              </div>
              <h3 className={styles.title}>{worktree.title}</h3>
              <dl className={styles.rows}>
                {rowsOf(worktree).map((row) => (
                  <div key={row.label} className={`ws-row ${styles.row}`}>
                    <dt>
                      <span className={`ws-icon ${styles.icon}`} aria-hidden="true">
                        <span className={`ws-check ${styles.check}`}>
                          <svg
                            viewBox="0 0 14 14"
                            fill="none"
                            stroke="#fff"
                            strokeWidth="2.2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M3 7.5l2.8 2.8L11 4.5" />
                          </svg>
                        </span>
                      </span>
                      {row.label}
                    </dt>
                    <dd className={`ws-value ${row.port ? styles.port : ""}`}>
                      {row.value}
                    </dd>
                  </div>
                ))}
              </dl>
              <div className={styles.foot}>
                <span className={styles.localhost}>
                  <span className={`ws-dot ${styles.dot}`} />
                  localhost:{worktree.port}
                </span>
                <span className={`ws-button ${styles.button}`}>
                  Open Preview
                  <span className={`ws-button-on ${styles.buttonOn}`} aria-hidden="true">
                    Open Preview
                  </span>
                </span>
              </div>
            </div>

            <div
              className={`ws-agent ${styles.agent}`}
              style={{ color: worktree.color }}
              aria-hidden="true"
            >
              <span className={`ws-ring ${styles.ring}`} />
              <svg viewBox="0 0 28 28">
                <path
                  d="M4 2.5l17 10-7.6 1.9-3.4 7.2z"
                  fill={worktree.color}
                  stroke="#0b0b0f"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
              </svg>
              <span className={styles.agentName} style={{ background: worktree.color }}>
                {worktree.agent}
              </span>
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-14 flex flex-wrap justify-center gap-2 sm:gap-3 lg:mt-16 lg:gap-4">
        <span className={`ws-chip ${styles.chip}`}>
          <span className={styles.chipDot} aria-hidden="true" />3 previews in
          parallel
        </span>
        <span className={`ws-chip ${styles.chip}`}>
          <span className={styles.chipDot} aria-hidden="true" />0 port conflicts
        </span>
      </div>
    </div>
  );
}
