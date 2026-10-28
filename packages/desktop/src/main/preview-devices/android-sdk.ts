import { existsSync } from "node:fs";
import { join, win32, posix } from "node:path";
export const androidToolsRelease = {
  version: "23.0", build: "16111833",
  linux: { file: "commandlinetools-linux-16111833_latest.zip", sha256: "0877a1d048fe4a24efe2eff536ca4223f7adeb58648bb81909d33c446918cfa8" },
  mac_x86_64: { file: "commandlinetools-mac_x86_64-16111833_latest.zip", sha256: "7e601c04e7173754b3d051a87bb4c3a8243c65a9d7bfa9356ed6499fb8953fa3" },
  mac_arm64: { file: "commandlinetools-mac_arm64-16111833_latest.zip", sha256: "58da8f215781cc0208743e88b65ae259780c55e7eb40e50373d377cf369232d6" },
  win: { file: "commandlinetools-win-16111833_latest.zip", sha256: "e5885e2e59038c0778a85fc19f01de7ce7c567c105553f7617b936b1e0e87b2b" },
} as const;
export function androidSdkCandidates(platform: NodeJS.Platform, home: string, dataRoot: string, env: NodeJS.ProcessEnv) {
  const path = platform === "win32" ? win32 : posix;
  return [...new Set([env.ANDROID_HOME,env.ANDROID_SDK_ROOT, platform === "darwin" ? path.join(home,"Library/Android/sdk") : platform === "win32" ? path.join(env.LOCALAPPDATA ?? path.join(home,"AppData/Local"),"Android/Sdk") : path.join(home,"Android/Sdk"), path.join(dataRoot,"device-tools/android-sdk")].filter((v): v is string => Boolean(v)))];
}
export function detectAndroidSdk(platform: NodeJS.Platform, home: string, dataRoot: string, env: NodeJS.ProcessEnv = process.env, exists = existsSync) {
  const path = platform === "win32" ? win32 : posix, executable = platform === "win32" ? "sdkmanager.bat" : "sdkmanager";
  const candidates = androidSdkCandidates(platform,home,dataRoot,env);
  return candidates.find((p) => exists(path.join(p,"cmdline-tools/latest/bin",executable)) || exists(path.join(p,"cmdline-tools",androidToolsRelease.version,"bin",executable))) ?? candidates.find((p) => exists(path.join(p,"platform-tools",platform === "win32" ? "adb.exe":"adb"))) ?? candidates.at(-1)!;
}
export function androidTool(root: string, tool: "adb" | "emulator" | "sdkmanager" | "avdmanager", platform: NodeJS.Platform = process.platform) {
  const path = platform === "win32" ? win32 : posix;
  if (tool === "adb") return path.join(root,"platform-tools",tool+(platform === "win32" ? ".exe" : ""));
  if (tool === "emulator") return path.join(root,"emulator",tool+(platform === "win32" ? ".exe" : ""));
  const versioned = path.join(root,"cmdline-tools",androidToolsRelease.version,"bin",tool+(platform === "win32" ? ".bat" : ""));
  return existsSync(versioned) ? versioned : path.join(root,"cmdline-tools/latest/bin",tool+(platform === "win32" ? ".bat" : ""));
}
export function androidAbi(platform: NodeJS.Platform, arch: string) { return platform === "darwin" && arch === "arm64" ? "arm64-v8a" : "x86_64"; }
export function androidSystemImage(api = "35", abi = "x86_64") { if (!/^\d{2,3}$/.test(api) || !["arm64-v8a","x86_64"].includes(abi)) throw new Error("Choose a supported Android API level and processor."); return `system-images;android-${api};google_apis;${abi}`; }
