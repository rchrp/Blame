import type {
  PreviewManifestDeviceTarget,
  PreviewManifestEnvironment,
  PreviewManifestService,
} from "./types.js";

type Helpers = {
  environment(
    value: unknown,
    field: string,
  ): PreviewManifestEnvironment | undefined;
  command(value: string, field: string): void;
  path(value: unknown, field: string): string;
};
export function parseDevices(
  value: unknown,
  helpers: Helpers,
): PreviewManifestDeviceTarget[] {
  if (!Array.isArray(value) || value.length > 20)
    throw new Error("previewManifest devices must be a bounded array");
  return value.map((entry) => {
    const device = object(entry, [
      "id",
      "platform",
      "projectDir",
      "toolchain",
      "prepare",
      "build",
      "app",
      "device",
      "environment",
      "dependsOn",
      "bindings",
    ]);
    const platform = string(device.platform),
      toolchain = string(device.toolchain);
    if (platform !== "ios" && platform !== "android")
      throw new Error("previewManifest device platform is invalid");
    if (
      !["xcode", "expo", "react-native", "flutter", "gradle"].includes(
        toolchain,
      ) ||
      (toolchain === "xcode" && platform !== "ios") ||
      (toolchain === "gradle" && platform !== "android")
    )
      throw new Error(
        "previewManifest device toolchain does not match its platform",
      );
    const build = stringsObject(device.build, [
      "workspace",
      "project",
      "scheme",
      "configuration",
      "module",
      "variant",
      "flavor",
      "target",
    ]);
    for (const key of ["workspace", "project", "target"])
      if (build[key]) helpers.path(build[key], `device.build.${key}`);
    const app = stringsObject(device.app, [
      "bundleId",
      "applicationId",
      "launchActivity",
    ]);
    for (const key of ["bundleId", "applicationId"])
      if (app[key] && !/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_-]+)+$/.test(app[key]!))
        throw new Error("previewManifest app identifier is invalid");
    if (app.launchActivity && !/^[A-Za-z0-9_.$/]+$/.test(app.launchActivity))
      throw new Error("previewManifest launch activity is invalid");
    if (!(platform === "ios" ? app.bundleId : app.applicationId))
      throw new Error(
        `previewManifest device app.${platform === "ios" ? "bundleId" : "applicationId"} is required`,
      );
    if (
      platform === "ios" &&
      toolchain !== "flutter" &&
      toolchain !== "expo" &&
      (!build.scheme || Boolean(build.workspace) === Boolean(build.project))
    )
      throw new Error(
        "previewManifest iOS target requires a scheme and exactly one workspace or project",
      );
    if (build.workspace && build.project)
      throw new Error(
        "previewManifest device build needs exactly one workspace or project",
      );
    const prepare =
      device.prepare === undefined ? undefined : strings(device.prepare);
    for (const command of prepare ?? []) {
      helpers.command(command, "device.prepare");
      if (
        /\b(?:docker|podman|sudo|read)\b|--interactive|\s-it(?:\s|$)/.test(
          command,
        )
      )
        throw new Error(
          "previewManifest device prepare must be non-interactive and must not invoke Docker or sudo",
        );
    }
    const bindings =
      device.bindings === undefined
        ? undefined
        : array(device.bindings).map((entry) => {
            const binding = object(entry, [
              "target",
              "source",
              "format",
              "path",
            ]);
            const target = object(binding.target, ["type", "key"]),
              source = object(binding.source, ["service", "endpoint"]);
            const key = string(target.key);
            if (
              target.type !== "environment" ||
              !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
            )
              throw new Error(
                "previewManifest device binding target is invalid",
              );
            const format =
              binding.format === undefined ? "url" : string(binding.format);
            if (!["url", "host", "port", "host-port"].includes(format))
              throw new Error(
                "previewManifest device binding format is invalid",
              );
            const path =
              binding.path === undefined ? undefined : string(binding.path);
            if (path && (!path.startsWith("/") || /[\r\n\0]/.test(path)))
              throw new Error("previewManifest device binding path is invalid");
            return {
              target: { type: "environment" as const, key },
              source: {
                service: string(source.service),
                endpoint: string(source.endpoint),
              },
              format: format as "url" | "host" | "port" | "host-port",
              ...(path ? { path } : {}),
            };
          });
    return {
      id: string(device.id),
      platform,
      projectDir: helpers.path(device.projectDir, "device.projectDir"),
      toolchain: toolchain as PreviewManifestDeviceTarget["toolchain"],
      build,
      app,
      ...(prepare ? { prepare } : {}),
      ...(device.device
        ? { device: stringsObject(device.device, ["model", "os"]) }
        : {}),
      ...(device.environment
        ? {
            environment: helpers.environment(
              device.environment,
              "device.environment",
            ),
          }
        : {}),
      ...(device.dependsOn !== undefined
        ? { dependsOn: strings(device.dependsOn) }
        : {}),
      ...(bindings ? { bindings } : {}),
    };
  });
}

export function validateDevices(
  devices: PreviewManifestDeviceTarget[],
  services: PreviewManifestService[],
  otherIds: string[],
) {
  const known = new Set(otherIds);
  for (const target of devices) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(target.id) ||
      known.has(target.id)
    )
      throw new Error(
        "previewManifest device ids must be valid and unique among runtime items",
      );
    known.add(target.id);
    for (const id of target.dependsOn ?? [])
      if (!services.some((s) => s.id === id))
        throw new Error(
          `previewManifest device depends on unknown service ${id}`,
        );
    const keys = new Set<string>();
    for (const binding of target.bindings ?? []) {
      if (keys.has(binding.target.key))
        throw new Error("previewManifest device binding keys must be unique");
      keys.add(binding.target.key);
      const source = services
        .find((s) => s.id === binding.source.service)
        ?.endpoints.find((e) => e.id === binding.source.endpoint);
      if (!source)
        throw new Error(
          "previewManifest device binding references an unknown endpoint",
        );
      if ((binding.format ?? "url") === "url" && source.protocol === "tcp")
        throw new Error(
          "previewManifest device URL binding requires an HTTP endpoint",
        );
    }
  }
}
function object(value: unknown, keys: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("previewManifest device field must be an object");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key)))
    throw new Error("previewManifest device contains an unsupported field");
  return result;
}
function string(value: unknown) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 4000 ||
    /[\0\r\n]/.test(value)
  )
    throw new Error("previewManifest device field must be a bounded string");
  return value;
}
function stringsObject(value: unknown, keys: string[]) {
  return Object.fromEntries(
    Object.entries(object(value, keys)).map(([key, value]) => [
      key,
      string(value),
    ]),
  );
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 50)
    throw new Error("previewManifest device field must be a bounded array");
  return value;
}
function strings(value: unknown) {
  return array(value).map(string);
}
