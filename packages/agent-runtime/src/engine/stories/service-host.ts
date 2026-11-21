// What the story service is given: the host's calls and events, and the
// options tests shorten.

import type { ApiConnection } from "../../types.js";
import type { DesktopServices } from "../desktop-services.js";
import type {
  EngineHostInput,
  EngineHostMethod,
  EngineHostResult,
  EngineLocation,
} from "../protocol.js";
import type { StoryHostEvent, StoryWaitReason } from "../story-protocol.js";
import type { HostStory } from "./story.js";

export type StoryServiceHost = {
  api(): ApiConnection | undefined;
  /** The engine host's own calls (createSession, send, status…). */
  call<M extends EngineHostMethod>(
    method: M,
    input: EngineHostInput<M>,
  ): Promise<EngineHostResult<M>>;
  desktop: DesktopServices;
  emit(event: StoryHostEvent): void;
  /** The sessions this computer's engine at a location keeps (never read from Blame's database). */
  storedSessions?(location: EngineLocation): Promise<string[]>;
  /** Why a queued story is held back by its epic (paused, spent…), if it is. */
  holds?(story: HostStory): StoryWaitReason | undefined;
};

export type StoryServiceOptions = {
  /** Where what this computer runs and told is kept (`ledger.ts`). */
  ledgerFile?: string;
  /** How long a reconcile waits for the API or the engine (tests shorten it). */
  deadlineMs?: number;
  /** How long after its n-th failure a reconcile is tried again. */
  retryMs?: (failures: number) => number;
};
