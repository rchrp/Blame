// Where the harness runner is, for the engine (`--harness-command`) and the
// packaged app's run_task smoke test. It imports nothing: the main process
// loads it.
import { fileURLToPath } from "node:url";

export function harnessRunnerPath() {
  return fileURLToPath(
    new URL("./semantic-harness-runner.js", import.meta.url),
  );
}
