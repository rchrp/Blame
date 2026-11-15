import type { PreviewExecutionPlan } from "@blame/preview-runtime";
import {
  dependencyTuning,
  dependencyTuningLabel,
  type DockerHost,
} from "@blame/preview-runtime/compose";

// Development settings for heavy dependency images (see the renderer's
// dependency-tuning.ts) go to new containers only. Changing an existing
// database container's command recreates it, and the engine then reruns
// the setup tasks that migrated and seeded it, against the data its volume
// kept: a seed that is not idempotent would fail the start. So a container
// created without the settings keeps running without them until it is
// removed, for example with the story's worktree.

export async function tunedDependencies(
  host: DockerHost,
  projectName: string,
  plan: PreviewExecutionPlan,
): Promise<string[]> {
  const candidates = plan.services
    .filter((service) => dependencyTuning(service))
    .map(({ id }) => id);
  if (!candidates.length) return [];
  const result = await host
    .run(
      "docker",
      [
        "ps",
        "--all",
        "--filter",
        `label=com.docker.compose.project=${projectName}`,
        "--format",
        `{{.Label "com.docker.compose.service"}}\t{{.Label "${dependencyTuningLabel}"}}`,
      ],
      { timeoutMs: 15_000 },
    )
    .catch(() => undefined);
  // Unknown containers: keep whatever they run with.
  if (!result || result.exitCode !== 0) return [];
  const existing = new Map(
    result.stdout
      .split("\n")
      .map((line) => line.split("\t"))
      .filter(([service]) => Boolean(service))
      .map(([service, label]) => [service!, Boolean(label)]),
  );
  return candidates.filter((id) => existing.get(id) ?? true);
}
