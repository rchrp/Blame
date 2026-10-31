"use client";

import gsap from "gsap";
import { Fragment } from "react";
import { useSceneTimeline } from "@/components/story/use-scene-timeline";
import styles from "./opening-scene.module.css";

// The video's first two beats ("hook" then "name") as one scene: the line
// types on while the loose ends of AI coding are dealt under it, they collapse
// into the product name, and the workflow from story to merge draws itself.

const typedWords = [
  { text: "AI", tone: "dim" },
  { text: "can", tone: "dim" },
  { text: "write", tone: "bright" },
  { text: "the", tone: "dim" },
  { text: "code.", tone: "bright" },
] as const;

const restWords = ["makes", "it", "shippable."];

const looseEnds = [
  {
    source: "chat · 14 open",
    badge: "Lost context",
    amber: false,
    body: "Which prompt changed this file?",
    plain: false,
  },
  {
    source: "terminal",
    badge: "Port conflict",
    amber: true,
    body: "Error: port 3000 is already in use",
    plain: true,
  },
  {
    source: "git",
    badge: "Unreviewed",
    amber: false,
    body: "47 files changed on feature/tmp-2",
    plain: false,
  },
  {
    source: ".env",
    badge: "Not synced",
    amber: true,
    body: "DATABASE_URL is missing",
    plain: true,
  },
];

const workflowSteps = ["Story", "Harness", "Worktree", "Preview", "Merge"];

// Timings in seconds, compressed from the video's 7.6s (two beats of 3.8s).
const TYPE_AT = 0.1;
const CHAR = 0.036;
const TILT = [-5, -2, 2.5, 5.5];
const COLLAPSE_AT = 2.2;
const RECEDE_AT = 2.3;
const NAME_AT = 2.92;
const CHAIN_AT = 3.5;
const RECEDED = "#86868b";

function centre(element: Element) {
  const box = element.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

function buildOpening(timeline: gsap.core.Timeline, root: HTMLDivElement) {
  const all = (selector: string) =>
    Array.from(root.querySelectorAll<HTMLElement>(selector));
  const words = all("[data-op-word]");
  const brand = root.querySelector<HTMLElement>("[data-op-brand]");
  if (!words.length || !brand) return;

  // Beat 1: "AI can write the code." types on, caret first.
  timeline.fromTo(words[0], { "--caret": 1 }, { "--caret": 1, duration: 0.01 }, 0);
  let at = TYPE_AT;
  words.forEach((word, index) => {
    const chars = word.textContent?.length ?? 1;
    if (index > 0) {
      timeline.to(words[index - 1], { "--caret": 0, duration: 0.01 }, at);
      timeline.to(word, { "--caret": 1, duration: 0.01 }, at);
    }
    timeline.fromTo(
      word,
      { "--q": 0 },
      { "--q": 1, duration: chars * CHAR, ease: `steps(${chars})` },
      at,
    );
    at += (chars + 1) * CHAR;
  });
  timeline.to(
    words[words.length - 1],
    { "--caret": 0, duration: 0.25, ease: "power2.in" },
    1.05,
  );

  // The loose ends are dealt under the line, drift, then fall into one point:
  // the product name, which lands where they vanish.
  // Phones fan their column of cards less: the deck's --tilt says how much.
  const deck = root.querySelector<HTMLElement>("[data-op-deck]");
  const fan = deck
    ? Number.parseFloat(getComputedStyle(deck).getPropertyValue("--tilt")) || 1
    : 1;
  all("[data-op-card]").forEach((card, index) => {
    const tilt = (TILT[index] ?? 0) * fan;
    const dealt = 0.35 + index * 0.15;
    timeline.fromTo(
      card,
      { yPercent: 85, rotation: tilt * 3, opacity: 0, filter: "blur(10px)" },
      {
        yPercent: 0,
        rotation: tilt,
        opacity: 1,
        filter: "blur(0px)",
        duration: 0.6,
        ease: "power3.out",
      },
      dealt,
    );
    const badge = card.querySelector("[data-op-badge]");
    if (badge) {
      timeline.fromTo(
        badge,
        { scale: 0.5, opacity: 0 },
        { scale: 1, opacity: 1, duration: 0.35, ease: "back.out(1.6)" },
        1 + index * 0.2,
      );
    }
    timeline.to(
      card,
      {
        x: (index - 1.5) * 5 * fan,
        y: -6,
        rotation: tilt * 1.2,
        duration: COLLAPSE_AT - dealt - 0.6,
        ease: "sine.inOut",
      },
      dealt + 0.6,
    );
    timeline.to(
      card,
      {
        x: () =>
          Number(gsap.getProperty(card, "x")) + centre(brand).x - centre(card).x,
        y: () =>
          Number(gsap.getProperty(card, "y")) + centre(brand).y - centre(card).y,
        rotation: 0,
        scale: 0.12,
        duration: 0.85,
        ease: "power3.in",
      },
      COLLAPSE_AT + index * 0.02,
    );
    timeline.to(
      card,
      { opacity: 0, duration: 0.22, ease: "power2.in" },
      COLLAPSE_AT + 0.65 + index * 0.02,
    );
  });

  // The first line recedes while the name crashes down to size.
  timeline.fromTo(
    all('[data-op-word][data-tone="dim"]'),
    { color: "#dedede" },
    { color: RECEDED, duration: 0.65, ease: "power2.inOut" },
    RECEDE_AT,
  );
  timeline.fromTo(
    all('[data-op-word][data-tone="bright"]'),
    { color: "#f5f5f7" },
    { color: RECEDED, duration: 0.65, ease: "power2.inOut" },
    RECEDE_AT,
  );

  // Beat 2: "Blame" crashes down to size, the rest rises in beside it.
  timeline.fromTo(
    brand,
    { scale: 1.7, opacity: 0, filter: "blur(14px)" },
    { scale: 1, opacity: 1, filter: "blur(0px)", duration: 0.5, ease: "expo.out" },
    NAME_AT,
  );
  timeline.fromTo(
    all("[data-op-rest]"),
    { yPercent: 30, opacity: 0, filter: "blur(8px)" },
    {
      yPercent: 0,
      opacity: 1,
      filter: "blur(0px)",
      duration: 0.5,
      ease: "power3.out",
      stagger: 0.09,
    },
    NAME_AT + 0.2,
  );

  // The workflow draws itself, story to merge, lit one stage at a time.
  timeline.fromTo(
    all("[data-op-rail-h]"),
    { scaleX: 0, opacity: 0 },
    { scaleX: 1, opacity: 1, duration: 0.9, ease: "power2.inOut" },
    CHAIN_AT,
  );
  timeline.fromTo(
    all("[data-op-rail-v]"),
    { scaleY: 0, opacity: 0 },
    { scaleY: 1, opacity: 1, duration: 0.9, ease: "power2.inOut" },
    CHAIN_AT,
  );
  all("[data-op-step]").forEach((step, index) => {
    timeline.fromTo(
      step,
      { yPercent: 45, opacity: 0, scale: 0.9 },
      { yPercent: 0, opacity: 1, scale: 1, duration: 0.5, ease: "power3.out" },
      CHAIN_AT + index * 0.15,
    );
    const lit = step.querySelector("[data-op-lit]");
    if (!lit) return;
    timeline.fromTo(
      lit,
      { opacity: 0 },
      { opacity: 1, duration: 0.16, ease: "power2.out" },
      CHAIN_AT + 0.8 + index * 0.15,
    );
    timeline.to(
      lit,
      { opacity: 0.25, duration: 0.5, ease: "power2.in" },
      CHAIN_AT + 0.96 + index * 0.15,
    );
  });
  timeline.fromTo(
    all("[data-op-copy]"),
    { y: 16, opacity: 0 },
    { y: 0, opacity: 1, duration: 0.7, ease: "power3.out" },
    CHAIN_AT + 1.1,
  );
}

export function OpeningScene() {
  // The opening slides up over the hero: start once it sits mid-screen, so
  // the cards are in view when they are dealt in.
  const ref = useSceneTimeline<HTMLDivElement>(buildOpening, {
    rootMargin: "0px 0px -55% 0px",
  });

  return (
    <div ref={ref} className="mx-auto max-w-7xl">
      <div className={styles.clip}>
        <div className={styles.stage}>
          <h2 className={`font-display ${styles.heading}`}>
            <span className={`${styles.line} ${styles.lineA}`}>
              {typedWords.map((word, index) => (
                <Fragment key={word.text}>
                  {index > 0 ? " " : null}
                  <span data-op-word="" data-tone={word.tone} className={styles.typed}>
                    <span className={styles.typedText}>{word.text}</span>
                    <span aria-hidden="true" className={styles.caret} />
                  </span>
                </Fragment>
              ))}
            </span>
            <span className={`${styles.line} ${styles.lineB}`}>
              <span data-op-brand="" className={styles.brand}>
                Blame
              </span>
              {restWords.map((word) => (
                <Fragment key={word}>
                  {" "}
                  <span data-op-rest="" className={styles.rest}>
                    {word}
                  </span>
                </Fragment>
              ))}
            </span>
          </h2>

          <div className={styles.chainArea}>
            <span aria-hidden="true" data-op-rail-h="" className={styles.railH} />
            <span aria-hidden="true" data-op-rail-v="" className={styles.railV} />
            <ol aria-label="From story to merge" className={styles.chain}>
              {workflowSteps.map((step) => (
                <li key={step} data-op-step="" className={styles.step}>
                  <span aria-hidden="true" className={styles.dot} />
                  {step}
                  <span aria-hidden="true" data-op-lit="" className={styles.lit} />
                </li>
              ))}
            </ol>
          </div>

          <p data-op-copy="" className={`story-copy ${styles.copy}`}>
            Turn an idea into a user story, give it an isolated workspace, see
            it run, review every change, then decide what ships.
          </p>

          <div aria-hidden="true" className={styles.deckArea}>
            <div data-op-deck="" className={styles.deck}>
              {looseEnds.map((card) => (
                <div key={card.source} data-op-card="" className={styles.card}>
                  <div className={styles.cardTop}>
                    {card.source}
                    <b
                      data-op-badge=""
                      className={`${styles.badge} ${card.amber ? styles.badgeAmber : ""}`}
                    >
                      {card.badge}
                    </b>
                  </div>
                  <div
                    className={`${styles.cardBody} ${card.plain ? styles.cardBodyPlain : ""}`}
                  >
                    {card.body}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
