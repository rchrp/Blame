import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { PreviewSessionView } from "@blame/preview-runtime";
import {
  CloudPreviewRequestError,
  type CloudPreviewClient,
} from "../preview-runtime/cloud-preview-client.ts";
import { WorkspaceSyncService } from "./workspace-sync-service.ts";
import { snapshotWorkspace } from "./workspace-snapshot.ts";

const execFileAsync = promisify(execFile);

test("the sync barrier ignores VM worktrees absent from the host with cloud sessions registered", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-sync-barrier-"));
  try {
    const index = join(root, "index.json");
    await writeFile(index, JSON.stringify([["cloud-session", root]]));
    const service = new WorkspaceSyncService(index);
    service.flushLive = async () =>
      assert.fail("Unrelated cloud session flushed");
    await service.flushWorkspace(
      `/home/blame/.local/share/blame/runtime/worktrees/${root.split("/").pop()}/story-US-002-untitled-user-story`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the sync barrier preserves errors for missing registered cloud workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-sync-barrier-"));
  try {
    const missing = join(root, "missing");
    const index = join(root, "index.json");
    await writeFile(index, JSON.stringify([["cloud-session", missing]]));
    const service = new WorkspaceSyncService(index);
    await assert.rejects(service.flushWorkspace(missing), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the sync barrier resolves aliases and awaits the registered cloud flush", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-sync-barrier-"));
  try {
    const index = join(root, "index.json");
    await writeFile(
      index,
      JSON.stringify([["cloud-session", await realpath(root)]]),
    );
    const alias = join(root, "alias");
    await symlink(root, alias, "junction");
    const service = new WorkspaceSyncService(index);
    service.flushLive = async (sessionId) => {
      assert.equal(sessionId, "cloud-session");
      throw new Error("Cloud flush failed");
    };
    await assert.rejects(service.flushWorkspace(alias), /Cloud flush failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skips upload and import when the persisted workspace hash is unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "blame-workspace-sync-"));
  try {
    await execFileAsync("git", ["-C", root, "init", "--quiet"]);
    await execFileAsync("git", ["-C", root, "config", "user.name", "Blame"]);
    await execFileAsync("git", [
      "-C",
      root,
      "config",
      "user.email",
      "preview@blame.local",
    ]);
    await writeFile(join(root, "package.json"), '{"name":"fixture"}\n');
    await execFileAsync("git", ["-C", root, "add", "package.json"]);
    await execFileAsync("git", [
      "-C",
      root,
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);

    const service = new WorkspaceSyncService();
    const metadata = await service.prepareInitial(root);
    const session = {
      id: "preview_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sourceRevision: metadata.sourceRevision,
      workspaceHash: metadata.workspaceHash,
      state: {
        host: "running",
        engine: "idle",
        preview: "closed",
        agent: "idle",
        sync: "clean",
      },
    } as PreviewSessionView;
    let uploadPrepared = false;
    const client = {
      async negotiateSource() {
        return { unchanged: true, session };
      },
      async prepareSourceUpload() {
        uploadPrepared = true;
        throw new Error("upload should have been skipped");
      },
    } as unknown as CloudPreviewClient;

    const result = await service.syncInitial(client, session.id, root);

    assert.equal(result.session, session);
    assert.equal(result.workspaceHash, metadata.workspaceHash);
    assert.equal(uploadPrepared, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renegotiates a full upload when an exact baseline expires during sync", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "blame-workspace-sync-"));
  try {
    await execFileAsync("git", ["-C", root, "init", "--quiet"]);
    await execFileAsync("git", ["-C", root, "config", "user.name", "Blame"]);
    await execFileAsync("git", [
      "-C",
      root,
      "config",
      "user.email",
      "preview@blame.local",
    ]);
    await writeFile(join(root, "package.json"), '{"name":"fixture"}\n');
    await execFileAsync("git", ["-C", root, "add", "package.json"]);
    await execFileAsync("git", [
      "-C",
      root,
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
    context.mock.method(
      globalThis,
      "fetch",
      async () => new Response(null, { status: 200 }),
    );

    const service = new WorkspaceSyncService();
    await service.prepareInitial(root);
    const session = {
      id: "preview_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      state: {
        host: "running",
        engine: "idle",
        preview: "closed",
        agent: "idle",
        sync: "clean",
      },
    } as PreviewSessionView;
    let negotiations = 0;
    let applications = 0;
    const uploadModes: Array<"full" | "delta" | undefined> = [];
    const commands: string[] = [];
    const client = {
      async negotiateSource() {
        negotiations += 1;
        return {
          unchanged: false,
          session,
          baseline:
            negotiations === 1
              ? { id: "baseline-expired", match: "exact" as const }
              : undefined,
        };
      },
      async prepareSourceUpload(
        _sessionId: string,
        artifact: { mode?: "full" | "delta" },
      ) {
        uploadModes.push(artifact.mode);
        return {
          artifactId: `artifact-${uploadModes.length}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          headers: {},
          url: "https://storage.example/artifact",
        };
      },
      async applySourceUpload() {
        applications += 1;
        if (applications === 1) {
          throw new CloudPreviewRequestError(
            503,
            {
              code: "SOURCE_SYNC_FAILED",
              providerCode: "BASELINE_SNAPSHOT_NOT_FOUND",
              retryable: true,
            },
            "baseline unavailable",
          );
        }
        return session;
      },
      async command(_sessionId: string, command: { type: string }) {
        commands.push(command.type);
        return session;
      },
    } as unknown as CloudPreviewClient;

    const result = await service.syncInitial(client, session.id, root);

    assert.equal(result.session, session);
    assert.equal(negotiations, 2);
    assert.deepEqual(uploadModes, ["delta", "full"]);
    assert.deepEqual(commands, ["resume-host"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applies ordinary local edits as a live delta without restarting services", async (context) => {
  const root = await workspaceFixture();
  try {
    context.mock.method(
      globalThis,
      "fetch",
      async () => new Response(null, { status: 200 }),
    );
    const service = new WorkspaceSyncService();
    const metadata = await service.prepareInitial(root);
    const session = runningSession(metadata.workspaceHash);
    let uploaded:
      | { baseHash?: string; workspaceHash?: string; mode?: string }
      | undefined;
    const commands: string[] = [];
    const client = {
      async negotiateSource() {
        return { unchanged: true, session };
      },
      async get() {
        return session;
      },
      async prepareSourceUpload(_sessionId: string, artifact: typeof uploaded) {
        uploaded = artifact;
        return uploadTarget();
      },
      async applySourceUpload() {
        session.workspaceHash = uploaded!.workspaceHash;
        return session;
      },
      async command(_sessionId: string, command: { type: string }) {
        commands.push(command.type);
        return session;
      },
    } as unknown as CloudPreviewClient;
    await service.syncInitial(client, session.id, root);
    await writeFile(join(root, "index.js"), "console.log('live')\n");

    const result = await service.syncLive(client, session.id, root);

    assert.equal(result.synchronized, true);
    assert.equal(uploaded?.mode, "delta");
    assert.equal(uploaded?.baseHash, metadata.workspaceHash);
    assert.notEqual(uploaded?.workspaceHash, metadata.workspaceHash);
    assert.deepEqual(commands, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovers when the live delta was applied but its response was lost", async (context) => {
  const root = await workspaceFixture();
  try {
    context.mock.method(
      globalThis,
      "fetch",
      async () => new Response(null, { status: 200 }),
    );
    const service = new WorkspaceSyncService();
    const metadata = await service.prepareInitial(root);
    const session = runningSession(metadata.workspaceHash);
    let uploadedWorkspaceHash: string | undefined;
    const commands: string[] = [];
    const client = {
      async negotiateSource() {
        return { unchanged: true, session };
      },
      async get() {
        return session;
      },
      async prepareSourceUpload(
        _sessionId: string,
        artifact: { workspaceHash?: string },
      ) {
        uploadedWorkspaceHash = artifact.workspaceHash;
        return uploadTarget();
      },
      async applySourceUpload() {
        session.workspaceHash = uploadedWorkspaceHash;
        throw new Error("response lost");
      },
      async command(_sessionId: string, command: { type: string }) {
        commands.push(command.type);
        return session;
      },
    } as unknown as CloudPreviewClient;
    await service.syncInitial(client, session.id, root);
    await writeFile(join(root, "index.js"), "console.log('ambiguous')\n");

    const result = await service.syncLive(client, session.id, root);

    assert.equal(result.synchronized, true);
    assert.equal(result.session.workspaceHash, uploadedWorkspaceHash);
    assert.deepEqual(commands, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restarts active services when a dependency input changes", async () => {
  const root = await workspaceFixture();
  try {
    const service = new WorkspaceSyncService();
    const metadata = await service.prepareInitial(root);
    const session = runningSession(metadata.workspaceHash);
    let negotiatedWorkspaceHash = metadata.workspaceHash;
    const commands: string[] = [];
    const client = {
      async negotiateSource(
        _sessionId: string,
        current: { workspaceHash: string },
      ) {
        negotiatedWorkspaceHash = current.workspaceHash;
        session.workspaceHash = current.workspaceHash;
        return { unchanged: true, session };
      },
      async get() {
        return session;
      },
      async command(_sessionId: string, command: { type: string }) {
        commands.push(command.type);
        if (command.type === "stop-services") session.state.engine = "stopped";
        if (command.type === "start-services") session.state.engine = "running";
        return session;
      },
    } as unknown as CloudPreviewClient;
    await service.syncInitial(client, session.id, root);
    await writeFile(
      join(root, "package.json"),
      '{"name":"fixture","dependencies":{"vite":"latest"}}\n',
    );

    const result = await service.syncLive(client, session.id, root);

    assert.equal(result.synchronized, true);
    assert.notEqual(negotiatedWorkspaceHash, metadata.workspaceHash);
    assert.deepEqual(commands, ["stop-services", "start-services"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("watches the attached worktree and pushes later edits automatically", async (context) => {
  const root = await workspaceFixture();
  const service = new WorkspaceSyncService();
  try {
    context.mock.method(
      globalThis,
      "fetch",
      async () => new Response(null, { status: 200 }),
    );
    const metadata = await service.prepareInitial(root);
    const session = runningSession(metadata.workspaceHash);
    let uploadedWorkspaceHash: string | undefined;
    let applied!: () => void;
    const application = new Promise<void>((resolve) => {
      applied = resolve;
    });
    const client = {
      async negotiateSource() {
        return { unchanged: true, session };
      },
      async get() {
        return session;
      },
      async prepareSourceUpload(
        _sessionId: string,
        artifact: { workspaceHash?: string },
      ) {
        uploadedWorkspaceHash = artifact.workspaceHash;
        return uploadTarget();
      },
      async applySourceUpload() {
        session.workspaceHash = uploadedWorkspaceHash;
        applied();
        return session;
      },
    } as unknown as CloudPreviewClient;
    await service.syncInitial(client, session.id, root);
    await service.attachLive(client, session.id, root);

    await writeFile(join(root, "index.js"), "console.log('watched')\n");
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        application,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Live workspace edit was not synchronized")),
            5_000,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    assert.notEqual(uploadedWorkspaceHash, metadata.workspaceHash);
  } finally {
    service.closeLive();
    await rm(root, { recursive: true, force: true });
  }
});

test("files the app generates do not trigger a live delta", async (context) => {
  const root = await workspaceFixture();
  try {
    context.mock.method(
      globalThis,
      "fetch",
      async () => new Response(null, { status: 200 }),
    );
    await writeFile(join(root, ".gitignore"), "generated/\n");
    const service = new WorkspaceSyncService();
    const metadata = await service.prepareInitial(root);
    const session = runningSession(metadata.workspaceHash);
    let uploads = 0;
    const client = {
      async negotiateSource() {
        return { unchanged: true, session };
      },
      async get() {
        return session;
      },
      async prepareSourceUpload() {
        uploads += 1;
        return uploadTarget();
      },
    } as unknown as CloudPreviewClient;
    await service.syncInitial(client, session.id, root);
    await mkdir(join(root, "generated"));
    await writeFile(join(root, "generated/client.ts"), "generated\n");

    const result = await service.syncLive(client, session.id, root);

    assert.equal(result.synchronized, false);
    assert.equal(uploads, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a base saved before snapshot rules resynchronizes once with the current rule", async (context) => {
  const root = await realpath(await workspaceFixture());
  const state = await mkdtemp(join(tmpdir(), "blame-workspace-index-"));
  try {
    context.mock.method(
      globalThis,
      "fetch",
      async () => new Response(null, { status: 200 }),
    );
    await writeFile(join(root, ".gitignore"), "generated/\n");
    await mkdir(join(root, "generated"));
    await writeFile(join(root, "generated/client.ts"), "generated\n");
    const { policy: _policy, ...legacy } = await snapshotWorkspace(
      root,
      "legacy",
    );
    const session = runningSession(legacy.hash);
    const indexPath = join(state, "workspace-index.json");
    await writeFile(indexPath, JSON.stringify([[session.id, root]]));
    await writeFile(
      `${indexPath}.snapshots.json`,
      JSON.stringify([[session.id, legacy]]),
    );
    let uploaded: { mode?: string; workspaceHash?: string } | undefined;
    const commands: string[] = [];
    const client = {
      async negotiateSource() {
        return { unchanged: false, session };
      },
      async get() {
        return session;
      },
      async prepareSourceUpload(_sessionId: string, artifact: typeof uploaded) {
        uploaded = artifact;
        return uploadTarget();
      },
      async applySourceUpload() {
        session.workspaceHash = uploaded!.workspaceHash!;
        return session;
      },
      async command(_sessionId: string, command: { type: string }) {
        commands.push(command.type);
        return session;
      },
    } as unknown as CloudPreviewClient;
    const service = new WorkspaceSyncService(indexPath);

    const first = await service.syncLive(client, session.id);
    const second = await service.syncLive(client, session.id);

    assert.equal(first.synchronized, true);
    assert.equal(uploaded?.mode, "full");
    assert.equal(uploaded?.workspaceHash, (await snapshotWorkspace(root)).hash);
    assert.deepEqual(commands, ["stop-services", "start-services"]);
    assert.equal(second.synchronized, false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test("reports live sync progress for the preview toolbar", async (context) => {
  const root = await workspaceFixture();
  try {
    context.mock.method(
      globalThis,
      "fetch",
      async () => new Response(null, { status: 200 }),
    );
    const service = new WorkspaceSyncService();
    const metadata = await service.prepareInitial(root);
    const session = runningSession(metadata.workspaceHash);
    let uploaded: { workspaceHash?: string } | undefined;
    let failGet = false;
    const client = {
      async negotiateSource() {
        return { unchanged: true, session };
      },
      async get() {
        if (failGet) throw new Error("Cloud preview is unreachable");
        return session;
      },
      async prepareSourceUpload(_sessionId: string, artifact: typeof uploaded) {
        uploaded = artifact;
        return uploadTarget();
      },
      async applySourceUpload() {
        session.workspaceHash = uploaded!.workspaceHash!;
        return session;
      },
    } as unknown as CloudPreviewClient;
    await service.syncInitial(client, session.id, root);
    await writeFile(join(root, "index.js"), "console.log('live')\n");

    await service.syncLive(client, session.id, root);
    let status = service.liveStatus(session.id);
    assert.equal(status?.state, "synced");
    assert.equal(status?.changedFiles, 1);
    assert.equal(status?.sequence, 1);
    assert.ok(status?.syncedAt);

    session.state.sync = "pending_local_sync";
    await service.syncLive(client, session.id, root);
    status = service.liveStatus(session.id);
    assert.equal(status?.state, "waiting");
    assert.match(status?.reason ?? "", /changes made in the cloud preview/);
    assert.equal(status?.sequence, 1);

    failGet = true;
    await assert.rejects(service.syncLive(client, session.id, root));
    assert.equal(service.liveStatus(session.id)?.state, "error");
    assert.equal(
      service.liveStatus(session.id)?.reason,
      "Cloud preview is unreachable",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function workspaceFixture() {
  const root = await mkdtemp(join(tmpdir(), "blame-workspace-live-sync-"));
  await execFileAsync("git", ["-C", root, "init", "--quiet"]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "Blame"]);
  await execFileAsync("git", [
    "-C",
    root,
    "config",
    "user.email",
    "preview@blame.local",
  ]);
  await writeFile(join(root, "package.json"), '{"name":"fixture"}\n');
  await writeFile(join(root, "index.js"), "console.log('base')\n");
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", [
    "-C",
    root,
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ]);
  return root;
}

function runningSession(workspaceHash: string) {
  return {
    id: "preview_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    desired: { host: "active", services: "running" },
    state: {
      host: "running",
      engine: "running",
      preview: "ready",
      agent: "idle",
      sync: "clean",
    },
    selection: {
      configurationId: "compose",
      serviceIds: ["app"],
    },
    workspaceHash,
  } as PreviewSessionView;
}

function uploadTarget() {
  return {
    artifactId: "artifact-live",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    headers: {},
    url: "https://storage.example/artifact",
  };
}
