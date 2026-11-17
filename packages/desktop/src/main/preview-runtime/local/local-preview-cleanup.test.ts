import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { DockerHost } from "@blame/preview-runtime/compose";
import {
  collectPreviewGarbage,
  removePreviewProject,
} from "./local-preview-cleanup.ts";

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

test(
  "compile cache snapshots go with the last node_modules volume of their key",
  { skip: process.platform === "win32" },
  async () => {
    const removed: string[] = [];
    const host: DockerHost = {
      readFile: async () => undefined,
      writeFile: async () => undefined,
      async run(_command, args) {
        const fixture = `
docker() {
  case "$1 $2" in
    'volume ls')
      case "$*" in
        *name=blame_compile_cache_*) printf 'blame_compile_cache_aaa\\nblame_compile_cache_bbb\\n' ;;
        *name=blame_node_modules_aaa*) echo blame_node_modules_aaa_apps_web ;;
      esac ;;
    'volume rm') echo "$3" >> "$REMOVED_LOG" ;;
  esac
}
`;
        const log = join(await mkdtemp(join(tmpdir(), "blame-gc-")), "log");
        const { stdout, stderr } = await promisify(execFile)(
          "sh",
          ["-c", fixture + args[1], ...args.slice(2)],
          { env: { ...process.env, REMOVED_LOG: log } },
        );
        removed.push(
          ...(await readFile(log, "utf8").catch(() => ""))
            .split("\n")
            .filter(Boolean),
        );
        return { stdout, stderr, exitCode: 0 };
      },
    };
    await collectPreviewGarbage(["/nonexistent-blame-root"], host);
    assert.deepEqual(removed, ["blame_compile_cache_bbb"]);
  },
);
