// Screen previews are done and ship enabled. Surfaces still being built wait
// behind BLAME_EXPERIMENTAL_SURFACES (comma-separated), read once.
const shipped = ["display"];
const enabled = new Set(
  [...shipped, ...(process.env.BLAME_EXPERIMENTAL_SURFACES ?? "").split(",")]
    .map((s) => s.trim())
    .filter(Boolean),
);
export function surfaceEnabled(surface: string) {
  return enabled.has(surface);
}
export function experimentalSurfaces() {
  return [...enabled];
}
