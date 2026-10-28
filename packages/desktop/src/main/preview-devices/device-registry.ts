import type { DeviceTargetService } from "./device-target-service.ts";
let service: DeviceTargetService | undefined;
const stories = new Map<string, { worktree: string }>();
export function registerDeviceService(value: DeviceTargetService) { service = value; }
export function registerDeviceStory(id: string, worktree: string) { stories.set(id, { worktree }); }
export async function stopDevicesForWorktree(worktree: string, destroy = false) { for (const [id, story] of stories) if (story.worktree === worktree) { await service?.stop(id, destroy); if (destroy) stories.delete(id); } }
export async function stopAllDevices() { for (const id of stories.keys()) await service?.stop(id); }
