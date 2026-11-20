import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LightToolResult } from "./light-contracts.js";

import { LightWorkspace } from "./test-client/light-workspace.js";

// The guidance tests' fixture: workspaces served by blame-harness through
// the test client.
export { LightWorkspace } from "./test-client/light-workspace.js";
export { LightFinishService } from "./test-client/light-finish-service.js";
export { observeCheck } from "./test-client/units.js";
export { localLightWorkspaceExecutor } from "./test-client/light-executor.js";

export async function fixture(files: Record<string, string>, run: (workspace: InstanceType<typeof LightWorkspace>, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "light-agent-guidance-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), content);
    }
    await run(new LightWorkspace(root, { sessionId: "guidance" }), root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
export function data(result: LightToolResult<unknown>): Record<string, any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(result.status, "ok", JSON.stringify(result));
  return (result as { data: Record<string, unknown> }).data;
}
export const source = "export function calculate(n: number) { return n + 1; }\n";
export const project = {
  "original.ts": source,
  "consumer.ts": 'import { calculate as compute } from "./original.js";\nexport { calculate as publicName } from "./original.js";\nexport const value = compute(1);\n',
  "package.json": '{"type":"module"}',
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", types: [] }, include: ["*.ts"] }),
};
