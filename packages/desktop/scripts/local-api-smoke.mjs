// Starts the local API the way the desktop app does: in an Electron utility
// process, with its key in the system keychain. Reports how long it takes.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, safeStorage } from "electron";
import { LocalApiService } from "../src/main/local-api/local-api-service.ts";

const timeout = setTimeout(() => {
  console.error("Local API smoke timed out");
  app.exit(1);
}, 90_000);
app.setName("Blame Local API Smoke");
const home = await mkdtemp(join(tmpdir(), "blame-local-api-smoke-"));
app.setPath("userData", home);

void app.whenReady().then(async () => {
  const service = new LocalApiService({
    modulePath: fileURLToPath(import.meta.resolve("@blame/api/local")),
    dataDirectory: join(home, "local-api"),
    secrets: safeStorage,
  });
  try {
    const firstStart = performance.now();
    const first = await service.session();
    const firstStartMs = performance.now() - firstStart;
    const project = await request(first, "/projects", {
      method: "POST",
      body: { name: "Smoke", repositoryFingerprint: "smoke" },
    });
    await request(first, "/projects/user-stories", {
      method: "POST",
      body: {
        projectId: project.data.id,
        title: "First story",
        summary: "Works offline",
      },
    });
    const billing = await fetch(`${first.url}/billing`, {
      headers: auth(first),
    });
    assert.equal(billing.status, 403);
    assert.equal((await billing.json()).code, "ACCOUNT_REQUIRED");

    await service.shutdown();
    const nextStart = performance.now();
    const second = await service.session();
    const nextStartMs = performance.now() - nextStart;
    assert.notEqual(second.token, first.token);
    const workspace = await request(second, "/account/workspace");
    assert.equal(workspace.data.tables.user_stories.length, 1);
    const revoked = await fetch(`${second.url}/account/profile`, {
      headers: auth(first),
    });
    assert.equal(revoked.status, 401);

    console.log(
      `Local API smoke passed: first start ${Math.round(firstStartMs)} ms, next start ${Math.round(nextStartMs)} ms`,
    );
    await service.shutdown();
    clearTimeout(timeout);
    await rm(home, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    console.error(error);
    await service.shutdown();
    app.exit(1);
  }
});

function auth(session) {
  return {
    Authorization: `Bearer ${session.token}`,
    "Content-Type": "application/json",
  };
}

async function request(session, path, init = {}) {
  const response = await fetch(`${session.url}${path}`, {
    method: init.method ?? "GET",
    headers: auth(session),
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  assert.ok(response.ok, `${path} answered ${response.status}`);
  return response.json();
}
