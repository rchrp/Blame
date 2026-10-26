import { createServer, request as httpRequest } from "node:http";
import { connect, type Socket } from "node:net";
import { resolvePublicWebUrl } from "@blame/agent-runtime/web-network";

/** All browser traffic is pinned to checked public IPs, including redirects and subresources. */
export async function researchProxy(signal: AbortSignal) {
  const sockets = new Set<Socket>();
  let transferred = 0;
  const track = (socket: Socket) => {
    if (sockets.size >= 64 || signal.aborted) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      transferred += chunk.length;
      if (transferred > 40_000_000) close();
    });
  };
  const server = createServer((incoming, outgoing) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(incoming.method ?? "")) {
      outgoing.writeHead(405).end();
      return;
    }
    void resolvePublicWebUrl(incoming.url ?? "")
      .then(({ url, addresses }) => {
        if (url.protocol !== "http:") throw new Error("HTTPS requires CONNECT");
        const headers: import("node:http").OutgoingHttpHeaders = {
          ...incoming.headers,
          host: url.host,
        };
        delete headers["proxy-authorization"];
        delete headers["proxy-connection"];
        const request = httpRequest(
          url,
          {
            method: incoming.method,
            signal,
            headers,
            lookup: (_host, options, callback) =>
              options.all
                ? callback(null, addresses)
                : callback(null, addresses[0]!.address, addresses[0]!.family),
          },
          (response) => {
            outgoing.writeHead(response.statusCode ?? 502, response.headers);
            response.pipe(outgoing);
          },
        );
        request.on("socket", track);
        request.on("error", () => {
          if (!outgoing.headersSent) outgoing.writeHead(502);
          outgoing.end();
        });
        incoming.pipe(request);
      })
      .catch(() => outgoing.writeHead(403).end());
  });
  server.on("connection", track);
  server.on("connect", (request, client, head) => {
    void resolvePublicWebUrl(`https://${request.url ?? ""}`)
      .then(({ url, addresses }) => {
        if (url.port && url.port !== "443")
          throw new Error("Unsupported tunnel port");
        if (signal.aborted || client.destroyed) return;
        const upstream = connect({
          host: addresses[0]!.address,
          family: addresses[0]!.family,
          port: 443,
          signal,
        });
        track(upstream);
        upstream.once("connect", () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
        });
        client.on("close", () => upstream.destroy());
        upstream.on("close", () => client.destroy());
      })
      .catch(() => {
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      });
  });
  function close() {
    signal.removeEventListener("abort", close);
    for (const socket of sockets) socket.destroy();
    server.close();
  }
  signal.addEventListener("abort", close, { once: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  if (signal.aborted) {
    close();
    throw signal.reason;
  }
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Research proxy unavailable");
  return { url: `http://127.0.0.1:${address.port}`, close };
}
