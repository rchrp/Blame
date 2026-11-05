import { pLimit } from "../../concurrency.ts";

// A dependency install is the heaviest step of a preview start: two at once
// can exhaust Blame Runtime's memory and get a process killed. Previews take
// turns instead.
const installs = pLimit(1);
let pending = 0;

/** Runs a preview's dependency install once no other one is running. */
export async function queueDependencyInstall<T>(
  install: () => Promise<T>,
  onWait?: () => void,
) {
  if (pending > 0) onWait?.();
  pending += 1;
  try {
    return await installs(install);
  } finally {
    pending -= 1;
  }
}
