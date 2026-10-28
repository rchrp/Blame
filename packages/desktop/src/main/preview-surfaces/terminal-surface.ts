import { StringDecoder } from "node:string_decoder";
import headless from "@xterm/headless";
import serialize from "@xterm/addon-serialize";
import { EventEmitter } from "node:events";
import WebSocket from "ws";

const { Terminal } = headless;
const { SerializeAddon } = serialize;
export const terminalKeys: Record<string, string> = {
  Enter: "\r",
  Tab: "\t",
  Escape: "\x1b",
  Backspace: "\x7f",
  Up: "\x1b[A",
  Down: "\x1b[B",
  Right: "\x1b[C",
  Left: "\x1b[D",
  "Ctrl+C": "\x03",
  "Ctrl+D": "\x04",
  "Ctrl+Z": "\x1a",
  "Ctrl+L": "\x0c",
};
export type SurfaceTerminalEvent = { type: "stdout" | "state"; data: string };

/** One ttyd connection and screen shared by every view and agent of a story. */
export class TerminalSurface extends EventEmitter {
  private terminal: InstanceType<typeof Terminal>;
  private serializer: InstanceType<typeof SerializeAddon>;
  private socket?: WebSocket;
  private connecting?: Promise<void>;
  private output = Promise.resolve();
  private decoder = new StringDecoder("utf8");
  private sequence = 0;
  private connectedBefore = false;
  private stopped = false;
  exitCode?: number;
  state: "starting" | "ready" | "stopped" | "failed" = "starting";
  message = "Connecting to the program";

  private readonly open: () => Promise<WebSocket>;
  constructor(open: () => Promise<WebSocket>, cols = 120, rows = 32) {
    super();
    this.open = open;
    this.terminal = new Terminal({
      cols,
      rows,
      scrollback: 200,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.terminal.loadAddon(this.serializer);
    this.terminal.parser.registerOscHandler(1337, (value) => {
      const match = /^BlameExit=(\d+)$/.exec(value);
      if (!match) return false;
      this.exitCode = Number(match[1]);
      this.update("stopped", `Exited with code ${this.exitCode}`);
      return true;
    });
  }

  connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.stopped = false;
    this.connecting = this.open()
      .then(
        (socket) =>
          new Promise<void>((resolve, reject) => {
            this.socket = socket;
            const timer = setTimeout(() => {
              socket.terminate();
              reject(
                new Error("The terminal connection timed out. Try again."),
              );
            }, 30_000);
            const ready = () => {
              clearTimeout(timer);
              if (this.stopped) {
                socket.close();
                reject(new Error("Terminal stopped"));
                return;
              }
              socket.send(
                JSON.stringify({
                  AuthToken: "",
                  columns: this.terminal.cols,
                  rows: this.terminal.rows,
                }),
              );
              if (this.connectedBefore) {
                this.terminal.reset();
                this.publish({
                  type: "stdout",
                  data: "\x1bcThe program restarted after the connection was lost.\r\n",
                });
              }
              this.connectedBefore = true;
              this.exitCode = undefined;
              this.update("ready", "Running");
              resolve();
            };
            socket.once("open", ready);
            socket.on("message", (raw) => {
              const data = Buffer.isBuffer(raw)
                ? raw
                : Buffer.from(raw as ArrayBuffer);
              if (data[0] !== 48 || data.length > 4 * 1024 * 1024) return;
              const payload = data.subarray(1);
              this.output = this.output.then(
                () =>
                  new Promise<void>((done) =>
                    this.terminal.write(payload, () => {
                      const text = this.decoder.write(payload);
                      if (text) this.publish({ type: "stdout", data: text });
                      done();
                    }),
                  ),
              );
            });
            socket.on("error", () => {
              clearTimeout(timer);
              if (this.socket !== socket) return;
              this.update(
                "failed",
                "The terminal connection was lost. Run the program again.",
              );
              reject(new Error(this.message));
            });
            socket.once("close", () => {
              clearTimeout(timer);
              void this.output.then(() => {
                if (this.socket === socket && this.exitCode === undefined)
                  this.update(
                    "stopped",
                    "The terminal disconnected. Run the program again.",
                  );
              });
              reject(new Error("Terminal disconnected"));
            });
            if (socket.readyState === WebSocket.OPEN) ready();
          }),
      )
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }

  async snapshot() {
    await this.output;
    return this.currentSnapshot();
  }
  private currentSnapshot() {
    const buffer = this.terminal.buffer.active;
    const lines = [];
    for (let i = Math.max(0, buffer.length - 200); i < buffer.length; i++)
      lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
    return {
      status: this.state,
      message: this.message,
      text: lines.join("\n"),
      cursor: { x: buffer.cursorX, y: buffer.cursorY },
      exited: this.exitCode !== undefined,
      exitCode: this.exitCode,
    };
  }
  async capture() {
    await this.output;
    return {
      replay: this.serializer.serialize({ scrollback: 200 }),
      sequence: this.sequence,
      ...this.currentSnapshot(),
    };
  }
  private publish(event: SurfaceTerminalEvent) {
    this.emit("event", { ...event, sequence: ++this.sequence });
  }
  async replay() {
    await this.output;
    return this.serializer.serialize({ scrollback: 200 });
  }
  write(data: string) {
    if (data.length > 64 * 1024 || this.socket?.readyState !== WebSocket.OPEN)
      return false;
    this.socket.send(Buffer.concat([Buffer.from("0"), Buffer.from(data)]));
    return true;
  }
  resize(cols: number, rows: number) {
    if (
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 2 ||
      rows < 2 ||
      cols > 300 ||
      rows > 100
    )
      return false;
    this.terminal.resize(cols, rows);
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(
        Buffer.from("1" + JSON.stringify({ columns: cols, rows })),
      );
    return true;
  }
  async restart() {
    const socket = this.socket;
    this.socket = undefined;
    socket?.removeAllListeners();
    socket?.terminate();
    await this.output;
    this.decoder = new StringDecoder("utf8");
    this.exitCode = undefined;
    this.terminal.reset();
    this.connectedBefore = false;
    this.publish({ type: "stdout", data: "\x1bc" });
    this.update("starting", "Restarting the program");
    await this.connect();
  }
  async waitFor(pattern: string, timeoutMs = 10_000, signal?: AbortSignal) {
    // Avoid running attacker-controlled regular expressions on the main thread.
    if (!pattern || pattern.length > 200)
      throw new Error("Use a pattern of 1 to 200 characters.");
    const { Worker } = await import("node:worker_threads");
    const deadline = Date.now() + Math.min(60_000, Math.max(1, timeoutMs));
    const worker = new Worker(
      `const {parentPort, workerData}=require('node:worker_threads'); const re=new RegExp(workerData); parentPort.on('message', text=>parentPort.postMessage(re.test(text)));`,
      { eval: true, workerData: pattern, execArgv: [] },
    );
    try {
      while (true) {
        signal?.throwIfAborted();
        const screen = await this.snapshot();
        const matched = await new Promise<boolean>((resolve, reject) => {
          const timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Pattern took too long to evaluate. Use a simpler pattern.",
                ),
              ),
            500,
          );
          worker.once("error", fail);
          worker.once("message", done);
          function fail(error: Error) {
            clearTimeout(timer);
            worker.off("message", done);
            reject(error);
          }
          function done(value: boolean) {
            clearTimeout(timer);
            worker.off("error", fail);
            resolve(value);
          }
          worker.postMessage(screen.text);
        });
        if (matched || screen.exited || Date.now() >= deadline)
          return { ...screen, matched };
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      await worker.terminate();
    }
  }
  close() {
    this.stopped = true;
    this.socket?.terminate();
    this.update("stopped", "Stopped");
  }
  dispose() {
    this.close();
    void this.output.then(() => this.terminal.dispose());
    this.removeAllListeners();
  }
  private update(state: typeof this.state, message: string) {
    this.state = state;
    this.message = message;
    this.publish({
      type: "state",
      data: JSON.stringify({ status: state, message, exitCode: this.exitCode }),
    });
  }
}
