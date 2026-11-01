import type {
  PreviewSessionCommand,
  PreviewSessionView,
} from "@blame/preview-runtime";
import { randomUUID } from "node:crypto";

type Client = {
  get(sessionId: string): Promise<PreviewSessionView>;
  command(
    sessionId: string,
    command: PreviewSessionCommand,
    operationId: string,
  ): Promise<PreviewSessionView>;
};

/**
 * Suspends the cloud previews a desktop started, so a closed Blame stops
 * paying for them at once instead of after the idle timeout. A preview
 * whose cloud agent is still working keeps running.
 */
export async function suspendStartedPreviews(
  client: Client,
  sessionIds: Iterable<string>,
) {
  await Promise.allSettled(
    [...sessionIds].map(async (sessionId) => {
      const session = await client.get(sessionId);
      if (
        session.state.agent === "running" ||
        ["suspended", "suspending", "destroyed", "destroying"].includes(
          session.state.host,
        )
      )
        return;
      await client.command(sessionId, { type: "suspend-host" }, randomUUID());
    }),
  );
}
