import assert from "node:assert/strict";
import test from "node:test";
import {
  containerRuntimeEnvironment,
  parseInspectOutput,
  runtimeAgentFallbackAllowed,
  runtimeCommand,
  runtimeCommandWithContext,
  runtimeName,
} from "./container-runtime.ts";

test("routes Linux runtime commands to native Docker", () => {
  assert.deepEqual(runtimeCommand("linux", "compose", ["ps"]), {
    command: "docker",
    args: ["compose", "ps"],
  });
});

test("routes macOS runtime commands through Blame Lima Runtime", () => {
  assert.deepEqual(runtimeCommand("darwin", "volume", ["ls"]), {
    command: "blame-lima-runtime",
    args: ["volume", "ls"],
  });
});

test("routes Windows runtime commands through Blame WSL2 Runtime", () => {
  assert.deepEqual(runtimeCommand("win32", "network", ["ls"]), {
    command: "blame-wsl2-runtime",
    args: ["network", "ls"],
  });
});

test("routes Windows compose commands through Blame WSL2 Runtime", () => {
  assert.deepEqual(runtimeCommand("win32", "compose", ["ps"]), {
    command: "blame-wsl2-runtime",
    args: ["compose", "ps"],
  });
});

test("names the container runtime of the platform", () => {
  const environment = containerRuntimeEnvironment({});

  assert.equal(
    environment.BLAME_CONTAINER_RUNTIME,
    runtimeName(process.platform),
  );
});

test("parses inspect arrays and single objects", () => {
  assert.deepEqual(parseInspectOutput<{ Id: string }>('[{"Id":"one"}]'), [
    { Id: "one" },
  ]);
  assert.deepEqual(parseInspectOutput<{ Id: string }>('{"Id":"one"}'), [
    { Id: "one" },
  ]);
});

test("never falls back by replaying mutating runtime commands", () => {
  assert.equal(
    runtimeAgentFallbackAllowed("compose", [
      "-f",
      "/workspace/compose.yml",
      "--project-directory",
      "/workspace",
      "up",
      "-d",
      "db",
    ]),
    false,
  );
  assert.equal(
    runtimeAgentFallbackAllowed("container", ["run", "node"]),
    false,
  );
  assert.equal(
    runtimeAgentFallbackAllowed("volume", ["create", "cache"]),
    false,
  );
  assert.equal(
    runtimeAgentFallbackAllowed("compose", [
      "-f",
      "/workspace/compose.yml",
      "config",
    ]),
    true,
  );
  assert.equal(runtimeAgentFallbackAllowed("inspect", ["container-id"]), true);
});

test("preserves compose identity and workspace paths in Lima fallback commands", () => {
  const command = runtimeCommandWithContext("darwin", "compose", ["ps"], {
    cwd: "/workspace/story",
    env: {
      BLAME_PROJECT_ROOT: "/workspace/story",
      COMPOSE_PROJECT_NAME: "blame_story",
      PATH: "/host/path-that-must-not-cross-the-runtime-boundary",
      SECRET_TOKEN: "secret",
    },
  });
  const shellCommand = command.args[2] ?? "";

  assert.match(shellCommand, /COMPOSE_PROJECT_NAME=blame_story/);
  assert.match(shellCommand, /BLAME_PROJECT_ROOT=\/workspace\/story/);
  assert.doesNotMatch(shellCommand, /host\/path/);
  assert.doesNotMatch(shellCommand, /SECRET_TOKEN/);
});

test("uses Docker inside the guest for root-level Lima fallback commands", () => {
  const command = runtimeCommandWithContext("darwin", "inspect", ["db"], {
    env: {},
  });

  assert.equal(command.command, "blame-lima-runtime");
  assert.match(command.args[2] ?? "", /exec docker 'inspect' 'db'/);
});
