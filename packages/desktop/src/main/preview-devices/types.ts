import type { PreviewManifestDeviceTarget } from "@blame/preview-contract";

export type DevicePrerequisite = {
  id: string;
  title: string;
  status: "done" | "missing" | "checking" | "blocked";
  detail?: string;
  action?:
    | { type: "open-terminal"; command: string }
    | { type: "open-url"; url: string }
    | { type: "install"; label: string };
};
export type DeviceAvailability =
  | { status: "ready" }
  | { status: "missing-prerequisites"; prerequisites: DevicePrerequisite[] }
  | {
      status: "unavailable";
      reason: "not_macos" | "cloud_story" | "unsupported_arch";
    };
export type DeviceHandle = {
  id: string;
  platform: "ios" | "android";
  name: string;
  os: string;
  model: string;
  port?: number;
  grpcPort?: number;
  processId?: number;
  width: number;
  height: number;
  pointWidth: number;
  pointHeight: number;
  limited?: string;
  executable?: string;
};
export type DeviceStory = {
  id: string;
  projectId: string;
  title: string;
  worktree: string;
  workspaceMode: "direct" | "local-container" | "cloud-mirror";
  buildRoot: string;
  environment?: Record<string, string>;
  handle?: DeviceHandle;
};
export type DeviceBuildResult =
  | { ok: true; artifact: string; durationMs: number }
  | {
      ok: false;
      summary: string;
      errors: Array<{ file?: string; line?: number; message: string }>;
      logTail: string;
    };
export type DeviceUiNode = {
  role: string;
  label?: string;
  value?: string;
  frame: { x: number; y: number; width: number; height: number };
};
export type DeviceFrame = {
  data: Buffer;
  width: number;
  height: number;
  pointWidth: number;
  pointHeight: number;
};
export type DeviceInput = {
  tap(x: number, y: number): Promise<void>;
  swipe(x: number, y: number, toX: number, toY: number): Promise<void>;
  type(text: string): Promise<void>;
  key(key: string): Promise<void>;
  button(button: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  appearance(value: "light" | "dark"): Promise<void>;
};
export type DeviceScreenSource = {
  frames(signal: AbortSignal): AsyncIterable<DeviceFrame>;
  screenshot(): Promise<Buffer>;
};
export interface DeviceDriver {
  readonly platform: "ios" | "android";
  availability(
    target?: PreviewManifestDeviceTarget,
  ): Promise<DeviceAvailability>;
  ensureDevice(
    story: DeviceStory,
    target: PreviewManifestDeviceTarget,
    signal?: AbortSignal,
  ): Promise<DeviceHandle>;
  build(
    story: DeviceStory,
    target: PreviewManifestDeviceTarget,
    progress: (step: string) => void,
    signal: AbortSignal,
  ): Promise<DeviceBuildResult>;
  install(handle: DeviceHandle, artifact: string): Promise<void>;
  launch(
    handle: DeviceHandle,
    target: PreviewManifestDeviceTarget,
    environment: Record<string, string>,
  ): Promise<void>;
  terminate(
    handle: DeviceHandle,
    target: PreviewManifestDeviceTarget,
  ): Promise<void>;
  shutdown(handle: DeviceHandle): Promise<void>;
  destroy(handle: DeviceHandle): Promise<void>;
  screen(handle: DeviceHandle): DeviceScreenSource;
  input(handle: DeviceHandle): DeviceInput;
  describeUi(handle: DeviceHandle): Promise<DeviceUiNode[]>;
  logs(
    handle: DeviceHandle,
    target: PreviewManifestDeviceTarget,
    signal: AbortSignal,
  ): AsyncIterable<string>;
  ownedDevices?(): Promise<DeviceHandle[]>;
}
export type DeviceState = {
  status: "ready" | "starting" | "stopped" | "failed" | "unavailable";
  message: string;
  step?: string;
  availability?: DeviceAvailability;
  handle?: DeviceHandle;
  build?: DeviceBuildResult;
  logs: string[];
};
