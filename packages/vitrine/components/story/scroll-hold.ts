import gsap from "gsap";

// Holds the page on a pinned story scene while its animation plays on its
// own. Scrolling down is held back and only hurries the scene along, so it
// stays fluid; scrolling up is always free. One scene is held at a time.
export type ScrollHold = {
  section: HTMLElement;
  timeline: gsap.core.Timeline;
  // The last scroll position the scene stays pinned at.
  end: () => number;
};

// How much faster a scene plays while the visitor keeps scrolling down.
const hurryScale = 2.5;

let current: ScrollHold | null = null;
let relax: gsap.core.Tween | null = null;
// Where the finger is, and the highest it went in this gesture.
let touchY = 0;
let touchTopY = 0;

// A swipe keeps the page coasting after the finger lifts, and that momentum
// can't be stopped from its events: on touch, the page stops scrolling at
// all while held.
let touchInput = false;
if (typeof window !== "undefined") {
  const options = { capture: true, passive: true };
  window.addEventListener(
    "touchstart",
    (event) => {
      touchInput = true;
      touchY = touchTopY = event.touches[0]?.clientY ?? 0;
    },
    options,
  );
  window.addEventListener("wheel", () => (touchInput = false), options);
}

export function holdScroll(hold: ScrollHold) {
  if (current === hold) return;
  releaseScroll();
  current = hold;
  if (touchInput) document.documentElement.style.overflow = "hidden";
  window.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("touchmove", onTouchMove, { passive: false });
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("focusin", onFocusIn);
}

// Releases the hold, only if it is the given scene's when one is given.
export function releaseScroll(hold?: ScrollHold) {
  if (!current || (hold && hold !== current)) return;
  window.removeEventListener("wheel", onWheel);
  window.removeEventListener("touchmove", onTouchMove);
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("scroll", onScroll);
  window.removeEventListener("pointerdown", onPointerDown);
  window.removeEventListener("focusin", onFocusIn);
  document.documentElement.style.overflow = "";
  relax?.kill();
  setPace(current.timeline, 1, 0.4);
  current = null;
}

function setPace(
  timeline: gsap.core.Timeline,
  scale: number,
  duration: number,
) {
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

function onWheel(event: WheelEvent) {
  if (event.ctrlKey || event.deltaY <= 0) return;
  event.preventDefault();
  hurry();
}

function onTouchMove(event: TouchEvent) {
  if (event.touches.length > 1) return;
  const y = event.touches[0]?.clientY ?? touchY;
  const forward = y < touchY;
  touchY = y;
  touchTopY = Math.min(touchTopY, y);
  // Pulling the page down is going back up: let the page scroll again.
  if (y - touchTopY > 24) {
    releaseScroll();
    return;
  }
  if (!forward) return;
  if (event.cancelable) event.preventDefault();
  hurry();
}

const forwardKeys = new Set(["ArrowDown", "PageDown", "End", " "]);

function onKeyDown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
    return;
  }
  if (!forwardKeys.has(event.key) || (event.key === " " && event.shiftKey)) {
    return;
  }
  const target = event.target as HTMLElement | null;
  if (
    target?.closest(
      "a, button, input, select, textarea, summary, [contenteditable], [role=button], [role=tab]",
    )
  ) {
    return;
  }
  event.preventDefault();
  hurry();
}

// A scroll the hold could not stop (a fling's momentum, a key press that
// started just before) is brought back to the scene.
function onScroll() {
  if (!current) return;
  const end = current.end();
  if (window.scrollY > end + 1) {
    window.scrollTo({ top: end, behavior: "instant" });
  }
}

// Dragging the scrollbar, or moving focus out of the scene, is the visitor
// going somewhere on purpose: let them.
function onPointerDown(event: PointerEvent) {
  if (event.clientX >= document.documentElement.clientWidth) releaseScroll();
}

function onFocusIn(event: FocusEvent) {
  if (current && !current.section.contains(event.target as Node)) {
    releaseScroll();
  }
}
