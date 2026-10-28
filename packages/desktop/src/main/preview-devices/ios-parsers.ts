import type { PreviewManifestDeviceTarget } from "@blame/preview-contract";
import type { DeviceUiNode } from "./types.ts";

type IosDeviceType = {
  identifier: string;
  name: string;
  minRuntimeVersionString?: string;
  maxRuntimeVersionString?: string;
};
export function chooseIosDevice(
  list: {
    runtimes: Array<{
      identifier: string;
      version: string;
      name: string;
      isAvailable: boolean;
      supportedDeviceTypes?: IosDeviceType[];
    }>;
    devicetypes: IosDeviceType[];
  },
  target: PreviewManifestDeviceTarget,
) {
  const runtimes = list.runtimes
    .filter((r) => r.isAvailable && /iOS/.test(r.name))
    .sort((a, b) => compareVersions(b.version, a.version));
  const runtime = target.device?.os
    ? runtimes.find((r) => r.version === target.device!.os)
    : runtimes[0];
  // Only a phone the runtime supports can be created: an older or newer model
  // fails with "Incompatible device".
  const supported = runtime?.supportedDeviceTypes?.length
    ? runtime.supportedDeviceTypes
    : list.devicetypes.filter(
        (d) =>
          runtime &&
          compareVersions(d.minRuntimeVersionString ?? "0", runtime.version) <=
            0 &&
          compareVersions(
            runtime.version,
            d.maxRuntimeVersionString ?? "65535",
          ) <= 0,
      );
  const models = supported
    .filter((d) => /^iPhone /.test(d.name))
    .sort((a, b) => phoneGeneration(b.name) - phoneGeneration(a.name));
  const model = target.device?.model
    ? models.find((d) => d.name === target.device!.model)
    : (models.find((d) => /^iPhone \d+$/.test(d.name)) ?? models[0]);
  if (!runtime || !model)
    throw new Error(
      target.device?.model && runtime
        ? `The installed iOS ${runtime.version} simulator has no ${target.device.model}. Choose another device in Preview Environment.`
        : "Install a compatible iOS Simulator runtime in Xcode, then try again.",
    );
  return { runtime, model };
}
function phoneGeneration(name: string) {
  return Number(/^iPhone (\d+)/.exec(name)?.[1] ?? 0);
}
function compareVersions(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true });
}
export function iosBuildArguments(
  target: PreviewManifestDeviceTarget,
  udid: string,
  derivedData: string,
  resultBundle: string,
) {
  const build = target.build;
  if (!build.scheme || Boolean(build.workspace) === Boolean(build.project))
    throw new Error(
      "Select a scheme and one Xcode project or workspace in Preview Environment.",
    );
  return [
    build.workspace ? "-workspace" : "-project",
    build.workspace ?? build.project!,
    "-scheme",
    build.scheme,
    "-configuration",
    build.configuration ?? "Debug",
    "-destination",
    `id=${udid}`,
    "-derivedDataPath",
    derivedData,
    "-resultBundlePath",
    resultBundle,
    "CODE_SIGNING_ALLOWED=NO",
    "build",
  ];
}
export function compactIosUi(value: unknown): DeviceUiNode[] {
  const result: DeviceUiNode[] = [];
  const visit = (value: unknown) => {
    if (result.length >= 400 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    const node = value as Record<string, unknown>;
    const raw = node.frame ?? node.AXFrame;
    let frame =
      raw && typeof raw === "object"
        ? (raw as Record<string, unknown>)
        : undefined;
    if (typeof raw === "string") {
      const numbers = raw.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
      if (numbers?.length === 4)
        frame = {
          x: numbers[0],
          y: numbers[1],
          width: numbers[2],
          height: numbers[3],
        };
    }
    if (
      frame &&
      ["x", "y", "width", "height"].every((k) =>
        Number.isFinite(Number(frame![k])),
      )
    )
      result.push({
        role: String(node.role ?? node.AXRole ?? node.type ?? "element").slice(
          0,
          100,
        ),
        label: String(node.label ?? node.AXLabel ?? "").slice(0, 500),
        value: String(node.value ?? node.AXValue ?? "").slice(0, 500),
        frame: {
          x: Number(frame.x),
          y: Number(frame.y),
          width: Number(frame.width),
          height: Number(frame.height),
        },
      });
    for (const key of ["children", "elements", "AXChildren"]) visit(node[key]);
  };
  visit(value);
  return result;
}
