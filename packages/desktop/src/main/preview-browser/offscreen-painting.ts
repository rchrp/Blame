import type { WebContents } from "electron";

// An offscreen page is composited at its frame rate and each frame copied
// out, whether or not anything reads the frames, and its
// requestAnimationFrame loops run with it: a dev app's animations keep a
// core busy while nobody looks. Such a page runs at full rate only while
// something uses it, from the first use until `graceMs` after the last one
// ends. In between it composites one frame a second and copies none.

export type PaintedContents = Pick<
  WebContents,
  | "invalidate"
  | "isDestroyed"
  | "isPainting"
  | "setFrameRate"
  | "startPainting"
  | "stopPainting"
>;

const idleFrameRate = 1;

export function paintOnDemand(
  contents: PaintedContents,
  options: { frameRate: number; graceMs: number },
) {
  let users = 0;
  let timer: NodeJS.Timeout | undefined;
  const stop = () => {
    timer = undefined;
    if (users || contents.isDestroyed()) return;
    contents.setFrameRate(idleFrameRate);
    if (contents.isPainting()) contents.stopPainting();
  };
  stop();
  return {
    // Paints until the returned function is called, and a moment after.
    begin() {
      users += 1;
      clearTimeout(timer);
      timer = undefined;
      if (!contents.isDestroyed() && !contents.isPainting()) {
        contents.setFrameRate(options.frameRate);
        contents.startPainting();
        // The next capture gets a fresh frame, not the one from before.
        contents.invalidate();
      }
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        users -= 1;
        if (users) return;
        if (options.graceMs <= 0) return stop();
        timer = setTimeout(stop, options.graceMs);
        timer.unref?.();
      };
    },
    dispose() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
