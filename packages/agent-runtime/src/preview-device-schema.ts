const strings = { type: "array", items: { type: "string" }, maxItems: 50 } as const;
const fields = (names: string[]) => ({ type: "object", additionalProperties: false, properties: Object.fromEntries(names.map((name) => [name, { type: "string" }])) });
export const previewDevicesSchema = {
  type: "array", maxItems: 20, items: {
    type: "object", additionalProperties: false, required: ["id", "platform", "projectDir", "toolchain", "build", "app"], properties: {
      id: { type: "string" }, platform: { enum: ["ios", "android"] }, projectDir: { type: "string" }, toolchain: { enum: ["xcode", "expo", "react-native", "flutter", "gradle"] }, prepare: strings,
      build: fields(["workspace", "project", "scheme", "configuration", "module", "variant", "flavor", "target"]),
      app: fields(["bundleId", "applicationId", "launchActivity"]), device: fields(["model", "os"]),
      environment: { type: "object", additionalProperties: { type: "string" } }, dependsOn: strings,
      bindings: { type: "array", maxItems: 50, items: { type: "object", additionalProperties: false, required: ["target", "source"], properties: {
        target: { type: "object", additionalProperties: false, required: ["type", "key"], properties: { type: { const: "environment" }, key: { type: "string" } } },
        source: { ...fields(["service", "endpoint"]), required: ["service", "endpoint"] }, format: { enum: ["url", "host", "port", "host-port"] }, path: { type: "string" },
      } } },
    },
  },
} as const;
