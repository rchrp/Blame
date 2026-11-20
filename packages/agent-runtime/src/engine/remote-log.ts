// `host/log/*` and `host/blob/*`: the engine's copy of each session in
// Blame's database (`/api/v1/engine`), reached with the user's token. The
// engine's store decides what to send and when; these only carry it.

import type {
  HostHandlers,
  Records,
  SessionRecord,
} from "@blame/engine-client";
import type { ApiConnection } from "../types.js";

export type RemoteLogServices = {
  connection(): ApiConnection | undefined;
  /** The project a session belongs to, when the host knows it. */
  projectId?(session: string): string | undefined;
};

type LogHandlers = Required<
  Pick<HostHandlers, "logPush" | "logPull" | "blobPush" | "blobPull">
>;

export function remoteLogHandlers(services: RemoteLogServices): LogHandlers {
  async function call(path: string, init: RequestInit = {}) {
    const connection = services.connection();
    // The store keeps the records and tries again later.
    if (!connection) throw new Error("Blame is not connected to its API yet.");
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (connection.token)
      headers.set("Authorization", `Bearer ${connection.token}`);
    return fetch(`${connection.url.replace(/\/$/, "")}/engine${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(60_000),
    });
  }

  return {
    async logPush({ session, records }, { signal }) {
      const projectId = services.projectId?.(session);
      const response = await call(
        `/sessions/${encodeURIComponent(session)}/records`,
        {
          method: "POST",
          // The API reads this body itself: JSON's own parser would turn the
          // records' empty strings into nulls.
          headers: { "Content-Type": "application/octet-stream" },
          body: JSON.stringify({
            records,
            ...(projectId ? { projectId } : {}),
          }),
          signal,
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        acked?: number;
        code?: string;
        message?: string;
      };
      // A gap: the database is behind what the store believed it acked. Its
      // `acked` tells the store where to start again.
      if (response.status === 409 && body.code === "E_ENGINE_LOG_GAP")
        return { acked: body.acked ?? 0 };
      if (!response.ok || typeof body.acked !== "number")
        throw new Error(
          apiError("store the session's records", response, body),
        );
      return { acked: body.acked };
    },

    async logPull({ session, after }, { signal }): Promise<Records> {
      const response = await call(
        `/sessions/${encodeURIComponent(session)}/records?after=${after}`,
        { signal },
      );
      const body = (await response.json().catch(() => ({}))) as {
        records?: SessionRecord[];
        head?: number;
        message?: string;
      };
      if (!response.ok || !Array.isArray(body.records))
        throw new Error(apiError("read the session's records", response, body));
      return { records: body.records, head: body.head ?? after };
    },

    async blobPush({ blob, data }, { signal }) {
      const response = await call(
        `/blobs/${blob.sha256}?mediaType=${encodeURIComponent(blob.media_type)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: Buffer.from(data, "base64"),
          signal,
        },
      );
      if (!response.ok)
        throw new Error(
          apiError(
            "store an attachment",
            response,
            await response.json().catch(() => ({})),
          ),
        );
      await response.body?.cancel();
      return null;
    },

    async blobPull({ sha256 }, { signal }) {
      const response = await call(`/blobs/${sha256}`, { signal });
      if (response.status === 404) {
        await response.body?.cancel();
        return {};
      }
      if (!response.ok)
        throw new Error(
          apiError(
            "read an attachment",
            response,
            await response.json().catch(() => ({})),
          ),
        );
      return {
        data: Buffer.from(await response.arrayBuffer()).toString("base64"),
      };
    },
  };
}

function apiError(
  what: string,
  response: Response,
  body: { message?: string },
) {
  return `Blame's API could not ${what} (${response.status}${body.message ? `: ${body.message}` : ""}).`;
}
