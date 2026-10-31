"use client";

import { useLayoutEffect, type CSSProperties, type ReactNode, type RefObject } from "react";
import { useSceneTimeline } from "@/components/story/use-scene-timeline";
import styles from "./backlog-scene.module.css";

// Stroke icons of the video's composer and board (24 x 24 grid).
const icons = {
  x: "M6 6l12 12M18 6L6 18",
  send: "M22 2L11 13M22 2l-7 20-4-9-9-4z",
  diff: "M3.5 6a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M15.5 18a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M6 8.5v7a2.5 2.5 0 0 0 2.5 2.5h7",
  files: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6",
  terminal: "M5 8l4 4-4 4M12 17h7",
  worktree:
    "M6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2",
  preview: "M15 3h6v6M10 14L21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  stop: "M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0M10 9h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z",
  check: "M20 6L9 17l-5-5",
  context: "M4 22h14a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4M14 2v4a2 2 0 0 0 2 2h4M3 15h6M6 12v6",
  dequeue: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5",
  book: "M12 7v14M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z",
  code: "M16 18l6-6-6-6M8 6l-6 6 6 6",
  sparkle:
    "M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z",
  mic: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3",
  attach:
    "M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5",
  undo: "M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  redo: "M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13",
  bold: "M6 12h9a4 4 0 0 1 0 8H6V4h8a4 4 0 0 1 0 8",
  italic: "M19 4h-9M14 20H5M15 4L9 20",
  link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7",
  cloud: "M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9z",
  chevron: "M6 9l6 6 6-6",
} as const;

type IconName = keyof typeof icons;

function Icon({ name }: { name: IconName }) {
  return (
    <svg className={styles.sym} viewBox="0 0 24 24" aria-hidden="true">
      <path d={icons[name]} />
    </svg>
  );
}

const headline = [
  { word: "Every" },
  { word: "request" },
  { word: "gets", dim: true },
  { word: "a", dim: true },
  { word: "lane." },
];

const storyTitle = "Add secure credential vault";
const storyLines = [
  "Provider tokens live in an encrypted local vault.",
  "Agents get a scoped handle, so no secret ever reaches the model.",
];

// The heading of the beat: the eyebrow rises, the words arrive from the
// right out of a blur as the video's line does, then the copy settles.
function buildHeading(tl: gsap.core.Timeline) {
  tl.fromTo(
    "[data-bk=eyebrow]",
    { y: 14, opacity: 0 },
    { y: 0, opacity: 1, duration: 0.5, ease: "power3.out" },
    0,
  );
  tl.fromTo(
    "[data-bk=word]",
    { x: 90, opacity: 0, filter: "blur(8px)" },
    { x: 0, opacity: 1, filter: "blur(0px)", duration: 0.5, ease: "power4.out", stagger: 0.06 },
    0.06,
  );
  tl.fromTo(
    "[data-bk=copy]",
    { y: 18, opacity: 0 },
    { y: 0, opacity: 1, duration: 0.65, ease: "power3.out" },
    0.35,
  );
}

// The backlog beat of the presentation video, compressed from 7.3 s to about
// 5.6 s: the story is typed into the composer, the camera whips onto Send and
// the cursor presses it, the composer shrinks into a card in the Agent Queue
// while the board slides in, then an agent picks the story up: the card moves
// to In Progress, its badge turns to Running and it opens its working actions.
function buildStage(tl: gsap.core.Timeline, root: HTMLDivElement) {
  const cam = root.querySelector("[data-bk=cam]");
  const caret = root.querySelector("[data-bk=caret]");
  const title = root.querySelector<HTMLElement>("[data-bk=title]");
  const titleChars = Array.from(root.querySelectorAll<HTMLElement>("[data-bk=title] [data-bk=ch]"));
  if (!cam || !caret || !title) return;

  // the composer arrives from the right
  tl.fromTo(
    "[data-bk=composer]",
    { x: 160, opacity: 0 },
    { x: 0, opacity: 1, duration: 0.55, ease: "power4.out" },
    0.1,
  );

  // the title is typed at the caret, one character after the other; the
  // caret's stops are kept as a share of the title's width so they hold at
  // every canvas size
  const TYPE = 0.55;
  const step = 0.8 / titleChars.length;
  const width = title.offsetWidth || 1;
  tl.to("[data-bk=title-ph]", { opacity: 0, duration: 0.08, ease: "power2.in" }, TYPE);
  tl.set(caret, { opacity: 1, left: "0%" }, TYPE);
  tl.fromTo(
    titleChars,
    { opacity: 0 },
    { opacity: 1, duration: 0.01, ease: "none", stagger: step },
    TYPE,
  );
  titleChars.forEach((char, index) => {
    const edge = ((char.offsetLeft + char.offsetWidth) / width) * 100;
    tl.set(caret, { left: `${edge.toFixed(2)}%` }, TYPE + index * step);
  });
  tl.to(caret, { opacity: 0, duration: 0.2, ease: "power2.in" }, TYPE + 0.95);

  // the description is written into the editor, one line after the other
  tl.to("[data-bk=text-ph]", { opacity: 0, duration: 0.08, ease: "power2.in" }, 1.4);
  tl.fromTo(
    "[data-bk=line-a] [data-bk=ch]",
    { opacity: 0 },
    { opacity: 1, duration: 0.01, ease: "none", stagger: 0.3 / storyLines[0].length },
    1.42,
  );
  tl.fromTo(
    "[data-bk=line-b] [data-bk=ch]",
    { opacity: 0 },
    { opacity: 1, duration: 0.01, ease: "none", stagger: 0.36 / storyLines[1].length },
    1.76,
  );

  // the cursor makes one calm arc to Send
  tl.fromTo("[data-bk=cursor]", { opacity: 0 }, { opacity: 1, duration: 0.3, ease: "power2.out" }, 0.8);
  tl.fromTo("[data-bk=cursor-path]", { "--px": 0 }, { "--px": 1, duration: 1.7, ease: "power2.inOut" }, 0.8);
  tl.fromTo("[data-bk=cursor-path]", { "--py": 0 }, { "--py": 1, duration: 1.7, ease: "power1.inOut" }, 0.8);

  // the camera whips into a close view of the Send button
  tl.set(cam, { attr: { "data-whip": "on" } }, 2.0);
  tl.fromTo(cam, { "--zoom": 0 }, { "--zoom": 1, duration: 0.6, ease: "expo.inOut" }, 2.0);
  tl.fromTo(cam, { "--whip": 0 }, { "--whip": 1, duration: 0.3, ease: "power2.in" }, 2.0);
  tl.to(cam, { "--whip": 0, duration: 0.3, ease: "power2.out" }, 2.3);
  tl.set(cam, { attr: { "data-whip": "off" } }, 2.62);

  // click Send: the button answers
  tl.to("[data-bk=cursor]", { scale: 0.86, transformOrigin: "14% 9%", duration: 0.08, ease: "power2.in" }, 2.66);
  tl.to("[data-bk=cursor]", { scale: 1, duration: 0.2, ease: "power2.out" }, 2.74);
  tl.to("[data-bk=send]", { scale: 0.93, duration: 0.09, ease: "power2.in" }, 2.7);
  tl.to("[data-bk=send]", { scale: 1, duration: 0.25, ease: "power2.out" }, 2.79);
  tl.fromTo(
    "[data-bk=flash]",
    { opacity: 0.7 },
    { opacity: 0, duration: 0.4, ease: "power2.out", immediateRender: false },
    2.72,
  );
  tl.fromTo(
    "[data-bk=ripple]",
    { scale: 0.2, opacity: 0.9 },
    { scale: 1.5, opacity: 0, duration: 0.55, ease: "power3.out", immediateRender: false },
    2.72,
  );

  // the story leaves the composer and lands as a card in the Agent Queue:
  // the sheet itself shrinks into the card while the camera pulls back
  const FLY = 2.9;
  tl.to(cam, { "--zoom": 0, duration: 0.8, ease: "expo.inOut" }, FLY);
  tl.fromTo("[data-bk=composer-fly]", { "--fly": 0 }, { "--fly": 1, duration: 0.8, ease: "expo.inOut" }, FLY);
  tl.to("[data-bk=composer-in]", { opacity: 0, duration: 0.22, ease: "power2.in" }, FLY);
  tl.to(
    "[data-bk=composer]",
    { backgroundColor: "#171717", borderColor: "rgba(255, 255, 255, 0.12)", duration: 0.4, ease: "power2.out" },
    FLY,
  );
  tl.fromTo("[data-bk=composer]", { "--flyh": 0 }, { "--flyh": 1, duration: 0.45, ease: "power3.out" }, FLY + 0.25);
  tl.to("[data-bk=cursor]", { x: 110, y: 130, duration: 1.1, ease: "power2.inOut" }, FLY);
  tl.to("[data-bk=cursor]", { opacity: 0, duration: 0.3, ease: "power2.in" }, FLY + 0.45);
  // the board slides in behind it, lane after lane
  tl.fromTo(
    "[data-bk=lane]",
    { "--lane-p": 0, opacity: 0 },
    { "--lane-p": 1, opacity: 1, duration: 0.6, ease: "power3.out", stagger: 0.08 },
    FLY + 0.45,
  );
  tl.fromTo("[data-bk=story]", { opacity: 0 }, { opacity: 1, duration: 0.25, ease: "power2.out" }, FLY + 0.6);
  tl.to("[data-bk=composer]", { autoAlpha: 0, duration: 0.12, ease: "none" }, FLY + 0.85);

  // an agent picks it up: the card moves to In Progress and turns to Running
  const PICK = 4.1;
  tl.fromTo("[data-bk=story-move]", { "--mv": 0 }, { "--mv": 1, duration: 0.7, ease: "power3.inOut" }, PICK);
  tl.to("[data-bk=queued]", { opacity: 0, duration: 0.2, ease: "power2.in" }, PICK + 0.4);
  tl.to("[data-bk=story-queue]", { opacity: 0, duration: 0.2, ease: "power2.in" }, PICK + 0.4);
  tl.fromTo("[data-bk=running]", { opacity: 0 }, { opacity: 1, duration: 0.25, ease: "power2.out" }, PICK + 0.5);
  tl.fromTo("[data-bk=story-glow]", { opacity: 0 }, { opacity: 1, duration: 0.3, ease: "power2.out" }, PICK + 0.5);
  // once running, it swaps Dequeue for its working actions
  tl.fromTo("[data-bk=story]", { height: 166 }, { height: 264, duration: 0.4, ease: "power3.out" }, PICK + 0.6);
  tl.fromTo("[data-bk=story-tools]", { opacity: 0 }, { opacity: 1, duration: 0.25, ease: "power2.out" }, PICK + 0.6);
  // and the next request takes the lane behind it
  tl.fromTo(
    "[data-bk=next]",
    { y: -40, opacity: 0 },
    { y: 0, opacity: 1, duration: 0.45, ease: "power3.out" },
    PICK + 1.05,
  );
}

// Text that types itself: each character is its own span for the timeline,
// and screen readers get the sentence whole.
function Typed({ text, className, bk }: { text: string; className?: string; bk?: string }) {
  return (
    <span className={className} data-bk={bk}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {Array.from(text).map((char, index) => (
          <span key={index} data-bk="ch">
            {char}
          </span>
        ))}
      </span>
    </span>
  );
}

type Action = { label?: string; icon: IconName; tone?: "danger" | "go" | "preview"; iconOnly?: boolean };

const toneClass = {
  danger: styles.btnDanger,
  go: styles.btnGo,
  preview: styles.btnPreview,
};

function Actions({ rows, bk }: { rows: Action[][]; bk?: string }) {
  return (
    <div className={styles.acts} data-bk={bk}>
      {rows.map((row, index) => (
        <div key={index} className={styles.row}>
          {row.map((action) => (
            <span
              key={action.label ?? action.icon}
              className={[
                styles.btn,
                action.tone ? toneClass[action.tone] : "",
                action.iconOnly ? styles.btnIcon : "",
              ].join(" ")}
            >
              <Icon name={action.icon} />
              {action.label}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

const workingActions: Action[][] = [
  [
    { label: "Diff", icon: "diff" },
    { label: "Files", icon: "files" },
    { label: "Terminal", icon: "terminal" },
  ],
  [
    { label: "Open Worktree", icon: "worktree" },
    { label: "Open Preview", icon: "preview", tone: "preview" },
  ],
  [{ label: "Stop Agent", icon: "stop", tone: "danger" }],
];

const reviewActions: Action[][] = [
  workingActions[0],
  workingActions[1],
  [
    { label: "Reject", icon: "x", tone: "danger" },
    { label: "Approve & Merge", icon: "check", tone: "go" },
  ],
];

const doneActions: Action[][] = [
  [
    { label: "Diff", icon: "diff" },
    { label: "Use Context", icon: "context", tone: "go" },
  ],
];

const queueActions: Action[][] = [[{ label: "Dequeue", icon: "dequeue", tone: "danger" }]];

const badgeClass = {
  draft: "",
  queued: "",
  running: styles.badgeRun,
  review: styles.badgeReview,
  merged: styles.badgeMerged,
};

function Badge({ kind, children, bk }: { kind: keyof typeof badgeClass; children: ReactNode; bk?: string }) {
  return (
    <b className={`${styles.badge} ${badgeClass[kind]}`} data-bk={bk}>
      {children}
    </b>
  );
}

function Card({
  id,
  title,
  badge,
  dev,
  className,
  children,
}: {
  id: string;
  title: string;
  badge: ReactNode;
  dev?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={[styles.card, dev ? styles.cardDev : "", className ?? ""].join(" ")}>
      <div className={styles.cardTop}>
        {id}
        {badge}
      </div>
      <div className={styles.cardTitle}>{title}</div>
      {children}
    </div>
  );
}

function Lane({ name, dot, className, children }: { name: string; dot: string; className: string; children?: ReactNode }) {
  return (
    <div className={`${styles.lane} ${className}`} data-bk="lane">
      <div className={styles.laneHead} style={{ "--dot": dot } as CSSProperties}>
        <i aria-hidden="true" />
        {name}
      </div>
      <div className={styles.laneBody}>{children}</div>
    </div>
  );
}

function Board() {
  return (
    <>
      <Lane name="Backlog" dot="#10b981" className={styles.laneBacklog}>
        <Card id="US-700" title="Define a first-run onboarding path" badge={<Badge kind="draft">Draft</Badge>}>
          <Actions
            rows={[
              [
                { icon: "x", tone: "danger", iconOnly: true },
                { label: "Send to Dev Agent", icon: "send", tone: "go" },
              ],
            ]}
          />
        </Card>
      </Lane>
      <Lane name="Agent Queue" dot="#3b82f6" className={styles.laneQueue} />
      <Lane name="In Progress" dot="#f59e0b" className={styles.laneProgress}>
        <Card
          id="US-706"
          title="Build repository insights panel"
          badge={<Badge kind="running">Running</Badge>}
          dev
          className={styles.wideOnly}
        >
          <Actions rows={workingActions} />
          <span className={styles.fxHalo} aria-hidden="true" />
          <span className={`${styles.fxRun} ${styles.fxRunLate}`} aria-hidden="true">
            <span />
          </span>
        </Card>
      </Lane>
      <Lane name="In Review" dot="#93c5fd" className={styles.laneReview}>
        <Card id="US-712" title="Review merge readiness summary" badge={<Badge kind="review">Review</Badge>} dev>
          <Actions rows={reviewActions} />
          <span className={styles.fxRev} aria-hidden="true" />
          <span className={`${styles.fxRev} ${styles.fxRevHi}`} aria-hidden="true" />
        </Card>
      </Lane>
      <Lane name="Done" dot="#f97316" className={styles.laneDone}>
        <Card id="US-713" title="Launch guided backlog board" badge={<Badge kind="merged">Merged</Badge>}>
          <Actions rows={doneActions} />
        </Card>
        <Card id="US-714" title="Ship provider connection flow" badge={<Badge kind="merged">Merged</Badge>}>
          <Actions rows={doneActions} />
        </Card>
      </Lane>

      {/* the next request, which takes the Agent Queue once the story is picked up */}
      <div className={styles.slot} data-bk="next">
        <Card id="US-709" title="Build project activity timeline" badge={<Badge kind="queued">Queued</Badge>}>
          <Actions rows={queueActions} />
        </Card>
      </div>

      {/* the story, as the card the composer becomes */}
      <div className={`${styles.slot} ${styles.storyMove}`} data-bk="story-move">
        <div className={styles.card} data-bk="story">
          <div className={styles.cardTop}>
            US-708
            <span className={styles.badges}>
              <Badge kind="queued" bk="queued">
                Queued
              </Badge>
              <Badge kind="running" bk="running">
                Running
              </Badge>
            </span>
          </div>
          <div className={styles.cardTitle}>{storyTitle}</div>
          <Actions rows={queueActions} bk="story-queue" />
          <Actions rows={workingActions} bk="story-tools" />
          <span data-bk="story-glow" aria-hidden="true">
            <span className={styles.fxHalo} />
            <span className={styles.fxRun}>
              <span />
            </span>
          </span>
        </div>
      </div>
    </>
  );
}

function Composer() {
  return (
    <div className={styles.composerFly} data-bk="composer-fly">
      <div className={styles.composer} data-bk="composer">
        <div className={styles.composerIn} data-bk="composer-in">
          <div className={styles.head}>
            <span className={styles.titlePh} data-bk="title-ph" aria-hidden="true">
              User story title
            </span>
            <span className={styles.title} data-bk="title">
              <Typed text={storyTitle} />
              <i className={styles.caret} data-bk="caret" aria-hidden="true" />
            </span>
          </div>
          <span className={styles.close} aria-hidden="true">
            <Icon name="x" />
          </span>
          <div className={styles.meta}>
            <b className={styles.chip}>Backlog</b>
            <span>Product created this</span>
            <span>New draft</span>
          </div>
          <div className={styles.tabs}>
            <span className={`${styles.tab} ${styles.tabOn}`}>
              <Icon name="book" />
              User Story
            </span>
            <span className={styles.tab}>
              <Icon name="code" />
              Code
            </span>
          </div>
          <div className={styles.editor}>
            <div className={styles.text}>
              <span className={styles.textPh} data-bk="text-ph" aria-hidden="true">
                Describe the user story, expected behavior, and acceptance criteria.
              </span>
              <p className={styles.crit}>
                <Typed text={storyLines[0]} bk="line-a" />
              </p>
              <p className={styles.crit}>
                <Typed text={storyLines[1]} bk="line-b" />
              </p>
              <div className={styles.enhance}>
                <span className={styles.enhanceBtn}>
                  <Icon name="sparkle" />
                  Enhance
                </span>
                <Icon name="mic" />
              </div>
            </div>
            <div className={styles.bar}>
              <div className={styles.tools} aria-hidden="true">
                <Icon name="attach" />
                <i className={styles.sep} />
                <Icon name="undo" />
                <Icon name="redo" />
                <i className={styles.sep} />
                <Icon name="bold" />
                <Icon name="italic" />
                <Icon name="code" />
                <Icon name="link" />
              </div>
              <span className={`${styles.sel} ${styles.selOn}`}>
                <Icon name="cloud" />
                Cloud Preview
                <Icon name="chevron" />
              </span>
              <span className={styles.sel}>
                <Icon name="sparkle" />6 Astra
                <Icon name="chevron" />
              </span>
              <span className={styles.sel}>
                X High
                <Icon name="chevron" />
              </span>
            </div>
          </div>
          <div className={styles.foot}>
            <span className={styles.discard} aria-hidden="true">
              <Icon name="x" />
            </span>
            <span className={styles.draft}>
              <Icon name="check" />
              Save as Draft
            </span>
            <span className={styles.send} data-bk="send">
              <b className={styles.flash} data-bk="flash" aria-hidden="true" />
              <i className={styles.ripple} data-bk="ripple" aria-hidden="true" />
              <span>Send to Dev Agent</span>
              <em aria-hidden="true">⌘</em>
              <em aria-hidden="true">↵</em>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// Scales the stage's design canvas to the column, never above its own size
// (a little more on a wide phone).
function useStageFit(frameRef: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const stage = frame?.firstElementChild;
    if (!frame || !(stage instanceof HTMLElement)) return;
    const fit = () => {
      const max = stage.offsetWidth < 640 ? 1.3 : 1;
      const scale = Math.min(max, frame.clientWidth / stage.offsetWidth);
      frame.style.setProperty("--bk-s", scale.toFixed(4));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [frameRef]);
}

export function BacklogScene() {
  const headingRef = useSceneTimeline<HTMLDivElement>(buildHeading, { mode: "enter" });
  // the stage plays once it is well into the screen, so the typing is seen
  const frameRef = useSceneTimeline<HTMLDivElement>(buildStage);
  useStageFit(frameRef);

  return (
    <div className="mx-auto max-w-7xl overflow-x-clip [overflow-clip-margin:1.25rem]">
      <div ref={headingRef} className="text-center">
        <p className="story-eyebrow" data-bk="eyebrow">
          The backlog
        </p>
        <h2 className="story-title font-display mx-auto mt-5 max-w-5xl">
          {headline.map(({ word, dim }, index) => (
            <span key={word}>
              <span data-bk="word" className={`inline-block ${dim ? "text-[#dedede]" : ""}`}>
                {word}
              </span>
              {index < headline.length - 1 ? " " : null}
            </span>
          ))}
        </h2>
        <p className="story-copy mx-auto mt-7 max-w-3xl" data-bk="copy">
          Write the outcome once. Blame gives it a lane that keeps the brief, the agent&rsquo;s work, the review,
          and your decision together, from first draft to merge.
        </p>
      </div>

      <div ref={frameRef} className={`${styles.frame} mt-10 sm:mt-12`}>
        <div className={styles.stage}>
          <div className={styles.cam} data-bk="cam" data-whip="off">
            <Board />
            <Composer />
            <div className={styles.cursorPath} data-bk="cursor-path" aria-hidden="true">
              <svg className={styles.cursor} data-bk="cursor" viewBox="0 0 28 28">
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
        </div>
      </div>
    </div>
  );
}
