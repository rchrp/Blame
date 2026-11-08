"use client";

import { ScrollTrigger } from "gsap/ScrollTrigger";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ScrollReveal } from "@/components/scroll-reveal";
import type { DemoVideo } from "@/lib/demo-media";
import styles from "./demo-video.module.css";

// The home page's demo videos (configured in lib/demo-media.ts). A video
// that is off, or whose files fail to load, gives way to its fallback, so
// the page never shows a broken player.

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

// The hero's muted loop, in the mockup's place. With reduced motion it
// shows its poster instead. The server renders the poster too, and the
// browser swaps in the video once it knows motion is welcome: the first
// frame and the poster match, so the swap doesn't show.
export function HeroLoop({
  fallback,
  playing,
  video,
}: {
  fallback: ReactNode;
  // False once the hero has faded out, so a hidden loop doesn't keep playing.
  playing: boolean;
  video: DemoVideo;
}) {
  const [failed, setFailed] = useState(false);
  const stillOnly = useStillPreferred();
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const node = videoRef.current;
    if (!node) return;
    if (playing) node.play().catch(() => undefined);
    else node.pause();
  }, [playing, stillOnly]);

  if (!video.enabled || failed) return fallback;

  const fail = () => setFailed(true);
  return (
    <div className={styles.frame} style={frameShape(video)}>
      {stillOnly ? (
        // A plain image: the poster is already sized for the frame. One that
        // failed before the page hydrated has missed onError: its ref sees it.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={(image) => {
            if (image?.complete && !image.naturalWidth) fail();
          }}
          src={video.poster}
          alt={video.label}
          className={styles.media}
          fetchPriority="high"
          onError={fail}
        />
      ) : (
        <video
          ref={videoRef}
          className={styles.media}
          aria-label={video.label}
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          poster={video.poster}
        >
          <VideoSources video={video} onFail={fail} />
        </video>
      )}
    </div>
  );
}

// The full demo, with the browser's controls. Nothing loads until the
// visitor presses play, except the poster. Off, it isn't part of the story.
export function FullDemoSection({ video }: { video: DemoVideo }) {
  const [failed, setFailed] = useState(false);

  // The poster stands for the files: if it is missing, so are they.
  useEffect(() => {
    if (!video.enabled) return;
    const poster = new Image();
    poster.onerror = () => setFailed(true);
    poster.src = video.poster;
    return () => {
      poster.onerror = null;
    };
  }, [video]);

  // Leaving the page changes its height: the pinned scenes measure again.
  useEffect(() => {
    if (failed) ScrollTrigger.refresh();
  }, [failed]);

  if (!video.enabled || failed) return null;

  return (
    <section
      id="demo"
      aria-labelledby="demo-title"
      data-story-section
      className="flex min-h-[100svh] flex-col justify-center px-5 py-24 sm:px-8 lg:px-10"
      style={frameShape(video)}
    >
      <div className="mx-auto w-full max-w-7xl">
        <ScrollReveal className="text-center">
          <p className="story-eyebrow">The full demo</p>
          <h2 id="demo-title" className="story-title mx-auto mt-5 max-w-6xl">
            Backlog to merge in under a minute.
          </h2>
          <p className="story-copy mx-auto mt-7 max-w-3xl">
            Plan the stories, start the agents, try each change in its own
            running app, then review and merge.
          </p>
        </ScrollReveal>
        <ScrollReveal delay={120} className={styles.demoSlot}>
          <div className={styles.frame}>
            <video
              className={styles.media}
              aria-label={video.label}
              controls
              playsInline
              preload="none"
              poster={video.poster}
            >
              <VideoSources video={video} onFail={() => setFailed(true)} />
            </video>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}

// The video's shape, which its frame and the full demo's slot take.
function frameShape(video: DemoVideo) {
  return { "--video-ratio": video.width / video.height } as CSSProperties;
}

// The browser plays the first source it supports. Once the last one has
// failed too, there is nothing left to play.
function VideoSources({
  onFail,
  video,
}: {
  onFail: () => void;
  video: DemoVideo;
}) {
  const last = video.sources.length - 1;
  return video.sources.map((source, index) => (
    <source
      key={source.src}
      src={source.src}
      type={source.type}
      onError={index === last ? onFail : undefined}
    />
  ));
}

// True with reduced motion, and on the server, which can't know.
function useStillPreferred() {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(reducedMotionQuery);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia(reducedMotionQuery).matches,
    () => true,
  );
}
