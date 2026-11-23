import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const engine = new URL("../../../agent-runtime/dist/engine/", import.meta.url);
const binary = fileURLToPath(new URL("../../../../target/debug/blame-engine", import.meta.url));

async function withScript(action) {
  const { EngineHost } = await import(new URL("host.js", engine));
  const { MockModel, FakeApi, testModel, testHarnessCommand, testHarnessEnvironment, tools } = await import(new URL("testing.js", engine));
  const dataDir = await mkdtemp(join(tmpdir(), "blame-preview-engine-"));
  const scripted = await MockModel.start([]);
  const api = await FakeApi.start();
  api.modelBase = scripted.base;
  const host = new EngineHost({
    binary: process.env.BLAME_ENGINE_BIN ?? binary,
    dataDir,
    harnessCommand: testHarnessCommand(),
    clientVersion: "preview-campaign",
    env: { ...process.env, ...testHarnessEnvironment(), BLAME_ENGINE_LOG: "warn" },
    emit() {},
  });
  try {
    await host.call("connect", { api: api.connection() });
    return await action(host, scripted, { providerId: "anthropic", modelId: testModel }, tools);
  } finally {
    await host.shutdown();
    await Promise.all([api.close(), scripted.close(), rm(dataDir, { recursive: true, force: true })]);
  }
}

export function initializeFixture(root, fixture) {
  return withScript(async (host, scripted, model, tools) => {
    const submission = tools({
      name: "submit_project_initialization",
      input: { previewManifest: fixture.manifest, runConfigurations: fixture.runConfigurations, cloudPreviewIgnore: [] },
    });
    scripted.script(tools({ name: "read_code", input: { target: fixture.initializationFile } }), submission, submission);
    return host.call("initializeProject", { task: `preview-${randomUUID()}`, model, workspace: { root } });
  });
}

/** Only the real engine/harness can write this file. The model returns a tool call. */
export async function editFixture(root, edit, { projectId, storyId, title }) {
  const path = join(root, edit.file);
  const original = await readFile(path, "utf8");
  const line = original.split("\n").find((line) => line.includes(edit.from));
  if (!line) throw new Error(`Could not find the expected text in ${edit.file}`);
  const replacement = line.replace(edit.from, edit.to);
  const patch = `*** Begin Patch\n*** Update File: ${edit.file}\n@@\n-${line}\n+${replacement}\n*** End Patch`;
  return withScript(async (host, scripted, model, tools) => {
    const session = randomUUID();
    scripted.script(
      tools({ name: "read_code", input: { target: edit.file } }),
      tools({ name: "edit_code", input: { operations: [{ kind: "patch", path: edit.file, patch }] } }),
      tools({ name: "finish_task", input: { summary: "Updated the preview banner." } }),
    );
    await host.call("createSession", {
      session,
      purpose: "development-story",
      settings: { workspace: { root, location: "host" }, workspaceMode: "cloud-mirror", projectId, storyId, title, model },
    });
    const turn = await host.call("send", { session, delivery: "turn", message: { text: "Update the preview banner." } });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const [status] = await host.call("status", { sessions: [session] });
      const ended = status?.endedTurns?.find((row) => row.turn === turn.turn);
      if (ended) {
        if (ended.outcome.status !== "completed" || (await readFile(path, "utf8")) !== original.replace(line, replacement)) {
          throw new Error(`The agent did not make the expected edit (${JSON.stringify(ended.outcome)}, ${scripted.requests.length} model requests)`);
        }
        return;
      }
      await delay(250);
    }
    throw new Error("The agent did not finish the edit in 30 seconds");
  });
}
