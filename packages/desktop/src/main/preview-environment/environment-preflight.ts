import { previewDatabaseEnvironmentKey } from "./database-environment.ts";
import type { WorktreeEnvironment } from "./worktree-environment.ts";

// Before any container starts: a key the code requires at startup that this
// preview does not set fails the start with a sentence a person can act on,
// instead of a container that crashes on it.

export function environmentPreflightFailure(
  environment: WorktreeEnvironment,
  serviceIds: string[],
) {
  const problems = environment.resolved.items
    .filter((item) => item.kind === "service" && serviceIds.includes(item.id))
    .flatMap((item) => {
      const missing = item.variables.filter(
        (variable) =>
          variable.required &&
          (variable.status === "missing" ||
            (variable.rejectsEmpty && variable.status === "empty")),
      );
      return missing.length ? [{ id: item.id, missing }] : [];
    });
  if (!problems.length) return undefined;
  const sentences = problems.map(({ id, missing }) => {
    const keys = missing.map(({ key }) => key);
    const named =
      keys.length === 1
        ? keys[0]
        : `${keys.slice(0, -1).join(", ")} and ${keys.at(-1)}`;
    const empty = missing.every(({ status }) => status === "empty");
    return `${id} needs ${named}; ${keys.length === 1 ? "it is" : "they are"} ${empty ? "empty" : "not set"} in this preview.`;
  });
  const database =
    environment.databaseMode === "existing" &&
    problems.some(({ missing }) =>
      missing.some(({ key }) => previewDatabaseEnvironmentKey(key)),
    );
  return `${sentences.join(" ")} Set ${problems.length > 1 || problems[0]!.missing.length > 1 ? "them" : "it"} in the Variables tab${database ? " or switch to an isolated database on the Preview Environment page" : ""}.`;
}
