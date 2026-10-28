import { EventEmitter } from "node:events";
import type { PreviewManifestDeviceTarget } from "@blame/preview-contract";
import type { DeviceAvailability, DeviceDriver, DeviceHandle, DeviceState, DeviceStory } from "./types.ts";

type Session = { story: DeviceStory; target: PreviewManifestDeviceTarget; state: DeviceState; handle?: DeviceHandle; lastActivity: number; booted: boolean; pending?: Promise<DeviceState>; abort?: AbortController };
export type DeviceServiceOptions = {
  drivers: DeviceDriver[];
  mirror(story: DeviceStory): Promise<string>;
  prepare(story: DeviceStory, target: PreviewManifestDeviceTarget, signal: AbortSignal, log: (text: string) => void): Promise<void>;
  services(story: DeviceStory, target: PreviewManifestDeviceTarget): Promise<Record<string, string>>;
  confirm(story: DeviceStory): Promise<boolean>;
  persist(records: Array<{ story: DeviceStory; target: PreviewManifestDeviceTarget; handle?: DeviceHandle; artifact?: string; builtAt?: number }>): Promise<void>;
  removeMirror(story: DeviceStory): Promise<void>;
  limit?: number;
  now?: () => number;
};
export class DeviceTargetService extends EventEmitter {
  private readonly options: DeviceServiceOptions;
  private readonly sessions = new Map<string, Session>();
  private readonly drivers: Map<string, DeviceDriver>;
  private pool = Promise.resolve();
  constructor(options: DeviceServiceOptions) { super(); this.options = options; this.drivers = new Map(options.drivers.map((d) => [d.platform, d])); }
  async availability(story: DeviceStory, target: PreviewManifestDeviceTarget): Promise<DeviceAvailability> {
    if (story.workspaceMode === "cloud-mirror") return { status: "unavailable", reason: "cloud_story" };
    return this.driver(target).availability(target);
  }
  status(storyId: string, touch = true): DeviceState {
    const session = this.sessions.get(storyId);
    if (session && touch) session.lastActivity = this.now();
    return session?.state ?? { status: "stopped", message: "Build and run the app to open its device.", logs: [] };
  }
  start(story: DeviceStory, target: PreviewManifestDeviceTarget): Promise<DeviceState> {
    const existing = this.sessions.get(story.id);
    if (existing && (existing.target.id !== target.id || existing.target.platform !== target.platform || existing.story.worktree !== story.worktree)) return this.stop(story.id, true).then(() => this.start(story, target));
    if (existing?.pending) return existing.pending;
    existing?.abort?.abort();
    const same = existing?.target.id === target.id;
    const session: Session = same ? existing! : { story, target, state: { status: "stopped", message: "Stopped", logs: [] }, booted: false, lastActivity: this.now() };
    session.story = story; session.target = target; session.abort = new AbortController();
    this.sessions.set(story.id, session);
    const pending = this.buildAndRun(session).finally(() => { if (session.pending === pending) session.pending = undefined; });
    session.pending = pending;
    return pending;
  }
  private async buildAndRun(session: Session) {
    const { story, target } = session, driver = this.driver(target), signal = session.abort!.signal;
    try {
      const availability = await this.availability(story, target);
      if (availability.status !== "ready") { this.update(session, { status: "unavailable", message: "This device is not available here yet.", availability }); return session.state; }
      if (!(await this.options.confirm(story))) { this.update(session, { status: "stopped", message: "Build cancelled. Your project's build scripts need permission to run on this computer." }); return session.state; }
      this.update(session, { status: "starting", message: "Preparing the app", step: "Preparing the build folder", build: undefined });
      story.buildRoot = await this.options.mirror(story);
      story.environment = await this.options.services(story, target);
      await this.options.prepare(story, target, signal, (text) => this.log(session, text));
      const boot = this.reserveDevice(session, driver);
      const progress = (step: string) => this.update(session, { status: "starting", message: step, step });
      const build = target.toolchain === "flutter"
        ? boot.then((handle) => { story.handle = handle; return driver.build(story, target, progress, signal); })
        : driver.build(story, target, progress, signal);
      // Wait for both even after a build failure so stop owns the created device.
      const results = await Promise.allSettled([boot, build]);
      signal.throwIfAborted();
      if (results[0].status === "rejected") throw results[0].reason;
      if (results[1].status === "rejected") throw results[1].reason;
      const handle = results[0].value, built = results[1].value;
      session.state.build = built;
      if (!built.ok) { this.update(session, { status: "failed", message: built.summary, build: built, handle }); return session.state; }
      progress("Installing");
      await driver.install(handle, built.artifact);
      progress("Launching");
      await driver.launch(handle, target, story.environment ?? {});
      signal.throwIfAborted();
      this.update(session, { status: "ready", message: handle.limited ?? "Running", step: undefined, handle, build: built });
      session.lastActivity = this.now();
      await this.persist();
      void this.collectLogs(session, driver, signal);
      return session.state;
    } catch (error) {
      this.update(session, { status: signal.aborted ? "stopped" : "failed", message: signal.aborted ? "Stopped" : error instanceof Error ? error.message : "The app could not start. Check its build logs and try again." });
      return session.state;
    }
  }
  private reserveDevice(session: Session, driver: DeviceDriver): Promise<DeviceHandle> {
    const operation = this.pool.then(async () => {
      const others = [...this.sessions.values()].filter((s) => s !== session && s.booted && s.target.platform === session.target.platform);
      if (!session.booted && others.length >= (this.options.limit ?? 2)) {
        const idle = others.filter((s) => !s.pending).sort((a, b) => a.lastActivity - b.lastActivity)[0];
        if (!idle) { await Promise.race(others.map((s) => s.pending)); return this.bootAfterSlot(session, driver); }
        await this.shutdown(idle);
      }
      return this.bootAfterSlot(session, driver);
    });
    this.pool = operation.then(() => undefined, () => undefined);
    return operation;
  }
  private async bootAfterSlot(session: Session, driver: DeviceDriver) {
    const others = [...this.sessions.values()].filter((s) => s !== session && s.booted && s.target.platform === session.target.platform).sort((a,b) => a.lastActivity-b.lastActivity);
    while (!session.booted && others.length >= (this.options.limit ?? 2)) await this.shutdown(others.shift()!);
    this.update(session, { status: "starting", message: session.target.platform === "ios" ? "Booting the iPhone simulator" : "Booting the Android emulator" });
    const handle = await driver.ensureDevice({ ...session.story, handle: session.handle }, session.target);
    session.handle = handle; session.booted = true; session.story.handle = handle;
    return handle;
  }
  async stop(storyId: string, destroy = false) {
    const session = this.sessions.get(storyId); if (!session) return;
    session.abort?.abort(); await session.pending?.catch(() => undefined);
    if (session.handle) {
      await this.driver(session.target).terminate(session.handle, session.target).catch(() => undefined);
      await this.shutdown(session);
      if (destroy) await this.driver(session.target).destroy(session.handle);
    }
    if (destroy) { await this.options.removeMirror(session.story); this.sessions.delete(storyId); }
    await this.persist();
  }
  async shutdownIdle() { for (const session of this.sessions.values()) if (session.booted && !session.pending && this.now() - session.lastActivity >= 20 * 60000) await this.stop(session.story.id); }
  async cleanupOrphans(knownStory: (id: string) => Promise<boolean | undefined>) {
    for (const session of this.sessions.values()) if (await knownStory(session.story.id) === false) await this.stop(session.story.id, true);
    for (const driver of this.drivers.values()) for (const handle of await driver.ownedDevices?.() ?? []) {
      if (!handle.name.startsWith("Blame · ")) continue;
      const owner = [...this.sessions.values()].find((s) => s.handle?.id === handle.id);
      if (!owner) await driver.destroy(handle);
    }
  }
  restore(records: Array<{ story: DeviceStory; target: PreviewManifestDeviceTarget; handle?: DeviceHandle }>) {
    for (const record of records) this.sessions.set(record.story.id, { ...record, booted: false, lastActivity: this.now(), state: { status: "stopped", message: "Build and run to resume this device.", logs: [], handle: record.handle } });
  }
  active(storyId: string) { const session = this.sessions.get(storyId); if (!session?.handle || !session.booted) throw new Error("Start the device preview before using it."); session.lastActivity = this.now(); return { driver: this.driver(session.target), handle: session.handle, target: session.target, environment: session.story.environment ?? {} }; }
  private async shutdown(session: Session) { session.abort?.abort(); if (session.handle) await this.driver(session.target).shutdown(session.handle); session.booted = false; this.update(session, { status: "stopped", message: "Stopped" }); }
  private async collectLogs(session: Session, driver: DeviceDriver, signal: AbortSignal) { try { for await (const line of driver.logs(session.handle!, session.target, signal)) this.log(session, line); } catch { /* Log streams end when the device stops. */ } }
  private log(session: Session, text: string) { session.state.logs = [...session.state.logs, ...text.split(/\r?\n/)].slice(-200); this.emit("state", session.story.id, session.state); }
  private update(session: Session, value: Partial<DeviceState>) { session.state = { ...session.state, ...value }; this.emit("state", session.story.id, session.state); }
  private persist() { return this.options.persist([...this.sessions.values()].map((s) => ({ story: { ...s.story, environment: undefined }, target: s.target, handle: s.handle, artifact: s.state.build?.ok ? s.state.build.artifact : undefined, builtAt: s.state.build?.ok ? this.now() : undefined }))); }
  private driver(target: PreviewManifestDeviceTarget) { const driver = this.drivers.get(target.platform); if (!driver) throw new Error("This device platform is unavailable on this computer."); return driver; }
  private now() { return this.options.now?.() ?? Date.now(); }
}
