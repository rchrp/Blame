"use client";

import Image from "next/image";
import { useSceneTimeline } from "@/components/story/use-scene-timeline";
import styles from "./merge-scene.module.css";

const headline = ["Merge", "when", "it", "earns", "it."];

const files = [
  { path: "vault/credential-store.ts", add: "+96" },
  { path: "services/submit-order.ts", add: "+14", del: "−12" },
  { path: "vault/credential-store.test.ts", add: "+38" },
];

const checks = ["Code practices followed", "12 tests passed", "Preview checked by you"];

// The merge beat of the presentation video, compressed from 7.1 s to about
// 5.5 s: the review fills in, the cursor glides to Approve & Merge, the
// camera zooms onto it, the click answers, the review leaves and the result
// assembles word by word with a shimmer.
function buildMerge(tl: gsap.core.Timeline, root: HTMLDivElement) {
  const stage = root.querySelector("[data-mg=stage]");

  // the heading rises in, word by word
  tl.fromTo(
    "[data-mg=eyebrow]",
    { y: 14, opacity: 0 },
    { y: 0, opacity: 1, duration: 0.45, ease: "power3.out" },
    0,
  );
  tl.fromTo(
    "[data-mg=word]",
    { y: 38, opacity: 0, filter: "blur(8px)" },
    { y: 0, opacity: 1, filter: "blur(0px)", duration: 0.45, ease: "power3.out", stagger: 0.06 },
    0.05,
  );
  tl.fromTo(
    "[data-mg=copy]",
    { y: 18, opacity: 0 },
    { y: 0, opacity: 1, duration: 0.55, ease: "power3.out" },
    0.35,
  );

  // the review window arrives out of a blur
  tl.fromTo(
    "[data-mg=in]",
    { scale: 0.75, opacity: 0.35, filter: "blur(18px)" },
    { scale: 1, opacity: 1, filter: "blur(0px)", duration: 0.6, ease: "expo.out" },
    0.3,
  );

  // in review: the breathing glow round the story
  tl.fromTo(
    "[data-mg=rev-hi]",
    { opacity: 0 },
    { opacity: 1, duration: 0.8, ease: "sine.inOut", repeat: 3, yoyo: true },
    0.6,
  );

  // the evidence fills in: files, then checks
  tl.fromTo(
    "[data-mg=file]",
    { x: 26, opacity: 0 },
    { x: 0, opacity: 1, duration: 0.4, ease: "power3.out", stagger: 0.12 },
    0.75,
  );
  root.querySelectorAll("[data-mg=check]").forEach((row, i) => {
    const t = 1.3 + i * 0.22;
    const tick = row.querySelector("[data-mg=tick]");
    tl.fromTo(row.querySelector("[data-mg=tick-fill]"), { opacity: 0 }, { opacity: 1, duration: 0.18, ease: "power2.out" }, t);
    tl.fromTo(tick, { scale: 1 }, { scale: 1.3, duration: 0.14, ease: "power2.out" }, t);
    tl.to(tick, { scale: 1, duration: 0.3, ease: "power2.inOut" }, t + 0.14);
    tl.fromTo(row, { color: "#a1a1a1" }, { color: "#fafafa", duration: 0.2, ease: "power2.out" }, t);
  });

  // the cursor: one calm arc to Approve & Merge
  tl.fromTo("[data-mg=cursor]", { opacity: 0 }, { opacity: 1, duration: 0.3, ease: "power2.out" }, 1.45);
  tl.fromTo("[data-mg=cursor]", { "--cpx": 1 }, { "--cpx": 0, duration: 1.9, ease: "power2.inOut" }, 1.45);
  tl.fromTo("[data-mg=cursor]", { "--cpy": 1 }, { "--cpy": 0, duration: 1.9, ease: "sine.inOut" }, 1.45);

  // hard zoom onto the button, click, and it answers
  tl.fromTo(stage, { "--cam": 0 }, { "--cam": 1, duration: 0.5, ease: "expo.inOut" }, 3.1);
  tl.to("[data-mg=approve]", { scale: 0.93, duration: 0.09, ease: "power2.in" }, 3.67);
  tl.to("[data-mg=approve]", { scale: 1, duration: 0.25, ease: "power2.out" }, 3.76);
  tl.fromTo("[data-mg=approved]", { opacity: 0 }, { opacity: 1, duration: 0.15, ease: "power2.out" }, 3.72);
  tl.fromTo(
    "[data-mg=ripple]",
    { scale: 0.2, opacity: 0.9 },
    { scale: 1.5, opacity: 0, duration: 0.55, ease: "power3.out", immediateRender: false },
    3.7,
  );

  // the review closes: the whole view leaves with the current
  tl.fromTo("[data-mg=off]", { xPercent: 0 }, { xPercent: -130, duration: 0.5, ease: "power3.in" }, 4.0);
  tl.fromTo("[data-mg=off]", { opacity: 1 }, { opacity: 0, duration: 0.15, ease: "power2.in" }, 4.35);

  // the answer assembles: check, words with a shimmer, the story as done
  tl.fromTo(
    "[data-mg=ok]",
    { scale: 0.5, opacity: 0 },
    { scale: 1, opacity: 1, duration: 0.4, ease: "back.out(1.6)" },
    4.32,
  );
  tl.fromTo(
    "[data-mg=done]",
    { y: 34, opacity: 0, filter: "blur(10px)" },
    { y: 0, opacity: 1, filter: "blur(0px)", duration: 0.38, ease: "power3.out", stagger: 0.07 },
    4.4,
  );
  tl.fromTo(
    "[data-mg=done]",
    { backgroundPosition: "100% 0%" },
    { backgroundPosition: "0% 0%", duration: 0.6, ease: "power2.inOut", stagger: 0.07 },
    4.6,
  );
  tl.fromTo(
    "[data-mg=story]",
    { xPercent: 38, opacity: 0 },
    { xPercent: 0, opacity: 1, duration: 0.4, ease: "power4.out" },
    4.72,
  );
  tl.fromTo(
    "[data-mg=note]",
    { y: 18, opacity: 0 },
    { y: 0, opacity: 1, duration: 0.35, ease: "power3.out" },
    5.0,
  );
}

function Check({ className, stroke, width }: { className?: string; stroke: string; width: number }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 14 14"
      fill="none"
      stroke={stroke}
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 7.5l2.8 2.8L11 4.5" />
    </svg>
  );
}

export function MergeScene() {
  const ref = useSceneTimeline<HTMLDivElement>(buildMerge, { rootMargin: "0px 0px -35% 0px" });

  return (
    <div ref={ref} className={`mx-auto max-w-7xl ${styles.scene}`}>
      <header className="text-center">
        <p className="story-eyebrow" data-mg="eyebrow">
          Human decision
        </p>
        <h2 className={`story-title font-display mx-auto mt-5 max-w-5xl ${styles.headline}`}>
          {headline.map((word, i) => (
            <span key={word + i}>
              <span className={styles.word} data-mg="word">
                {word}
              </span>
              {i < headline.length - 1 ? " " : null}
            </span>
          ))}
        </h2>
        <p className="story-copy mx-auto mt-7 max-w-3xl text-balance" data-mg="copy">
          Open the running app beside the story, read the diff and the checks, then approve,
          request changes, or reject. The agent moves fast. The decision stays yours.
        </p>
      </header>

      <div className={`mt-12 sm:mt-16 ${styles.stageWrap}`}>
        <div className={styles.stage} data-mg="stage">
          <div className={styles.layer} data-mg="off">
            <div className={styles.layer} data-mg="in">
              <div className={styles.frame}>
                <div className={styles.cam}>
                  <div className={styles.preview}>
                    <div className={styles.bar}>
                      <span className={styles.dot} aria-hidden="true" />
                      http://localhost:46023/
                    </div>
                    <div className={styles.shot}>
                      <Image
                        src="/story/preview-landing.webp"
                        alt="The Blame homepage running in the story's live preview"
                        fill
                        sizes="(min-width: 1280px) 780px, (min-width: 900px) 60vw, 92vw"
                        className={styles.shotImage}
                      />
                    </div>
                  </div>

                  <div className={styles.side}>
                    <div className={styles.head}>
                      <span>US-708</span>
                      <span className={styles.badge}>In Review</span>
                    </div>
                    <p className={styles.title}>Add secure credential vault</p>
                    <p className={styles.sum}>
                      <span className={styles.add}>+148</span>
                      <span className={styles.del}>−12</span>
                      <span>3 files changed</span>
                    </p>
                    <ul className={styles.files}>
                      {files.map((file) => (
                        <li key={file.path} className={styles.file} data-mg="file">
                          <span className={styles.path}>{file.path}</span>
                          <span className={styles.counts}>
                            <span className={styles.add}>{file.add}</span>
                            {file.del ? <span className={styles.del}>{file.del}</span> : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <ul className={styles.checks}>
                      {checks.map((check) => (
                        <li key={check} className={styles.check} data-mg="check">
                          <span className={styles.tick} data-mg="tick" aria-hidden="true">
                            <span className={styles.tickFill} data-mg="tick-fill">
                              <Check stroke="#fff" width={2.2} />
                            </span>
                          </span>
                          {check}
                        </li>
                      ))}
                    </ul>
                    {/* Illustrative actions, not real controls. */}
                    <div className={styles.actions}>
                      <span className={styles.reject}>Reject</span>
                      <span className={styles.approve} data-mg="approve">
                        Approve &amp; Merge
                        <span className={styles.approved} data-mg="approved" aria-hidden="true">
                          <Check stroke="#04170e" width={2.4} />
                          Merged
                        </span>
                      </span>
                    </div>
                  </div>

                  <span className={styles.ripple} aria-hidden="true">
                    <i data-mg="ripple" />
                  </span>
                </div>
              </div>
              <span className={styles.rev} aria-hidden="true" />
              <span className={`${styles.rev} ${styles.revHi}`} data-mg="rev-hi" aria-hidden="true" />
              <span className={styles.pointer} aria-hidden="true">
                <svg className={styles.cursor} data-mg="cursor" viewBox="0 0 28 28">
                  <path
                    d="M4 2.5l17 10-7.6 1.9-3.4 7.2z"
                    fill="#ffffff"
                    stroke="#0b0b0f"
                    strokeWidth="1.6"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </div>
          </div>

          <div className={styles.result}>
            <div className={styles.ok} data-mg="ok" aria-hidden="true">
              <svg viewBox="0 0 48 48" fill="none" stroke="#ffffff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 25l9 9 16-19" />
              </svg>
            </div>
            <p className={`font-display ${styles.done}`}>
              <span className={styles.doneWord} data-mg="done">
                Merged
              </span>{" "}
              <span className={styles.doneWord} data-mg="done">
                into
              </span>{" "}
              <span className={styles.doneWord} data-mg="done">
                main
              </span>
            </p>
            <div className={styles.story} data-mg="story">
              <span className={styles.storyId}>US-708</span>
              <span className={styles.storyTitle}>Add secure credential vault</span>
              <span className={styles.storyBadge}>Done</span>
            </div>
            <p className={styles.note} data-mg="note">
              reviewed by you · traceable from request to commit
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
