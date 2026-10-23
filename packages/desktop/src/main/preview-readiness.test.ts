import assert from "node:assert/strict";
import test from "node:test";
import {
  containerMatchesWorktree,
  previewComposeProjectName,
  previewContainerFailure,
  previewFailureLogExcerpt,
} from "./preview-readiness.ts";

test("discovers nerdctl containers using the same project identity as compose", () => {
  const worktree =
    "/home/blame/.local/share/blame/runtime/worktrees/JuliettePortfolio/story-US-006-untitled-user-story";
  const container = {
    Config: {
      Labels: {
        "com.docker.compose.project": "blame_5bb04a7d0a8c",
        "com.docker.compose.service": "web",
      },
    },
  };
  assert.equal(previewComposeProjectName(worktree), "blame_5bb04a7d0a8c");
  assert.equal(containerMatchesWorktree(container, worktree), true);
  assert.equal(containerMatchesWorktree(container, `${worktree}-other`), false);
  assert.equal(containerMatchesWorktree({}, worktree), false);
  assert.equal(containerMatchesWorktree({}, ""), false);
});

test("keeps Docker path labels working without matching sibling worktrees", () => {
  const byDirectory = {
    Config: {
      Labels: {
        "com.docker.compose.project.working_dir": "C:\\work\\story\\",
      },
    },
  };
  const byConfig = {
    Config: {
      Labels: {
        "com.docker.compose.project.config_files":
          "/work/story/.blame/docker-compose.yml",
      },
    },
  };
  assert.equal(containerMatchesWorktree(byDirectory, "C:/work/story"), true);
  assert.equal(containerMatchesWorktree(byConfig, "/work/story/"), true);
  assert.equal(containerMatchesWorktree(byConfig, "/work/sto"), false);
});

test("allows container discovery during the startup grace period", () => {
  assert.equal(
    previewContainerFailure({
      discoveryGraceMs: 15_000,
      elapsedMs: 5_000,
      found: false,
    }),
    undefined,
  );
});

test("fails missing containers after the startup grace period", () => {
  assert.equal(
    previewContainerFailure({
      discoveryGraceMs: 15_000,
      elapsedMs: 15_000,
      found: false,
    }),
    "preview_container_missing",
  );
});

test("fails terminal and unhealthy container states", () => {
  assert.equal(
    previewContainerFailure({
      discoveryGraceMs: 15_000,
      elapsedMs: 1_000,
      found: true,
      health: "unhealthy",
      status: "running",
    }),
    "preview_container_stopped",
  );
});

test("summarizes why a preview container stopped", () => {
  const logs = [
    "web-1 |Preparing pnpm@10.32.1 for immediate activation...",
    "web-1 |",
    "web-1 |> portfolio-v4@0.1.0 dev /workspace",
    "web-1 |> node scripts/dev.mjs --webpack",
    "web-1 | ELIFECYCLE  Command failed with exit code 1.",
    "web-1 |[dev] Docker is not running. Start it, then run `pnpm dev` again.",
  ].join("\n");
  assert.equal(
    previewFailureLogExcerpt(logs),
    "[dev] Docker is not running. Start it, then run `pnpm dev` again.",
  );
  assert.equal(previewFailureLogExcerpt(""), "");
  assert.equal(previewFailureLogExcerpt("a\nb\nc\nd", 2), "c d");
});
