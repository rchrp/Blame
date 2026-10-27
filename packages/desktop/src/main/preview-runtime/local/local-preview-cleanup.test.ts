import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import type { DockerHost } from "@blame/preview-runtime/compose";
import { removePreviewProject } from "./local-preview-cleanup.ts";

// Execute the actual POSIX cleanup script, as the Linux runtime does, with
// a fake Docker command. A later successful command must not hide a failure.
for (const failingStage of [
  "",
  "ps",
  "rm",
  "network ls",
  "network rm",
  "volume ls",
  "volume rm",
]) {
  test(
    `preview removal reports ${failingStage || "no"} Docker failure`,
    { skip: process.platform === "win32" },
    async () => {
      const host: DockerHost = {
        readFile: async () => undefined,
        writeFile: async () => undefined,
        async run(command, args) {
          assert.equal(command, "sh");
          const fixture = `
docker() {
  stage="$1"
  case "$1" in network|volume) stage="$1 $2" ;; esac
  [ "$stage" != "$FAILED_STAGE" ] || { echo 'fixture Docker failure' >&2; return 7; }
  case "$stage" in
    ps) echo container-id ;;
    'network ls') echo network-id ;;
    'volume ls') echo blame_0123456789ab_db ;;
  esac
}
`;
          try {
            const output = await promisify(execFile)(
              "sh",
              ["-c", fixture + args[1], ...args.slice(2)],
              {
                env: { ...process.env, FAILED_STAGE: failingStage },
              },
            );
            return { ...output, exitCode: 0 };
          } catch (error) {
            const result = error as Error & {
              code: number;
              stdout: string;
              stderr: string;
            };
            assert.equal(result.code, 7);
            return {
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.code,
            };
          }
        },
      };
      assert.equal(
        await removePreviewProject("blame_0123456789ab", host),
        !failingStage,
      );
    },
  );
}
