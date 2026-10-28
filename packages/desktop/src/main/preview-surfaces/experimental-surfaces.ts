const enabled = new Set(
  (process.env.BLAME_EXPERIMENTAL_SURFACES ?? "")
    .split(",")
    .map((s) => s.trim()),
);
export function surfaceEnabled(surface: string) {
  return enabled.has(surface);
}
export function experimentalSurfaces() {
  return [...enabled];
}
