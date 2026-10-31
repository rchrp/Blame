import gsap from "gsap";
import type Lenis from "lenis";

// Holds the page on a pinned story scene while its animation plays on its
// own. Lenis owns the page scroll (see StoryScroll), so the hold stops it in
// the very frame the scroll reaches the scene, before anything is painted:
// nothing ever has to be pulled back. Scrolling down while held only hurries
// the scene along; scrolling up lets the page go. One scene holds at a time.
export type ScrollHold = {
  section: HTMLElement;
  timeline: gsap.core.Timeline;
  // The scroll position the scene holds the page at: where its pin starts.
  at: () => number;
  // Where its pin ends. The page rests there while held, so it moves on as
  // soon as it is released.
  end: () => number;
};

// How much faster a scene plays while the visitor keeps scrolling down.
const hurryScale = 2.5;

const holds = new Set<ScrollHold>();
let lenis: Lenis | null = null;
let lastScroll = 0;
let current: ScrollHold | null = null;
let relax: gsap.core.Tween | null = null;
// Where the finger is, and the highest it went in this gesture.
let touchY = 0;
let touchTopY = 0;

export function registerHold(hold: ScrollHold) {
  holds.add(hold);
  return () => {
    holds.delete(hold);
    releaseScroll(hold);
  };
}

// Hands the holds the page's Lenis. Call it before anything else listens to
// its scroll, so they see the page already held.
export function connectScrollHolds(instance: Lenis) {
  lenis = instance;
  lastScroll = instance.scroll;
  const stopListening = instance.on("scroll", onScroll);
  const listen = { capture: true, passive: true };
  window.addEventListener("wheel", onWheel, listen);
  window.addEventListener("touchstart", onTouchStart, listen);
  window.addEventListener("touchmove", onTouchMove, listen);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("focusin", onFocusIn);
  return () => {
    releaseScroll();
    stopListening();
    window.removeEventListener("wheel", onWheel, listen);
    window.removeEventListener("touchstart", onTouchStart, listen);
    window.removeEventListener("touchmove", onTouchMove, listen);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("focusin", onFocusIn);
    lenis = null;
  };
}

// Releases the hold, only if it is the given scene's when one is given.
export function releaseScroll(hold?: ScrollHold) {
  if (!current || (hold && hold !== current)) return;
  relax?.kill();
  setPace(current.timeline, 1, 0.4);
  current = null;
  lenis?.start();
}

// Holds the page when the scroll has just reached a scene that hasn't
// played to its end. A jump of more than a screen past it doesn't stop.
function onScroll(instance: Lenis) {
  const scroll = instance.scroll;
  const previous = lastScroll;
  lastScroll = scroll;
  if (current || scroll <= previous) return;
  for (const hold of holds) {
    const at = hold.at();
    if (
      previous < at &&
      scroll >= at &&
      scroll - at < window.innerHeight &&
      hold.timeline.progress() < 1
    ) {
      engage(hold, instance);
      return;
    }
  }
}

function engage(hold: ScrollHold, instance: Lenis) {
  current = hold;
  if (hold.timeline.paused()) hold.timeline.play();
  instance.stop();
  instance.scrollTo(hold.end(), { immediate: true, force: true });
  lastScroll = instance.scroll;
}

function setPace(timeline: gsap.core.Timeline, scale: number, duration: number) {
  gsap.to(timeline, {
    timeScale: scale,
    duration,
    ease: "power2.out",
    overwrite: true,
  });
}

function hurry() {
  if (!current) return;
  const { timeline } = current;
  setPace(timeline, hurryScale, 0.3);
  relax?.kill();
  relax = gsap.delayedCall(0.35, () => setPace(timeline, 1, 0.6));
}

// Runs before Lenis sees the wheel: an upward turn releases the page in
// time for Lenis to scroll it up.
function onWheel(event: WheelEvent) {
  if (!current || event.ctrlKey) return;
  if (event.deltaY > 0) hurry();
  else if (event.deltaY < -2) releaseScroll();
}

function onTouchStart(event: TouchEvent) {
  touchY = touchTopY = event.touches[0]?.clientY ?? 0;
}

function onTouchMove(event: TouchEvent) {
  if (event.touches.length > 1) return;
  const y = event.touches[0]?.clientY ?? touchY;
  const forward = y < touchY;
  touchY = y;
  touchTopY = Math.min(touchTopY, y);
  if (!current) return;
  // Pulling the page down is going back up.
  if (y - touchTopY > 24) releaseScroll();
  else if (forward) hurry();
}

const forwardKeys = new Set(["ArrowDown", "PageDown", "End", " "]);
const backKeys = new Set(["ArrowUp", "PageUp", "Home"]);

function onKeyDown(event: KeyboardEvent) {
  if (!current || event.altKey || event.ctrlKey || event.metaKey) return;
  if (backKeys.has(event.key) || (event.key === " " && event.shiftKey)) {
    releaseScroll();
  } else if (forwardKeys.has(event.key)) {
    hurry();
  }
}

// Moving focus out of the scene is the visitor going somewhere on purpose.
function onFocusIn(event: FocusEvent) {
  if (current && !current.section.contains(event.target as Node)) {
    releaseScroll();
  }
}
