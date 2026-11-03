import type { WebContentsView } from "electron";

// A preview page drawn above the app cannot be covered by it: to appear
// out of the app's loading screen, the page shows nothing over a view
// painted in the color that screen ends on, then fades in. Only CSS the
// page's own compositor runs, for half a second, on its root element (a
// pseudo-element would keep its style once its rule is gone).

export const previewRevealDuration = 450;

// Waits on screen hidden before fading in, so the first frame shown is the
// color, never the bare page.
const coverHoldMs = 50;

// A page with no background of its own shows the view's, white by default.
const viewBackground = "#ffffff";

const revealColorPattern = /^#[0-9a-f]{6}$/i;

export function isRevealColor(color: string) {
  return revealColorPattern.test(color);
}

export function previewCoverCss() {
  return "html{opacity:0!important}";
}

// Not important on opacity: the animation has to run on it.
export function previewRevealCss(name: string) {
  return `@keyframes ${name}{from{opacity:0}to{opacity:1}}html{animation:${name} ${previewRevealDuration}ms ease-out both!important}`;
}

// Hides the page over the color now; the returned call, once the view
// shows, fades the page in and puts everything back.
export async function coverPreviewPage(view: WebContentsView, color: string) {
  const none = () => undefined;
  const contents = view.webContents;
  if (!isRevealColor(color) || contents.isDestroyed()) return none;
  const cover = await contents
    .insertCSS(previewCoverCss())
    .catch(() => undefined);
  if (!cover) return none;
  view.setBackgroundColor(color);
  return () => {
    setTimeout(() => void revealPreviewPage(view, cover), coverHoldMs);
  };
}

async function revealPreviewPage(view: WebContentsView, cover: string) {
  const contents = view.webContents;
  if (contents.isDestroyed()) return;
  // Named for this reveal: never a page's own keyframes.
  const name = `blame-preview-reveal-${Date.now().toString(36)}`;
  const fade = await contents
    .insertCSS(previewRevealCss(name))
    .catch(() => undefined);
  await contents.removeInsertedCSS(cover).catch(() => undefined);
  setTimeout(() => {
    if (contents.isDestroyed()) return;
    view.setBackgroundColor(viewBackground);
    if (fade) void contents.removeInsertedCSS(fade).catch(() => undefined);
  }, previewRevealDuration + 100);
}
