"use client";

import Image from "next/image";
import Link from "next/link";
import { useGitHubStars } from "@/components/github-stars";
import { useSceneTimeline } from "@/components/story/use-scene-timeline";
import { formatStarCount, githubRepositoryUrl } from "@/lib/github";
import styles from "./cta-scene.module.css";

// The video's end card (its `cta` beat): the Blame mark and name lock up, the
// title's words streak in and snap into place, "Open Source" opens in a blue
// selection box between them, the tags pop out, then the white button and a
// cursor that presses it. Offsets are the video's pixels times `u`, the
// title's size over the video's 96px title.
function buildCta(timeline: gsap.core.Timeline, root: HTMLDivElement) {
  const title = root.querySelector<HTMLElement>('[data-cta="title"]');
  const u = title ? parseFloat(getComputedStyle(title).fontSize) / 96 : 0.75;

  // everything under the name keeps rising until the final hold
  timeline.fromTo('[data-cta="glide"]', { y: 38 * u }, { y: 0, duration: 4.36, ease: "none" }, 0);

  // the mark comes in from the corner and lands beside the name
  timeline.fromTo(
    '[data-cta="mark"]',
    { x: -260 * u, y: -120 * u, scale: 0.5, opacity: 0, filter: "blur(8px)" },
    { x: 0, y: 0, scale: 1, opacity: 1, filter: "blur(0px)", duration: 0.75, ease: "power3.out", clearProps: "filter" },
    0,
  );
  // the name joins the mark as it lands
  timeline.fromTo(
    '[data-cta="name"]',
    { x: 90 * u, opacity: 0, filter: "blur(12px)" },
    { x: 0, opacity: 1, filter: "blur(0px)", duration: 0.55, ease: "power4.out", clearProps: "filter" },
    0.5,
  );

  // words streak in from the lower right and snap into the line; "The" and
  // "ADE that" land side by side, closed over the room the blue box will take
  timeline.fromTo(
    '[data-cta="word"]',
    { x: 150 * u, y: 56 * u, opacity: 0, filter: "blur(12px)" },
    {
      x: 0,
      y: 0,
      opacity: 1,
      filter: "blur(0px)",
      duration: 0.55,
      ease: "power4.out",
      stagger: 0.09,
      clearProps: "filter",
    },
    0.3,
  );

  // then "Open Source" opens between "The" and "ADE", pushing them apart, its
  // blue box widening with it
  const open = { duration: 0.7, ease: "expo.inOut" };
  timeline.fromTo(
    '[data-cta="hl"]',
    { gridTemplateColumns: "minmax(0px, 0fr)" },
    { gridTemplateColumns: "minmax(0px, 1fr)", ...open },
    1.5,
  );
  timeline.fromTo('[data-cta="hl"]', { opacity: 0 }, { opacity: 1, duration: 0.12, ease: "power2.out" }, 1.5);
  timeline.fromTo(
    '[data-cta="hl-box"]',
    { clipPath: "inset(0% 100% 0% 0% round 0.1875em)" },
    { clipPath: "inset(0% 0% 0% 0% round 0.1875em)", ...open },
    1.5,
  );
  timeline.fromTo(
    '[data-cta="hl-text"]',
    { x: 60 * u, filter: "blur(10px)" },
    { x: 0, filter: "blur(0px)", ...open, clearProps: "filter" },
    1.5,
  );

  // the tags pop out around it
  timeline.fromTo(
    '[data-cta="tag"]',
    { scale: 0.7, opacity: 0, filter: "blur(8px)" },
    {
      scale: 1,
      opacity: 1,
      filter: "blur(0px)",
      duration: 0.45,
      ease: "power3.out",
      stagger: 0.16,
      clearProps: "filter",
    },
    2.1,
  );
  timeline.fromTo(
    '[data-cta="button"]',
    { y: 30 * u, scale: 0.92, opacity: 0 },
    { y: 0, scale: 1, opacity: 1, duration: 0.5, ease: "power3.out" },
    2.6,
  );
  timeline.fromTo(
    '[data-cta="aside"]',
    { x: 40 * u, opacity: 0 },
    { x: 0, opacity: 1, duration: 0.5, ease: "power3.out" },
    2.8,
  );

  // a cursor flies in from the lower right and presses the button
  timeline.fromTo('[data-cta="cursor"]', { opacity: 0 }, { opacity: 1, duration: 0.25, ease: "power2.out" }, 2.9);
  timeline.fromTo('[data-cta="cursor"]', { x: 600 * u }, { x: 0, duration: 1.2, ease: "power2.inOut" }, 2.9);
  timeline.fromTo('[data-cta="cursor"]', { y: 244 * u }, { y: 0, duration: 1.2, ease: "sine.inOut" }, 2.9);
  timeline.fromTo('[data-cta="flash"]', { opacity: 0 }, { opacity: 0.8, duration: 0.01 }, 4.16);
  timeline.to('[data-cta="flash"]', { opacity: 0, duration: 0.5, ease: "power2.out" }, 4.17);
  timeline.fromTo('[data-cta="ripple"]', { scale: 0.2, opacity: 0 }, { opacity: 0.9, duration: 0.01 }, 4.16);
  timeline.to('[data-cta="ripple"]', { scale: 1.6, opacity: 0, duration: 0.6, ease: "power3.out" }, 4.17);
  // unlike the video's last frame, the cursor leaves once it has pressed, so
  // it never sits beside the visitor's own pointer
  timeline.to('[data-cta="cursor"]', { opacity: 0, duration: 0.35, ease: "power2.in" }, 4.6);
}

export function CtaScene() {
  const ref = useSceneTimeline<HTMLDivElement>(buildCta);
  const stars = useGitHubStars();

  return (
    <div ref={ref} className={`${styles.scene} relative z-10 mx-auto w-full max-w-7xl`}>
      <div className={styles.lockup}>
        <span data-cta="mark" className={styles.markMove}>
          <Image
            src="/icons/blame-icon-256.png"
            alt=""
            width={256}
            height={256}
            className={styles.mark}
            draggable={false}
          />
        </span>
        <p data-cta="name" className={styles.name}>
          Blame
        </p>
      </div>

      <div data-cta="glide">
        <h2 data-cta="title" className={styles.title}>
          <span data-cta="word" className={`${styles.word} ${styles.dim}`}>
            The
          </span>{" "}
          <span data-cta="hl" className={styles.hl}>
            <span data-cta="hl-box" className={styles.hlBox}>
              <span data-cta="hl-text" className={styles.hlText}>
                Open Source
              </span>
            </span>
          </span>{" "}
          <span aria-hidden="true" className={`${styles.break} ${styles.phoneBreak}`} />
          <span data-cta="word" className={styles.word}>
            ADE
          </span>{" "}
          <span data-cta="word" className={`${styles.word} ${styles.dim}`}>
            that
          </span>{" "}
          <span aria-hidden="true" className={styles.break} />
          <span data-cta="word" className={styles.word}>
            sets
          </span>{" "}
          <span data-cta="word" className={styles.word}>
            the
          </span>{" "}
          <span data-cta="word" className={styles.word}>
            standard
          </span>
        </h2>

        <ul className={styles.tags}>
          <li>
            <a data-cta="tag" href={githubRepositoryUrl} className={styles.pill}>
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="#fcd34d" className={styles.star}>
                <path d="M12 2.5l2.9 6.1 6.6.9-4.8 4.6 1.2 6.6L12 17.6l-5.9 3.1 1.2-6.6L2.5 9.5l6.6-.9z" />
              </svg>
              Star it on GitHub
              {stars !== null && (
                <span className={styles.count}>
                  {formatStarCount(stars)}
                  <span className="sr-only"> {stars === 1 ? "star" : "stars"}</span>
                </span>
              )}
            </a>
          </li>
          <li>
            <span data-cta="tag" className={styles.pill}>
              macOS · Windows · Linux
            </span>
          </li>
          <li>
            <span data-cta="tag" className={styles.pill}>
              50 AI providers
            </span>
          </li>
        </ul>

        <div className={styles.actions}>
          <span className={styles.press}>
            <Link data-cta="button" href="/download" className={styles.button}>
              <span data-cta="flash" aria-hidden="true" className={styles.flash} />
              <span className={styles.buttonLabel}>
                Download Blame
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#08080a"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className={styles.arrow}
                >
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </span>
            </Link>
            <span data-cta="ripple" aria-hidden="true" className={styles.ripple} />
            <svg data-cta="cursor" aria-hidden="true" viewBox="0 0 28 28" className={styles.cursor}>
              <path
                d="M4 2.5l17 10-7.6 1.9-3.4 7.2z"
                fill="#ffffff"
                stroke="#0b0b0f"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <Link data-cta="aside" href="/pricing" className={styles.aside}>
            Compare the free core and Blame Premium
          </Link>
        </div>
      </div>
    </div>
  );
}
