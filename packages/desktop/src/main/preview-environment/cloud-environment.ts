import { posix } from "node:path";
import type { PreviewEnvironmentSecrets } from "@blame/preview-runtime";
import { materializePreviewEnvValues } from "../workspace-env.ts";
import { readLocalDatabaseMode } from "../preview-runtime/local/local-preview-files.ts";
import { localPreviewContext } from "../preview-runtime/local/local-preview-runner.ts";
import { runtimeEnvFileName } from "./dotenv.ts";
import { worktreeEnvDeclarations } from "./env-declarations.ts";
import { resolveWorktreeEnvironment } from "./worktree-environment.ts";

// What a cloud preview gets from this computer: the variables a local
// preview of the story would have, by Compose service, and its env files
// with the stronger values written in. The code upload leaves env files out,
// so this travels with the session request, which the API keeps encrypted.
// The cloud origin is only known once the sandbox runs, and a database on
// this computer is out of a sandbox's reach, so neither is rewritten here.

export async function cloudPreviewEnvironment(
  worktree: string,
): Promise<PreviewEnvironmentSecrets> {
  const context = await localPreviewContext(worktree);
  const databaseMode = await readLocalDatabaseMode(worktree);
  const environment = await resolveWorktreeEnvironment({
    worktree,
    plan: context.plan,
    bindings: {},
    databaseMode,
    declarations: await worktreeEnvDeclarations(worktree),
  });
  const { resolved } = environment;
  const variables = Object.fromEntries(
    resolved.items.map((item) => [
      item.kind === "setup" ? `setup-${item.id}` : item.id,
      item.environment,
    ]),
  );
  const files = environment.files
    .filter(({ path }) => runtimeEnvFileName(path.split("/").at(-1)!))
    .map(({ path, content }) => ({
      path,
      content: materializePreviewEnvValues(
        content,
        undefined,
        resolved.fileValues[posix.dirname(path)] ?? {},
        {},
        { mode: environment.databaseMode },
      ),
    }));
  return { variables, files };
}
