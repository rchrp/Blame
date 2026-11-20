import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { limaEngine, localEngine, serveArgs, wslEngine } from "./commands.js";

const serve = { dataDir: "/var/lib/blame/engine" };

describe("engine commands", () => {
  it("serves with the data directory, and the optional flags only when given", () => {
    assert.deepEqual(serveArgs(serve), [
      "serve",
      "--data-dir",
      "/var/lib/blame/engine",
    ]);
    assert.deepEqual(
      serveArgs({
        ...serve,
        harnessCommand: "blame-harness",
        idleTimeoutSeconds: 300,
      }),
      [
        "serve",
        "--data-dir",
        "/var/lib/blame/engine",
        "--harness-command",
        "blame-harness",
        "--idle-timeout",
        "300",
      ],
    );
  });

  it("runs locally, through limactl on macOS and through wsl.exe on Windows", () => {
    assert.deepEqual(localEngine("/app/blame-engine", serve), {
      command: "/app/blame-engine",
      args: ["serve", "--data-dir", "/var/lib/blame/engine"],
      env: undefined,
    });
    assert.deepEqual(
      limaEngine({
        instance: "blame-runtime",
        binary: "/usr/local/bin/blame-engine",
        serve,
      }),
      {
        command: "limactl",
        args: [
          "shell",
          "blame-runtime",
          "--",
          "/usr/local/bin/blame-engine",
          "serve",
          "--data-dir",
          "/var/lib/blame/engine",
        ],
        env: undefined,
      },
    );
    assert.deepEqual(
      wslEngine({
        distro: "blame-runtime",
        binary: "/usr/local/bin/blame-engine",
        serve,
      }).args,
      [
        "-d",
        "blame-runtime",
        "-u",
        "root",
        "--exec",
        "/usr/local/bin/blame-engine",
        "serve",
        "--data-dir",
        "/var/lib/blame/engine",
      ],
    );
  });

  it("refuses arguments the VM's shell would reinterpret", () => {
    assert.throws(
      () =>
        limaEngine({
          instance: "i",
          binary: "/usr/local/bin/blame-engine",
          serve: { dataDir: "/data dir; rm -rf /" },
        }),
      /reinterpreted/,
    );
  });
});
