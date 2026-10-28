import type {
  PreviewManifestService,
  PreviewManifestSurface,
} from "./types.js";

export function parseSurface(value: unknown): PreviewManifestSurface {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("previewManifest surface must be an object");
  const surface = value as Record<string, unknown>;
  const keys =
    surface.type === "web"
      ? ["type", "device"]
      : surface.type === "terminal"
        ? ["type", "columns", "rows"]
        : surface.type === "display"
          ? ["type", "width", "height"]
          : [];
  if (!keys.length || Object.keys(surface).some((key) => !keys.includes(key)))
    throw new Error("previewManifest surface type or fields are invalid");
  if (surface.type === "terminal")
    return {
      type: "terminal",
      columns: dimension(surface.columns, 40, 300, 120, "columns"),
      rows: dimension(surface.rows, 10, 100, 32, "rows"),
    };
  if (surface.type === "display")
    return {
      type: "display",
      width: dimension(surface.width, 640, 3840, 1280, "width"),
      height: dimension(surface.height, 480, 2160, 800, "height"),
    };
  if (
    surface.device !== undefined &&
    surface.device !== "phone" &&
    surface.device !== "tablet"
  )
    throw new Error("previewManifest surface device is invalid");
  return surface.device
    ? { type: "web", device: surface.device }
    : { type: "web" };
}

export function validateSurfaces(services: PreviewManifestService[]) {
  const reserved = new Set(
    services
      .filter((s) => s.surface?.type === "display")
      .map((s) => `${s.id}__display`),
  );
  for (const service of services) {
    if (reserved.has(service.id))
      throw new Error(`previewManifest service id ${service.id} is reserved`);
    if (!service.surface) continue;
    parseSurface(service.surface);
    if (service.kind !== "preview")
      throw new Error(
        "previewManifest surface is only accepted on preview services",
      );
    if (service.surface.type === "web") continue;
    if (!service.command)
      throw new Error("previewManifest surface requires a command");
    if (service.endpoints.some((e) => e.id === service.surface!.type))
      throw new Error(
        `previewManifest endpoint id ${service.surface.type} is reserved`,
      );
    const port = service.surface.type === "terminal" ? 7681 : 6080;
    if (service.endpoints.some((e) => e.port === port))
      throw new Error(`previewManifest surface reserves port ${port}`);
  }
}

function dimension(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
  name: string,
) {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new Error(
      `previewManifest surface ${name} must be between ${min} and ${max}`,
    );
  return value;
}
