import assert from "node:assert/strict";
import test from "node:test";
import {
  checkHostDependencies,
  parseNodeMajorVersion,
  requiresBareCommand,
  requiresNodeTooling,
} from "./host-dependencies.ts";

test("parses node major versions", () => {
  assert.equal(parseNodeMajorVersion("v22.12.0"), 22);
  assert.equal(parseNodeMajorVersion("24.14.1"), 24);
  assert.equal(parseNodeMajorVersion("not-a-version"), null);
});

test("detects node tooling only when setup script needs it", () => {
  assert.equal(requiresNodeTooling("echo node_modules"), false);
  assert.equal(requiresNodeTooling("# pnpm install\necho ready"), false);
  assert.equal(requiresNodeTooling("corepack pnpm install"), true);
  assert.equal(requiresNodeTooling("npm install"), true);
});

test("detects bare package managers without matching corepack shims", () => {
  assert.equal(requiresBareCommand("corepack pnpm install", "pnpm"), false);
  assert.equal(requiresBareCommand("pnpm create vite", "pnpm"), true);
  assert.equal(requiresBareCommand("corepack yarn install", "yarn"), false);
  assert.equal(requiresBareCommand("yarn create vite", "yarn"), true);
});

test("passes when required host dependencies are available", async () => {
  const calls: string[] = [];
  const report = await checkHostDependencies(
    { platform: "linux", setupScript: "echo ready" },
    async (command, args) => {
      calls.push([command, ...args].join(" "));
      return "ok";
    },
  );

  assert.equal(report.ok, true);
  assert.deepEqual(report.issues, []);
  assert.equal(calls.includes("node --version"), false);
});

test("keeps cloud worktrees native on Linux, macOS, and Windows", async () => {
  for (const platform of ["linux", "darwin", "win32"] as const) {
    const calls: string[] = [];
    const report = await checkHostDependencies(
      {
        platform,
        runtimeProfile: "vercel-compose",
        setupScript: "corepack pnpm install",
      },
      async (command, args) => {
        calls.push([command, ...args].join(" "));
        if (command === "node") return "v22.12.0";
        return "ok";
      },
    );

    assert.equal(report.ok, true, platform);
    assert.equal(
      calls.some((call) =>
        /blame-lima-runtime|blame-wsl2-runtime|nerdctl|docker/.test(call),
      ),
      false,
      platform,
    );
    assert.equal(calls.includes("git --version"), true, platform);
  }
});

test("reports missing git before setup execution", async () => {
  const report = await checkHostDependencies(
    { platform: "darwin", setupScript: "echo ready" },
    async (command) => {
      if (command === "git") throw new Error("missing");
      return "ok";
    },
  );

  assert.equal(report.ok, false);
  assert.equal(report.issues[0]?.name, "git");
  assert.match(report.issues[0]?.action ?? "", /Xcode|brew/);
});

test("reports unavailable Blame runtime on Windows", async () => {
  const report = await checkHostDependencies(
    { platform: "win32", setupScript: "echo ready" },
    async (command) => {
      if (command === "blame-wsl2-runtime") throw new Error("unavailable");
      return "ok";
    },
  );

  assert.equal(report.ok, false);
  assert.equal(report.issues[0]?.name, "blame-runtime");
  assert.equal(report.issues[0]?.status, "unavailable");
  assert.match(report.issues[0]?.action ?? "", /Blame WSL2 Runtime/);
});

test("uses actionable WSL2 runtime messages from managed status", async () => {
  const report = await checkHostDependencies(
    { platform: "win32", setupScript: "echo ready" },
    async (_command, args) => {
      if (args[0] !== "status") return "ok";
      return JSON.stringify({
        status: "unsupported",
        checks: [
          {
            action: "Enable WSL2, then run Blame runtime setup again.",
            name: "wsl",
            status: "unsupported",
          },
        ],
      });
    },
  );

  assert.equal(report.ok, false);
  assert.equal(report.issues[0]?.name, "blame-runtime");
  assert.match(report.issues[0]?.action ?? "", /Enable WSL2/);
});

test("does not cascade runtime checks when nerdctl is missing", async () => {
  const report = await checkHostDependencies(
    { platform: "linux", setupScript: "echo ready" },
    async (command) => {
      if (command === "nerdctl") throw new Error("nerdctl missing");
      return "ok";
    },
  );

  assert.equal(report.ok, false);
  assert.deepEqual(
    report.issues.map((issue) => issue.name),
    ["nerdctl"],
  );
});

test("reports missing nerdctl compose support", async () => {
  const report = await checkHostDependencies(
    { platform: "linux", setupScript: "echo ready" },
    async (command, args) => {
      if (command === "nerdctl" && args.join(" ") === "compose version") {
        throw new Error("compose missing");
      }
      return "ok";
    },
  );

  assert.equal(report.ok, false);
  assert.equal(report.issues[0]?.name, "nerdctl-compose");
  assert.match(report.issues[0]?.action ?? "", /Blame Native Runtime/);
});

test("reports containerd when nerdctl is installed but cannot connect", async () => {
  const report = await checkHostDependencies(
    { platform: "linux", setupScript: "echo ready" },
    async (command, args) => {
      if (command === "nerdctl" && args[0] === "info") {
        throw new Error("containerd socket unavailable");
      }
      return "ok";
    },
  );

  assert.equal(report.ok, false);
  assert.equal(report.issues[0]?.name, "containerd");
  assert.equal(report.issues[0]?.status, "unavailable");
});

test("does not require ctr access when nerdctl can connect", async () => {
  const report = await checkHostDependencies(
    { platform: "linux", setupScript: "echo ready" },
    async (command) => {
      if (command === "ctr") throw new Error("system containerd unavailable");
      return "ok";
    },
  );

  assert.equal(report.ok, true);
  assert.deepEqual(report.issues, []);
});

test("reports inaccessible containerd socket from nerdctl", async () => {
  const report = await checkHostDependencies(
    { platform: "linux", setupScript: "echo ready" },
    async (command, args) => {
      if (command === "nerdctl" && args[0] === "info") {
        throw {
          stderr:
            "transport: Error while dialing: dial unix /run/containerd/containerd.sock: connect: permission denied",
        };
      }
      return "ok";
    },
  );

  assert.equal(report.ok, false);
  assert.equal(report.issues[0]?.name, "containerd");
  assert.match(report.issues[0]?.message ?? "", /cannot access its socket/);
  assert.match(report.issues[0]?.action ?? "", /containerd-rootless/);
});

test("reports rootless containerd not running", async () => {
  const report = await checkHostDependencies(
    { platform: "linux", setupScript: "echo ready" },
    async (command, args) => {
      if (command === "nerdctl" && args[0] === "info") {
        throw {
          stderr:
            "rootless containerd not running? stat /run/user/1000/containerd-rootless: no such file or directory",
        };
      }
      return "ok";
    },
  );

  assert.equal(report.ok, false);
  assert.equal(report.issues[0]?.name, "containerd");
  assert.match(report.issues[0]?.message ?? "", /Rootless containerd/);
  assert.match(report.issues[0]?.action ?? "", /containerd-rootless/);
});

test("checks node and corepack when setup script needs package tooling", async () => {
  const calls: string[] = [];
  const report = await checkHostDependencies(
    { platform: "linux", setupScript: "pnpm install" },
    async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (command === "node") return "v22.12.0";
      return "ok";
    },
  );

  assert.equal(report.ok, true);
  assert.equal(calls.includes("node --version"), true);
  assert.equal(calls.includes("corepack --version"), true);
});

test("checks bare project creation package managers", async () => {
  const calls: string[] = [];
  const report = await checkHostDependencies(
    {
      platform: "linux",
      setupScript: "pnpm create vite\ncorepack pnpm install",
    },
    async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (command === "node") return "v22.12.0";
      return "ok";
    },
  );

  assert.equal(report.ok, true);
  assert.equal(calls.includes("pnpm --version"), true);
  assert.equal(calls.includes("corepack --version"), true);
});

test("reports unsupported node versions", async () => {
  const report = await checkHostDependencies(
    { platform: "linux", setupScript: "npm install" },
    async (command) => {
      if (command === "node") return "v20.18.1";
      return "ok";
    },
  );

  assert.equal(report.ok, false);
  assert.equal(report.issues[0]?.name, "node");
  assert.equal(report.issues[0]?.status, "unsupported");
});

test("skips the container runtime for work that runs on this machine", async () => {
  for (const platform of ["linux", "darwin", "win32"] as const) {
    const calls: string[] = [];
    const report = await checkHostDependencies(
      { includeRuntime: false, platform, setupScript: "echo ready" },
      async (command, args) => {
        calls.push([command, ...args].join(" "));
        return "ok";
      },
    );

    assert.equal(report.ok, true, platform);
    assert.equal(
      calls.some((call) =>
        /blame-lima-runtime|blame-wsl2-runtime|nerdctl|docker/.test(call),
      ),
      false,
      platform,
    );
    assert.equal(calls.includes("git --version"), true, platform);
  }
});
