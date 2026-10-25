import assert from "node:assert/strict";
import test from "node:test";
import {
  createRuntimeManager,
  type RuntimeProgress,
} from "./runtime-manager.ts";

test("checks Linux runtime with native Docker probes", async () => {
  const calls: string[] = [];
  const manager = createRuntimeManager(
    { platform: "linux" },
    async (command, args) => {
      calls.push([command, ...args].join(" "));
      return "ok";
    },
  );

  const status = await manager.checkRuntimeDependencies();

  assert.equal(status.status, "ready");
  assert.deepEqual(status.issues, []);
  assert.deepEqual(calls, [
    "docker --version",
    "docker info",
    "docker compose version",
  ]);
});

test("uses passive managed runtime status checks", async () => {
  const calls: string[] = [];
  const manager = createRuntimeManager(
    { platform: "darwin" },
    async (command, args) => {
      calls.push([command, ...args].join(" "));
      return "ready";
    },
  );

  const status = await manager.checkRuntimeDependencies();

  assert.equal(status.status, "ready");
  assert.deepEqual(calls, [
    "blame-lima-runtime --version",
    "blame-lima-runtime status",
    "blame-lima-runtime agent status",
  ]);
  assert.equal(
    calls.some((call) => call.includes(" true")),
    false,
  );
});

test("requires the managed runtime agent to execute", async () => {
  const manager = createRuntimeManager(
    { platform: "win32" },
    async (_command, args) => {
      if (args[0] === "agent")
        throw new Error("blame-runtime-agent: command not found");
      return "ready";
    },
  );

  const status = await manager.checkRuntimeDependencies();

  assert.equal(status.status, "missing");
  assert.equal(status.issues[0]?.name, "blame-runtime");
  assert.equal(status.issues[0]?.status, "missing");
  assert.match(status.issues[0]?.action ?? "", /Repair BlameRuntime/);
});

test("reports managed runtime binary failures as missing", async () => {
  const manager = createRuntimeManager({ platform: "win32" }, async () => {
    throw new Error("missing runtime");
  });

  const status = await manager.checkRuntimeDependencies();

  assert.equal(status.status, "missing");
  assert.equal(status.issues[0]?.name, "blame-runtime");
  assert.equal(status.issues[0]?.status, "missing");
});

test("preserves managed runtime status output", async () => {
  const manager = createRuntimeManager(
    { platform: "darwin" },
    async (_command, args) => {
      return args[0] === "status" ? "repairable" : "ok";
    },
  );

  const status = await manager.checkRuntimeDependencies();

  assert.equal(status.status, "repairable");
  assert.equal(status.issues[0]?.name, "blame-runtime");
  assert.equal(status.issues[0]?.status, "unavailable");
});

test("uses managed runtime status checks from JSON output", async () => {
  const manager = createRuntimeManager(
    { platform: "win32" },
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

  const status = await manager.checkRuntimeDependencies();

  assert.equal(status.status, "unsupported");
  assert.equal(status.issues[0]?.name, "blame-runtime");
  assert.equal(status.issues[0]?.status, "unsupported");
  assert.match(status.issues[0]?.action ?? "", /Enable WSL2/);
});

test("reports missing managed runtime Git as repairable", async () => {
  const manager = createRuntimeManager(
    { platform: "win32" },
    async (_command, args) => {
      if (args[0] !== "status") return "ok";
      return JSON.stringify({
        status: "repairable",
        checks: [
          { name: "wsl", status: "available" },
          { name: "distro", status: "available" },
          { name: "git", status: "missing" },
        ],
      });
    },
  );

  const status = await manager.checkRuntimeDependencies();

  assert.equal(status.status, "repairable");
  assert.equal(status.issues[0]?.name, "git");
  assert.equal(status.issues[0]?.status, "missing");
});

test("reports missing Windows runtime Cline SDK as repairable", async () => {
  const manager = createRuntimeManager(
    { platform: "win32" },
    async (_command, args) => {
      if (args[0] !== "status") return "ok";
      return JSON.stringify({
        status: "repairable",
        checks: [
          { name: "wsl", status: "available" },
          { name: "distro", status: "available" },
          { name: "cline-sdk", status: "missing" },
        ],
      });
    },
  );

  const status = await manager.checkRuntimeDependencies();

  assert.equal(status.status, "repairable");
  assert.equal(status.issues[0]?.name, "cline-sdk");
  assert.equal(status.issues[0]?.status, "missing");
});

test("reports stale Windows runtime version as repairable runtime", async () => {
  const manager = createRuntimeManager(
    { platform: "win32" },
    async (_command, args) => {
      if (args[0] !== "status") return "ok";
      return JSON.stringify({
        status: "repairable",
        checks: [
          { name: "wsl", status: "available" },
          { name: "distro", status: "available" },
          {
            action: "Repair BlameRuntime from Blame runtime setup.",
            name: "runtime-version",
            status: "missing",
          },
        ],
      });
    },
  );

  const status = await manager.checkRuntimeDependencies();

  assert.equal(status.status, "repairable");
  assert.equal(status.issues[0]?.name, "blame-runtime");
  assert.equal(status.issues[0]?.status, "missing");
  assert.match(status.issues[0]?.action ?? "", /Repair BlameRuntime/);
});

test("reports stale Lima runtime version as repairable runtime", async () => {
  const manager = createRuntimeManager(
    { platform: "darwin" },
    async (_command, args) => {
      if (args[0] !== "status") return "ok";
      return JSON.stringify({
        status: "repairable",
        checks: [
          { name: "lima", status: "available" },
          { name: "vm", status: "available" },
          {
            action: "Repair BlameRuntime from Blame runtime setup.",
            name: "runtime-version",
            status: "missing",
          },
        ],
      });
    },
  );

  const status = await manager.checkRuntimeDependencies();

  assert.equal(status.status, "repairable");
  assert.equal(status.issues[0]?.name, "blame-runtime");
  assert.equal(status.issues[0]?.status, "missing");
  assert.match(status.issues[0]?.action ?? "", /Repair BlameRuntime/);
});

test("maps internal managed runtime checks to the Blame Runtime dependency", async () => {
  for (const name of [
    "agent-version",
    "semantic-harness",
    "package-managers",
  ]) {
    const manager = createRuntimeManager(
      { platform: "darwin" },
      async (_command, args) => {
        if (args[0] !== "status") return "ok";
        return JSON.stringify({
          status: "repairable",
          checks: [
            { name: "lima", status: "available" },
            {
              action: "Repair BlameRuntime from Blame runtime setup.",
              name,
              status: "missing",
            },
          ],
        });
      },
    );

    const status = await manager.checkRuntimeDependencies();

    assert.equal(status.status, "repairable", name);
    assert.equal(status.issues[0]?.name, "blame-runtime", name);
    assert.equal(status.issues[0]?.status, "missing", name);
    assert.match(status.issues[0]?.action ?? "", /Repair BlameRuntime/, name);
  }
});

test("reports missing bundled Lima as managed runtime missing", async () => {
  const manager = createRuntimeManager(
    { platform: "darwin" },
    async (_command, args) => {
      if (args[0] !== "status") return "ok";
      return JSON.stringify({
        status: "missing",
        checks: [
          {
            action:
              "Package bundled Lima resources with Blame, then run Blame runtime setup again.",
            name: "lima",
            status: "missing",
          },
        ],
      });
    },
  );

  const status = await manager.checkRuntimeDependencies();

  assert.equal(status.status, "missing");
  assert.equal(status.issues[0]?.name, "blame-runtime");
  assert.equal(status.issues[0]?.status, "missing");
  assert.match(status.issues[0]?.action ?? "", /bundled Lima/);
});

test("reports missing Blame Lima VM as managed runtime missing", async () => {
  const manager = createRuntimeManager(
    { platform: "darwin" },
    async (_command, args) => {
      if (args[0] !== "status") return "ok";
      return JSON.stringify({
        status: "missing",
        checks: [
          { name: "lima", status: "available" },
          {
            action:
              "Create or repair the BlameRuntime Lima VM from Blame runtime setup.",
            name: "vm",
            status: "missing",
          },
        ],
      });
    },
  );

  const status = await manager.checkRuntimeDependencies();

  assert.equal(status.status, "missing");
  assert.equal(status.issues[0]?.name, "blame-runtime");
  assert.equal(status.issues[0]?.status, "missing");
  assert.match(status.issues[0]?.action ?? "", /BlameRuntime Lima VM/);
});

test("distinguishes a stopped Blame Lima VM from a repair or update", async () => {
  const manager = createRuntimeManager(
    { platform: "darwin" },
    async (_command, args) => {
      if (args[0] !== "status") return "ok";
      return JSON.stringify({
        status: "repairable",
        checks: [
          { name: "lima", status: "available" },
          {
            action:
              "Create or repair the BlameRuntime Lima VM from Blame runtime setup.",
            name: "vm",
            status: "unavailable",
          },
        ],
      });
    },
  );

  const status = await manager.checkRuntimeDependencies();

  assert.equal(status.status, "repairable");
  assert.equal(status.issues[0]?.name, "blame-runtime");
  assert.equal(status.issues[0]?.status, "unavailable");
  assert.equal(status.startRequired, true);
  assert.equal(status.updateRequired, false);
});

test("reports missing Lima host mount as runtime repair action", async () => {
  const manager = createRuntimeManager(
    { platform: "darwin" },
    async (_command, args) => {
      if (args[0] !== "status") return "ok";
      return JSON.stringify({
        status: "repairable",
        checks: [
          { name: "lima", status: "available" },
          { name: "vm", status: "available" },
          {
            action:
              "Reset BlameRuntime from Blame runtime setup so macOS project folders are mounted.",
            name: "host-home",
            status: "missing",
          },
        ],
      });
    },
  );

  const status = await manager.checkRuntimeDependencies();

  assert.equal(status.status, "repairable");
  assert.equal(status.issues[0]?.name, "blame-runtime");
  assert.equal(status.issues[0]?.status, "missing");
  assert.match(status.issues[0]?.action ?? "", /Reset BlameRuntime/);
});

test("skips ensure when managed runtime is already ready", async () => {
  const calls: string[] = [];
  const manager = createRuntimeManager(
    { platform: "win32" },
    async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (args[0] === "status") {
        return JSON.stringify({ status: "ready", checks: [] });
      }
      return "ready";
    },
  );

  const report = await manager.ensureRuntimeReady();
  assert.equal(report.status, "ready");
  assert.deepEqual(calls, [
    "blame-wsl2-runtime --version",
    "blame-wsl2-runtime status",
    "blame-wsl2-runtime agent status",
  ]);
});

test("runs ensure when managed runtime is not ready", async () => {
  const calls: string[] = [];
  let isReady = false;
  const manager = createRuntimeManager(
    { platform: "win32" },
    async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (args[0] === "status") {
        if (!isReady) {
          return JSON.stringify({
            status: "missing",
            checks: [{ name: "agent", status: "missing" }],
          });
        }
        return JSON.stringify({ status: "ready", checks: [] });
      }
      if (args[0] === "ensure") {
        isReady = true;
      }
      return "ready";
    },
  );

  const report = await manager.ensureRuntimeReady();
  assert.equal(report.status, "ready");
  assert.deepEqual(calls, [
    "blame-wsl2-runtime --version",
    "blame-wsl2-runtime status",
    "blame-wsl2-runtime ensure",
    "blame-wsl2-runtime --version",
    "blame-wsl2-runtime status",
    "blame-wsl2-runtime agent status",
  ]);
});

test("streams valid runtime lifecycle progress", async () => {
  const progress: RuntimeProgress[] = [];
  let ready = false;
  const manager = createRuntimeManager(
    { onProgress: (event) => progress.push(event), platform: "win32" },
    async (_command, args, _env, _timeoutMs, onOutput) => {
      if (args[0] === "status") {
        return JSON.stringify({
          checks: ready ? [] : [{ name: "distro", status: "missing" }],
          status: ready ? "ready" : "missing",
        });
      }
      if (args[0] === "ensure") {
        onOutput?.('ignored\nBLAME_RUNTIME_PROGRESS {"phase":"down');
        onOutput?.(
          'loading","completedBytes":50,"totalBytes":100,"percent":50}\r\n',
        );
        onOutput?.('BLAME_RUNTIME_PROGRESS {"phase":"verifying"}\n');
        ready = true;
      }
      return "ready";
    },
  );

  const report = await manager.ensureRuntimeReady();

  assert.equal(report.status, "ready");
  assert.deepEqual(progress, [
    { phase: "checking" },
    {
      completedBytes: 50,
      percent: 50,
      phase: "downloading",
      totalBytes: 100,
    },
    { phase: "verifying" },
  ]);
});

test("runs other managed runtime lifecycle commands explicitly", async () => {
  const calls: string[] = [];
  const timeouts: Array<number | undefined> = [];
  const manager = createRuntimeManager(
    { platform: "win32" },
    async (command, args, _env, timeoutMs) => {
      calls.push([command, ...args].join(" "));
      timeouts.push(timeoutMs);
      if (args[0] === "status") {
        return JSON.stringify({ status: "ready", checks: [] });
      }
      return "ready";
    },
  );

  await manager.repairRuntime();
  await manager.resetRuntime();
  await manager.uninstallRuntime();

  assert.deepEqual(calls, [
    "blame-wsl2-runtime repair",
    "blame-wsl2-runtime --version",
    "blame-wsl2-runtime status",
    "blame-wsl2-runtime agent status",
    "blame-wsl2-runtime reset",
    "blame-wsl2-runtime --version",
    "blame-wsl2-runtime status",
    "blame-wsl2-runtime agent status",
    "blame-wsl2-runtime uninstall",
    "blame-wsl2-runtime --version",
    "blame-wsl2-runtime status",
    "blame-wsl2-runtime agent status",
  ]);
  assert.deepEqual(timeouts, [
    1_800_000,
    undefined,
    undefined,
    undefined,
    1_800_000,
    undefined,
    undefined,
    undefined,
    1_800_000,
    undefined,
    undefined,
    undefined,
  ]);
});

test("keeps Linux lifecycle operations lightweight", async () => {
  const calls: string[] = [];
  const manager = createRuntimeManager(
    { platform: "linux" },
    async (command, args) => {
      calls.push([command, ...args].join(" "));
      return "ok";
    },
  );

  await manager.ensureRuntimeReady();

  assert.deepEqual(calls, [
    "docker --version",
    "docker info",
    "docker compose version",
  ]);
});

test("flags an outdated runtime version as an update", async () => {
  const manager = createRuntimeManager(
    { platform: "darwin" },
    async (_command, args) => {
      if (args[0] !== "status") return "ok";
      return JSON.stringify({
        status: "repairable",
        checks: [
          { name: "vm", status: "available" },
          { name: "runtime-version", status: "missing" },
          { name: "cline-sdk", status: "missing" },
        ],
      });
    },
  );

  const status = await manager.checkRuntimeDependencies();

  assert.equal(status.updateRequired, true);
  assert.equal(status.issues[0]?.update, true);
});

test("does not call a missing VM an update", async () => {
  const manager = createRuntimeManager(
    { platform: "darwin" },
    async (_command, args) => {
      if (args[0] !== "status") return "ok";
      return JSON.stringify({
        status: "missing",
        checks: [
          { name: "vm", status: "missing" },
          { name: "runtime-version", status: "missing" },
        ],
      });
    },
  );

  const status = await manager.checkRuntimeDependencies();

  assert.equal(status.status, "missing");
  assert.equal(status.updateRequired, false);
});

test("a ready runtime needs no update", async () => {
  const manager = createRuntimeManager(
    { platform: "darwin" },
    async (_command, args) =>
      args[0] === "status" ? JSON.stringify({ status: "ready", checks: [] }) : "ready",
  );

  const status = await manager.checkRuntimeDependencies();

  assert.equal(status.status, "ready");
  assert.equal(status.updateRequired, false);
});
