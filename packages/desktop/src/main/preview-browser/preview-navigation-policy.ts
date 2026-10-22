export function keepsManagedPreviewBridge(
  currentUrl: string,
  nextUrl: string,
  expectedOrigin: (url: string) => boolean,
) {
  const startsInsidePreview =
    !currentUrl || currentUrl === "about:blank" || expectedOrigin(currentUrl);
  return startsInsidePreview && expectedOrigin(nextUrl);
}

// The agent browser may only open its own preview, or a blank page.
export function previewNavigationPolicy(previewOrigin: string | undefined) {
  return {
    navigationAllowed(url: string) {
      return previewNavigationAllowed(url, previewOrigin);
    },
  };
}

export function previewNavigationAllowed(
  url: string,
  previewOrigin: string | undefined,
) {
  if (url === "about:blank") return true;
  if (!previewOrigin) return false;
  try {
    const target = new URL(url);
    return (
      ["http:", "https:"].includes(target.protocol) &&
      !target.username &&
      !target.password &&
      target.origin === previewOrigin
    );
  } catch {
    return false;
  }
}
