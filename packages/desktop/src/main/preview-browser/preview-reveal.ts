import type { WebContents } from "electron";

// A preview page drawn above the app cannot be covered by it: to appear
// out of the app's loading screen, the page covers itself, in the color
// that screen ends on, then fades that cover out. Only CSS the page's own
// compositor runs, for half a second.

export const previewRevealDuration = 450;

// Waits on screen under its cover before fading, so the first frame shown
// is the cover, never the bare page.
const coverHoldMs = 50;

const revealColorPattern =
  /^(?:#[0-9a-f]{3,8}|(?:rgba?|hsla?|oklch|oklab|lab|lch)\([0-9a-z.,%\s/+-]+\))$/i;

export function isRevealColor(color: string) {
  return color.length <= 64 && revealColorPattern.test(color.trim());
}

function coverRule(color: string, declarations: string) {
  return `:root::after{content:""!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;background:${color}!important;${declarations}}`;
}

export function previewCoverCss(color: string) {
  return coverRule(color, "opacity:1!important;");
}

// Not important on opacity: the animation has to win over it.
export function previewRevealCss(color: string) {
  return `@keyframes blame-preview-reveal{from{opacity:1}to{opacity:0}}${coverRule(
    color,
    `animation:blame-preview-reveal ${previewRevealDuration}ms ease-out forwards!important;`,
  )}`;
}

// Covers the page now; the returned call, once it shows, fades the cover.
export async function coverPreviewPage(contents: WebContents, color: string) {
  const none = () => undefined;
  if (!isRevealColor(color) || contents.isDestroyed()) return none;
  const cover = await contents
    .insertCSS(previewCoverCss(color), { cssOrigin: "user" })
    .catch(() => undefined);
  if (!cover) return none;
  return () => {
    setTimeout(
      () => void fadePreviewCover(contents, color, cover),
      coverHoldMs,
    );
  };
}

async function fadePreviewCover(
  contents: WebContents,
  color: string,
  cover: string,
) {
  if (contents.isDestroyed()) return;
  const fade = await contents
    .insertCSS(previewRevealCss(color), { cssOrigin: "user" })
    .catch(() => undefined);
  await contents.removeInsertedCSS(cover).catch(() => undefined);
  if (!fade) return;
  setTimeout(() => {
    if (!contents.isDestroyed())
      void contents.removeInsertedCSS(fade).catch(() => undefined);
  }, previewRevealDuration + 100);
}
