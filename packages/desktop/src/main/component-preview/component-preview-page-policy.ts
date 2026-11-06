// A component preview page may only load its own temporary server, over
// HTTP and its HMR WebSocket, plus inline data. Nothing else: no app
// backend, no other preview, no remote site.
export function componentPreviewRequestAllowed(
  url: string,
  origins: ReadonlySet<string>,
) {
  try {
    const target = new URL(url);
    if (["about:", "blob:", "data:"].includes(target.protocol)) return true;
    if (target.username || target.password) return false;
    if (!["http:", "ws:"].includes(target.protocol)) return false;
    return origins.has(`http://${target.host}`);
  } catch {
    return false;
  }
}
