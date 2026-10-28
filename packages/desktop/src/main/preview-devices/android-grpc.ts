import * as grpc from "@grpc/grpc-js";
import { fromJSON } from "@grpc/proto-loader";
import schema from "./protocol/emulator-controller-schema.json" with { type: "json" };

export type AndroidGrpcImage = {
  image: Buffer;
  format: { width: number; height: number };
};
type Unary = (
  input: object,
  metadata: grpc.Metadata,
  options: grpc.CallOptions,
  callback: (error: grpc.ServiceError | null, value: unknown) => void,
) => grpc.ClientUnaryCall;
type EmulatorClient = grpc.Client & {
  getScreenshot: Unary;
  sendKey: Unary;
  sendTouch: Unary;
  streamScreenshot(
    input: object,
    metadata: grpc.Metadata,
  ): grpc.ClientReadableStream<AndroidGrpcImage>;
};
export const androidGrpcDefinition = fromJSON(
  schema as unknown as Parameters<typeof fromJSON>[0],
  { keepCase: false, defaults: true, enums: String, bytes: Buffer },
);
const loaded = grpc.loadPackageDefinition(androidGrpcDefinition) as unknown as {
  android: {
    emulation: {
      control: {
        EmulatorController: new (
          url: string,
          credentials: grpc.ChannelCredentials,
          options: grpc.ClientOptions,
        ) => EmulatorClient;
      };
    };
  };
};
export function androidDiscovery(contents: string, expectedPort: number) {
  const fields = Object.fromEntries(
    contents.split(/\r?\n/).flatMap((line) => {
      const index = line.indexOf("=");
      return index < 1
        ? []
        : [[line.slice(0, index).trim(), line.slice(index + 1).trim()]];
    }),
  );
  const port = Number(fields["grpc.port"]),
    token = fields["grpc.token"];
  if (
    port !== expectedPort ||
    port < 1 ||
    port > 65535 ||
    !token ||
    token.length > 8192 ||
    /[\r\n]/.test(token)
  )
    return;
  return { port, token };
}
export class AndroidGrpc {
  private client: EmulatorClient;
  private metadata = new grpc.Metadata();
  constructor(port: number, token: string) {
    this.client = new loaded.android.emulation.control.EmulatorController(
      `127.0.0.1:${port}`,
      grpc.credentials.createInsecure(),
      { "grpc.max_receive_message_length": 16 * 1024 * 1024 },
    );
    this.metadata.set("authorization", `Bearer ${token}`);
  }
  async screenshot() {
    return this.unary("getScreenshot", {
      format: "PNG",
    }) as Promise<AndroidGrpcImage>;
  }
  async *frames(signal: AbortSignal) {
    const stream = this.client.streamScreenshot(
      { format: "PNG" },
      this.metadata,
    );
    const abort = () => stream.cancel();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      for await (const frame of stream) yield frame as AndroidGrpcImage;
    } finally {
      signal.removeEventListener("abort", abort);
      stream.cancel();
    }
  }
  async tap(x: number, y: number) {
    await this.touch(x, y, 1024);
    await this.touch(x, y, 0);
  }
  async swipe(x: number, y: number, toX: number, toY: number) {
    await this.touch(x, y, 1024);
    try {
      for (let i = 1; i <= 8; i++) {
        await this.touch(
          x + ((toX - x) * i) / 8,
          y + ((toY - y) * i) / 8,
          1024,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      await this.touch(toX, toY, 0);
    }
  }
  async key(key: string) {
    await this.unary("sendKey", { key, eventType: "keypress" });
  }
  async type(text: string) {
    for (let i = 0; i < text.length; i += 256)
      await this.unary("sendKey", { text: text.slice(i, i + 256) });
  }
  close() {
    this.client.close();
  }
  private async touch(x: number, y: number, pressure: number) {
    await this.unary("sendTouch", {
      touches: [
        { x: Math.round(x), y: Math.round(y), identifier: 0, pressure },
      ],
    });
  }
  private unary(
    method: "getScreenshot" | "sendKey" | "sendTouch",
    input: object,
  ): Promise<unknown> {
    return new Promise((resolve, reject) =>
      this.client[method](
        input,
        this.metadata,
        { deadline: Date.now() + 10000 },
        (error, result) => (error ? reject(error) : resolve(result)),
      ),
    );
  }
}
