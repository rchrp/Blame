import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { TerminalSurface } from "./terminal-surface.ts";

test("ttyd protocol shares screen, replays ANSI and records fragmented exit sequences", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let upstream: WebSocket;
  const messages: string[] = [];
  server.on("connection", (socket, request) => {
    assert.equal(request.headers["sec-websocket-protocol"], "tty");
    upstream = socket;
    socket.on("message", (raw) => {
      messages.push(raw.toString());
      if (messages.length === 1) {
        socket.send(Buffer.from("0\x1b[31mhello\x1b[0m\r\n"));
        socket.send(Buffer.from("0prompt> "));
      }
    });
  });
  const terminal = new TerminalSurface(
    async () => new WebSocket(`ws://127.0.0.1:${address.port}`, "tty"),
    80,
    24,
  );
  try {
    await terminal.connect();
    const screen = await terminal.waitFor("prompt>", 1000);
    assert.match(screen.text, /hello/);
    assert.equal(screen.matched, true);
    assert.match(await terminal.replay(), /hello/);
    assert.deepEqual(JSON.parse(messages[0]!), {
      AuthToken: "",
      columns: 80,
      rows: 24,
    });
    terminal.write("answer\r");
    terminal.resize(100, 30);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(messages[1], "0answer\r");
    assert.equal(messages[2], '1{"columns":100,"rows":30}');
    assert.equal(terminal.resize(5000, 30), false);
    upstream!.send(Buffer.from("0\x1b]1337;BlameEx"));
    upstream!.send(Buffer.from("0it=7\x07"));
    const exit = await terminal.waitFor("does-not-exist", 1000);
    assert.equal(exit.exitCode, 7);
    assert.equal(exit.exited, true);
    assert.doesNotMatch(exit.text, /BlameExit/);
  } finally {
    terminal.dispose();
    server.clients.forEach((s) => s.terminate());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("wait patterns are bounded and invalid patterns fail without blocking the main process", async () => {
  const terminal = new TerminalSurface(async () => {
    throw new Error("not used");
  });
  try {
    await assert.rejects(terminal.waitFor("x".repeat(201)), /200/);
    await assert.rejects(terminal.waitFor("["), /regular expression/i);
  } finally {
    terminal.dispose();
  }
});

test("an exit code survives a connection reset right after the program ends", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  server.on("connection", (socket) => {
    socket.once("message", () => {
      socket.send(Buffer.from("0sh: 1: tool: not found\r\n"));
      socket.send(Buffer.from("0\x1b]1337;BlameExit=127\x07"));
      // Like ttyd once the program exits: a close frame with status 1006,
      // which the client reports as an invalid frame.
      setTimeout(() => {
        const raw = (socket as unknown as { _socket: NodeJS.WritableStream })
          ._socket;
        raw.write(Buffer.from([0x88, 0x02, 0x03, 0xee]));
      }, 100);
    });
  });
  const terminal = new TerminalSurface(
    async () => new WebSocket(`ws://127.0.0.1:${address.port}`, "tty"),
    80,
    24,
  );
  try {
    await terminal.connect();
    const screen = await terminal.waitFor("never", 1000);
    assert.equal(screen.exitCode, 127);
    assert.equal(screen.message, "Exited with code 127");
  } finally {
    terminal.dispose();
    server.close();
  }
});

test(
  "official ttyd preserves immediate exit markers and can restart",
  { skip: !process.env.BLAME_TEST_TTYD, timeout: 15000 },
  async () => {
    const { spawn } = await import("node:child_process");
    const { createServer } = await import("node:net");
    const { createHash } = await import("node:crypto");
    const { readFile } = await import("node:fs/promises");
    const { compilePreviewManifest } = await import("@blame/preview-runtime");
    const { ttydAssets } = await import("@blame/preview-runtime/compose");
    const binary = process.env.BLAME_TEST_TTYD!;
    const architecture = process.arch === "arm64" ? "aarch64" : "x86_64";
    assert.equal(
      createHash("sha256")
        .update(await readFile(binary))
        .digest("hex"),
      ttydAssets[architecture].sha256,
    );
    const listener = createServer();
    await new Promise<void>((resolve) =>
      listener.listen(0, "127.0.0.1", resolve),
    );
    const address = listener.address() as { port: number };
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const plan = compilePreviewManifest({
      confidence: "high",
      project: {},
      setup: [],
      caches: [],
      risks: [],
      probes: [],
      services: [
        {
          id: "cli",
          kind: "preview",
          container: { image: "debian" },
          surface: { type: "terminal" },
          endpoints: [],
          command:
            'printf "value> "; IFS= read -r value; printf "received:%s\\n" "$value"; exit 7',
        },
      ],
    });
    const command = plan.services[0]!.command!.replace(
      "/opt/blame/tools/ttyd",
      "'" + binary.replace(/'/g, "'\"'\"'") + "'",
    ).replace("--port 7681", `--port ${address.port}`);
    const child = spawn("sh", ["-c", "exec " + command], { stdio: "ignore" });
    const terminal = new TerminalSurface(
      async () => new WebSocket(`ws://127.0.0.1:${address.port}/ws`, "tty"),
    );
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const { Socket } = await import("node:net");
        const ready = await new Promise<boolean>((resolve) => {
          const socket = new Socket();
          socket.once("error", () => resolve(false));
          socket.connect(address.port, "127.0.0.1", () => {
            socket.destroy();
            resolve(true);
          });
        });
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await terminal.connect();
      assert.equal((await terminal.waitFor("value>", 2000)).matched, true);
      terminal.resize(100, 30);
      terminal.write("literal answer\r");
      assert.equal(
        (await terminal.waitFor("received:literal answer", 2000)).matched,
        true,
      );
      assert.equal((await terminal.waitFor("never", 2000)).exitCode, 7);
      await terminal.restart();
      assert.equal((await terminal.waitFor("value>", 2000)).matched, true);
    } finally {
      terminal.dispose();
      child.kill();
    }
  },
);
