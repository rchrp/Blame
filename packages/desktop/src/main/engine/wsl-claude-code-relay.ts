import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performServerHandshake } from "node:http2";
import { connect } from "node:net";
import { Duplex } from "node:stream";

// WSL runs this with the Node binary already in the runtime. The Unix socket
// is private to the runtime user. One HTTP/2 CONNECT stream per connection
// carries the bridge's HTTP unchanged, including SSE and cancellation.
const guest = String.raw`
const { mkdirSync, rmSync } = require('node:fs');
const { connect } = require('node:http2');
const { createServer } = require('node:net');
const { dirname } = require('node:path');
const { Duplex } = require('node:stream');
const path = process.argv[1];
const directory = dirname(path);
mkdirSync(directory, { mode: 0o700 });
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));

const transport = Duplex.from({ readable: process.stdin, writable: process.stdout });
const client = connect('http://claude-code', { createConnection: () => transport });
const server = createServer({ allowHalfOpen: true }, (socket) => {
  const stream = client.request({ ':method': 'CONNECT', ':authority': 'claude-code' });
  socket.on('error', () => stream.destroy());
  stream.on('error', () => socket.destroy());
  socket.on('close', () => { if (!stream.writableEnded) stream.destroy(); });
  stream.on('close', () => { if (!socket.writableEnded) socket.destroy(); });
  socket.pipe(stream).pipe(socket);
});
client.on('error', () => process.exit(1));
client.on('close', () => process.exit(0));
server.listen(path, () => {
  const ready = client.request({ ':path': '/ready' });
  ready.on('error', () => process.exit(1));
  ready.resume();
});
`;

/** Relays the Windows loopback bridge through wsl.exe's pipes, on first use. */
export class WslClaudeCodeRelay {
  private running?: { ready: Promise<string>; close(): void };
  private port = 0;
  private readonly command: string;
  private readonly args: readonly string[];

  constructor(command: string, args: readonly string[]) {
    this.command = command;
    this.args = args;
  }

  socket(baseUrl: string): Promise<string> {
    const url = new URL(baseUrl);
    const port = Number(url.port || 80);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || port === 0)
      throw new Error("The Claude Code bridge must use IPv4 loopback.");
    this.port = port;
    this.running ??= this.start();
    return this.running.ready;
  }

  close() {
    this.running?.close();
  }

  private start() {
    const path = `/tmp/blame-claude-code-${randomUUID()}/bridge.sock`;
    const child = spawn(this.command, [...this.args, "--eval", guest, path], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const transport = Duplex.from({
      readable: child.stdout,
      writable: child.stdin,
    });
    const session = performServerHandshake(transport);
    const { promise: ready, resolve, reject } = Promise.withResolvers<string>();
    const timer = setTimeout(() => {
      close();
      child.kill();
    }, 10_000);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      this.running = undefined;
      clearTimeout(timer);
      reject(
        new Error(
          "Blame Runtime could not open the Claude Code relay. Restart Blame Runtime and try again.",
        ),
      );
      session.destroy();
      transport.destroy();
    };
    child.once("error", close);
    child.once("close", close);
    session.on("error", close);
    session.on("close", close);
    session.on("stream", (stream, headers) => {
      stream.on("error", () => stream.destroy());
      if (headers[":path"] === "/ready" && headers[":method"] === "GET") {
        clearTimeout(timer);
        stream.respond({ ":status": 204 });
        stream.end();
        resolve(path);
        return;
      }
      if (
        headers[":method"] !== "CONNECT" ||
        headers[":authority"] !== "claude-code"
      ) {
        stream.respond({ ":status": 404 });
        stream.end();
        return;
      }
      const upstream = connect({
        host: "127.0.0.1",
        port: this.port,
        allowHalfOpen: true,
      });
      upstream.on("error", () => stream.destroy());
      stream.on("close", () => {
        if (!upstream.writableEnded) upstream.destroy();
      });
      upstream.on("close", () => {
        if (!stream.writableEnded) stream.destroy();
      });
      upstream.once("connect", () => {
        if (stream.destroyed) return upstream.destroy();
        stream.respond({ ":status": 200 });
        stream.pipe(upstream).pipe(stream);
      });
    });
    return { ready, close };
  }
}
