import type { PreviewExecutionPlan } from "../domain/execution-plan.js";

// A cloud sandbox gets 2 GB of memory per vCPU and its memory is billed for
// as long as it runs, while CPU time is billed only when used. The smallest
// size that runs the plan comfortably saves the most:
// - 1 vCPU, 2 GB: one light app without a database, screen or heavy dev
//   server;
// - 4 vCPU, 8 GB: a screen preview with a backend (Chromium, X and a dev
//   server), or five services or more;
// - 2 vCPU, 4 GB otherwise.

export type PreviewResourceSize = { vcpus: number; memoryGb: number };

const heavyDevServer =
  /\b(?:next|nuxt|nuxi|gatsby|ng\s+serve|angular|remix|astro|turbo)\b/;

export function previewResourceSize(
  plan: PreviewExecutionPlan,
): PreviewResourceSize {
  const services = plan.services.filter(
    (service) =>
      !(
        service.surface?.type === "display" &&
        service.surface.sidecarServiceId === service.id
      ),
  );
  const apps = services.filter(({ kind }) => kind !== "dependency");
  const dependencies = services.length - apps.length;
  const display = apps.some(({ surface }) => surface?.type === "display");
  if ((display && apps.length > 1) || services.length >= 5) return size(4);
  if (
    apps.length <= 1 &&
    dependencies === 0 &&
    !display &&
    !apps.some(({ command }) => heavyDevServer.test(command ?? ""))
  )
    return size(1);
  return size(2);
}

function size(vcpus: number): PreviewResourceSize {
  return { vcpus, memoryGb: vcpus * 2 };
}
