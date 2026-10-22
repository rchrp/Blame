import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";

// A loopback-only WebSocket server for one CDP client. It implements the
// subset of RFC 6455 that Puppeteer uses: masked client text frames,
// fragmentation, ping/pong and close. No extensions are negotiated.

export type CdpSocket = {
  close(): void;
  send(message: string): void;
};

export type CdpSocketHandlers = {
  closed(): void;
  message(text: string): void;
};

export type CdpWebSocketServerOptions = {
  connect(socket: CdpSocket): CdpSocketHandlers;
  json(path: "list" | "version"): unknown;
};

export type CdpWebSocketServer = {
  close(): Promise<void>;
  httpUrl: string;
  port: number;
  token: string;
  wsEndpoint: string;
};

const maximumMessageBytes = 256 * 1024 * 1024;
const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export async function startCdpWebSocketServer(
  options: CdpWebSocketServerOptions,
): Promise<CdpWebSocketServer> {
  const token = randomBytes(32).toString("hex");
  const sockets = new Set<Socket>();
  let connected = false;
  const server = createServer((request, response) =>
    handleHttp(request, response, token, server, options),
  );
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket: Socket, head: Buffer) => {
    if (connected || !authorizedUpgrade(request, token, server)) {
      rejectUpgrade(socket);
      return;
    }
    connected = true;
    acceptUpgrade(request, socket, head, options);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    close: () => closeServer(server, sockets),
    httpUrl: `http://127.0.0.1:${port}/${token}`,
    port,
    token,
    wsEndpoint: `ws://127.0.0.1:${port}/devtools/browser/${token}`,
  };
}

function handleHttp(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  server: Server,
  options: CdpWebSocketServerOptions,
) {
  const path = requestPath(request);
  const prefix = `/${token}/json`;
  if (
    request.method !== "GET" ||
    !trustedRequest(request, server) ||
    !path ||
    !tokenPrefixMatches(path, prefix)
  ) {
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("Not found");
    return;
  }
  const rest = path.slice(prefix.length);
  const kind =
    rest === "" || rest === "/" || rest === "/list"
      ? "list"
      : rest === "/version"
        ? "version"
        : undefined;
  if (!kind) {
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("Not found");
    return;
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(options.json(kind)));
}

function authorizedUpgrade(
  request: IncomingMessage,
  token: string,
  server: Server,
) {
  const path = requestPath(request);
  return (
    request.method === "GET" &&
    trustedRequest(request, server) &&
    String(request.headers.upgrade ?? "").toLowerCase() === "websocket" &&
    request.headers["sec-websocket-version"] === "13" &&
    typeof request.headers["sec-websocket-key"] === "string" &&
    Boolean(path) &&
    sameSecret(path!, `/devtools/browser/${token}`)
  );
}

// Browsers send an Origin header; CDP clients do not. Rejecting it, and any
// Host other than the loopback address, blocks web pages and DNS rebinding.
function trustedRequest(request: IncomingMessage, server: Server) {
  if (request.headers.origin !== undefined) return false;
  const address = server.address() as AddressInfo | null;
  return (
    Boolean(address) && request.headers.host === `127.0.0.1:${address!.port}`
  );
}

function requestPath(request: IncomingMessage) {
  try {
    return new URL(request.url ?? "", "http://127.0.0.1").pathname;
  } catch {
    return undefined;
  }
}

function tokenPrefixMatches(path: string, prefix: string) {
  return sameSecret(path.slice(0, prefix.length), prefix);
}

function sameSecret(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function rejectUpgrade(socket: Socket) {
  socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
}

function acceptUpgrade(
  request: IncomingMessage,
  socket: Socket,
  head: Buffer,
  options: CdpWebSocketServerOptions,
) {
  const accept = createHash("sha1")
    .update(`${request.headers["sec-websocket-key"]}${websocketGuid}`)
    .digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"),
  );
  socket.setNoDelay(true);
  let open = true;
  const cdpSocket: CdpSocket = {
    close() {
      if (!open) return;
      open = false;
      socket.end(encodeFrame(0x8, Buffer.from([0x03, 0xe8])));
    },
    send(message) {
      if (open) socket.write(encodeFrame(0x1, Buffer.from(message)));
    },
  };
  const handlers = options.connect(cdpSocket);
  const reader = new FrameReader({
    close() {
      cdpSocket.close();
    },
    error() {
      open = false;
      socket.destroy();
    },
    message: (text) => handlers.message(text),
    ping(payload) {
      if (open) socket.write(encodeFrame(0xa, payload));
    },
  });
  socket.on("data", (chunk: Buffer) => reader.push(chunk));
  socket.once("close", () => {
    open = false;
    handlers.closed();
  });
  socket.on("error", () => socket.destroy());
  if (head.length) reader.push(head);
}

type FrameEvents = {
  close(): void;
  error(): void;
  message(text: string): void;
  ping(payload: Buffer): void;
};

export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private failed = false;

  private readonly events: FrameEvents;

  constructor(events: FrameEvents) {
    this.events = events;
  }

  push(chunk: Buffer) {
    if (this.failed) return;
    this.buffer = this.buffer.length
      ? Buffer.concat([this.buffer, chunk])
      : chunk;
    while (!this.failed) {
      const frame = this.nextFrame();
      if (!frame) return;
      this.handle(frame);
    }
  }

  private nextFrame() {
    const buffer = this.buffer;
    if (buffer.length < 2) return undefined;
    const fin = (buffer[0] & 0x80) !== 0;
    const opcode = buffer[0] & 0x0f;
    const masked = (buffer[1] & 0x80) !== 0;
    let length = buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) return undefined;
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffer.length < 10) return undefined;
      const big = buffer.readBigUInt64BE(2);
      if (big > BigInt(maximumMessageBytes)) return this.fail();
      length = Number(big);
      offset = 10;
    }
    if (!masked || length > maximumMessageBytes) return this.fail();
    if (buffer.length < offset + 4 + length) return undefined;
    const mask = buffer.subarray(offset, offset + 4);
    const payload = Buffer.from(
      buffer.subarray(offset + 4, offset + 4 + length),
    );
    for (let index = 0; index < payload.length; index += 1)
      payload[index] ^= mask[index & 3];
    this.buffer = buffer.subarray(offset + 4 + length);
    return { fin, opcode, payload };
  }

  private handle(frame: { fin: boolean; opcode: number; payload: Buffer }) {
    if (frame.opcode === 0x8) return this.events.close();
    if (frame.opcode === 0x9) return this.events.ping(frame.payload);
    if (frame.opcode === 0xa) return;
    if (frame.opcode !== 0x0 && frame.opcode !== 0x1 && frame.opcode !== 0x2)
      return void this.fail();
    if (frame.opcode !== 0x0 && this.fragments.length) return void this.fail();
    if (frame.opcode === 0x0 && !this.fragments.length) return void this.fail();
    this.fragments.push(frame.payload);
    this.fragmentBytes += frame.payload.length;
    if (this.fragmentBytes > maximumMessageBytes) return void this.fail();
    if (!frame.fin) return;
    const message = Buffer.concat(this.fragments).toString("utf8");
    this.fragments = [];
    this.fragmentBytes = 0;
    this.events.message(message);
  }

  private fail(): undefined {
    this.failed = true;
    this.events.error();
    return undefined;
  }
}

export function encodeFrame(opcode: number, payload: Buffer) {
  const length = payload.length;
  const header =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : length < 0x10000
        ? Buffer.alloc(4)
        : Buffer.alloc(10);
  if (length >= 126 && length < 0x10000) {
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else if (length >= 0x10000) {
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function closeServer(server: Server, sockets: Set<Socket>) {
  return new Promise<void>((resolve) => {
    sockets.forEach((socket) => socket.destroy());
    server.close(() => resolve());
  });
}
