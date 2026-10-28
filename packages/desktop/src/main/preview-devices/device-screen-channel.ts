import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { nativeImage } from "electron";
import WebSocket, { WebSocketServer } from "ws";
import type { DeviceTargetService } from "./device-target-service.ts";

export async function openDeviceScreenChannel(service: DeviceTargetService, storyId: string) {
  const { driver, handle } = service.active(storyId);
  const token = randomBytes(32).toString("hex"), controller = new AbortController();
  const server = createServer((_req, res) => res.writeHead(404).end());
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 128000 });
  let used = false;
  const close = () => { clearTimeout(timer); controller.abort(); service.off("state", state); sockets.clients.forEach((s) => s.terminate()); sockets.close(); server.close(); };
  const state = (id: string, value: { status: string }) => { if (id === storyId && value.status === "stopped") close(); };
  service.on("state", state);
  const timer = setTimeout(close, 30000); timer.unref();
  server.on("upgrade", (request, socket, head) => {
    const supplied = Buffer.from(request.url ?? ""), expected = Buffer.from(`/${token}`);
    if (used || request.headers.host !== `127.0.0.1:${(server.address() as AddressInfo).port}` || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { socket.destroy(); return; }
    used = true; clearTimeout(timer);
    sockets.handleUpgrade(request, socket, head, (client) => {
      client.once("close", close); client.on("error", close);
      let down: { x: number; y: number } | undefined;
      let inputs = Promise.resolve();
      client.on("message", (data, binary) => {
        if (binary) return;
        inputs = inputs.then(async () => {
          const message = JSON.parse(data.toString()) as Record<string, unknown>, input = driver.input(handle);
          if (message.type === "touch") {
            const x = Number(message.x), y = Number(message.y);
            if (![x,y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)) throw new Error("Invalid touch position");
            const point = { x: x * handle.pointWidth, y: y * handle.pointHeight };
            if (message.phase === "down") down = point;
            if (message.phase === "up" && down) { if (Math.hypot(point.x-down.x,point.y-down.y) > 5) await input.swipe(down.x,down.y,point.x,point.y); else await input.tap(point.x,point.y); down = undefined; }
          } else if (message.type === "text" && typeof message.text === "string" && message.text.length <= 64000) await input.type(message.text);
          else if (message.type === "key") await input.key(String(message.key));
          else if (message.type === "button") await input.button(String(message.button));
          service.status(storyId);
        }).catch((error: Error) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "state", message: error.message })); });
      });
      void (async () => {
        let previous = "", metadata = "", lastFrameAt = 0;
        for await (const frame of driver.screen(handle).frames(controller.signal)) {
          if (controller.signal.aborted || client.readyState !== WebSocket.OPEN) break;
          if (client.bufferedAmount > 2 * 1024 * 1024 || Date.now()-lastFrameAt < 1000/15) continue;
          lastFrameAt = Date.now();
          const image = nativeImage.createFromBuffer(frame.data), size = image.getSize();
          if (!size.width || !size.height) continue;
          handle.width = size.width; handle.height = size.height;
          const meta = JSON.stringify({ type: "meta", width: size.width, height: size.height, pointWidth: handle.pointWidth, pointHeight: handle.pointHeight });
          if (meta !== metadata) { client.send(meta); metadata = meta; }
          const jpeg = image.toJPEG(70), hash = createHash("sha256").update(jpeg).digest("hex");
          if (hash === previous) continue;
          previous = hash; client.send(jpeg);
        }
      })().catch(() => { if (!controller.signal.aborted && client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "state", message: "The device screen stopped. Reconnect to continue." })); close(); });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/${token}` };
}
