import type { PreviewManifestDeviceTarget } from "@blame/preview-contract";
import type { DeviceUiNode } from "./types.ts";

export function chooseIosDevice(list: { runtimes: Array<{ identifier: string; version: string; name: string; isAvailable: boolean }>; devicetypes: Array<{ identifier: string; name: string }> }, target: PreviewManifestDeviceTarget) {
  const runtimes = list.runtimes.filter((r) => r.isAvailable && /iOS/.test(r.name)).sort((a,b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  const runtime = target.device?.os ? runtimes.find((r) => r.version === target.device!.os) : runtimes[0];
  const models = list.devicetypes.filter((d) => /^iPhone /.test(d.name)).sort((a,b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
  const model = (target.device?.model ? models.find((d) => d.name === target.device!.model) : undefined) ?? models.find((d) => !/Pro|Max|Plus|mini|SE/.test(d.name)) ?? models[0];
  if (!runtime || !model) throw new Error("Install a compatible iOS Simulator runtime in Xcode, then try again.");
  return { runtime, model };
}
export function iosBuildArguments(target: PreviewManifestDeviceTarget, udid: string, derivedData: string, resultBundle: string) {
  const build = target.build;
  if (!build.scheme || Boolean(build.workspace) === Boolean(build.project)) throw new Error("Select a scheme and one Xcode project or workspace in Preview Environment.");
  return [build.workspace ? "-workspace" : "-project", build.workspace ?? build.project!, "-scheme", build.scheme, "-configuration", build.configuration ?? "Debug", "-destination", `id=${udid}`, "-derivedDataPath", derivedData, "-resultBundlePath", resultBundle, "CODE_SIGNING_ALLOWED=NO", "build"];
}
export function compactIosUi(value: unknown): DeviceUiNode[] {
  const result: DeviceUiNode[] = [];
  const visit = (value: unknown) => {
    if (result.length >= 400 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const child of value) visit(child); return; }
    const node = value as Record<string, unknown>;
    const raw = node.frame ?? node.AXFrame;
    let frame = raw && typeof raw === "object" ? raw as Record<string, unknown> : undefined;
    if (typeof raw === "string") { const numbers = raw.match(/-?\d+(?:\.\d+)?/g)?.map(Number); if (numbers?.length === 4) frame = { x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3] }; }
    if (frame && ["x", "y", "width", "height"].every((k) => Number.isFinite(Number(frame![k])))) result.push({ role: String(node.role ?? node.AXRole ?? node.type ?? "element").slice(0, 100), label: String(node.label ?? node.AXLabel ?? "").slice(0, 500), value: String(node.value ?? node.AXValue ?? "").slice(0, 500), frame: { x: Number(frame.x), y: Number(frame.y), width: Number(frame.width), height: Number(frame.height) } });
    for (const key of ["children", "elements", "AXChildren"]) visit(node[key]);
  };
  visit(value); return result;
}
