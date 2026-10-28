import type { PreviewManifestDeviceTarget } from "@blame/preview-contract";
import type { DeviceUiNode } from "./types.ts";
export function androidBuildArguments(target: PreviewManifestDeviceTarget) {
  const module = target.build.module ?? "app",
    variant = target.build.variant ?? "debug";
  if (!/^[A-Za-z0-9_:-]+$/.test(module) || !/^[A-Za-z0-9_]+$/.test(variant))
    throw new Error("The Gradle module or variant is invalid.");
  return [
    `:${module.replace(/^:/, "")}:assemble${variant[0]!.toUpperCase()}${variant.slice(1)}`,
  ];
}
export function androidEmulatorArguments(
  avd: string,
  port: number,
  grpcPort: number,
) {
  if (
    !Number.isInteger(port) ||
    port % 2 ||
    port < 5554 ||
    port > 5682 ||
    !Number.isInteger(grpcPort) ||
    grpcPort < 1024 ||
    grpcPort > 65535
  )
    throw new Error("Invalid emulator ports.");
  return [
    "-avd",
    avd,
    "-read-only",
    "-no-snapshot-save",
    "-no-window",
    "-no-audio",
    "-no-boot-anim",
    "-port",
    String(port),
    "-grpc",
    String(grpcPort),
    "-grpc-use-token",
  ];
}
export function androidUiNodes(xml: string, density: number): DeviceUiNode[] {
  const nodes: DeviceUiNode[] = [];
  const decode = (s: string) =>
    s.replace(
      /&(?:quot|apos|lt|gt|amp);/g,
      (m) =>
        ({
          "&quot;": '"',
          "&apos;": "'",
          "&lt;": "<",
          "&gt;": ">",
          "&amp;": "&",
        })[m]!,
    );
  for (const match of xml.matchAll(/<node\b[^>]*>/g)) {
    if (nodes.length >= 400) break;
    const attrs = Object.fromEntries(
      [...match[0].matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [
        m[1]!,
        decode(m[2]!),
      ]),
    );
    const bounds = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(attrs.bounds ?? "");
    if (!bounds) continue;
    const [x, y, toX, toY] = bounds.slice(1).map(Number),
      scale = Number.isFinite(density) && density > 0 ? density / 160 : 1;
    nodes.push({
      role: attrs.class ?? "element",
      label: attrs["content-desc"] || attrs.text,
      value: attrs.text,
      frame: {
        x: x! / scale,
        y: y! / scale,
        width: (toX! - x!) / scale,
        height: (toY! - y!) / scale,
      },
    });
  }
  return nodes;
}
