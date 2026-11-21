import type { EngineSessionSettings } from "../protocol.js";
import { developmentStoryPurpose } from "./development-story.js";
import { newProjectPurpose } from "./new-project.js";
import { orchestratorPurpose } from "./orchestrator.js";
import { planPurpose } from "./plan.js";
import type { Purpose } from "./purpose.js";
import { quickChatPurpose } from "./quick-chat.js";

export type { FirstMessageServices, PurposeContext } from "./purpose.js";

const purposes: {
  [P in EngineSessionSettings["purpose"]]: Purpose<
    Extract<EngineSessionSettings, { purpose: P }>["settings"]
  >;
} = {
  "quick-chat": quickChatPurpose,
  "development-story": developmentStoryPurpose,
  plan: planPurpose,
  "new-project": newProjectPurpose,
  orchestrator: orchestratorPurpose,
};

/** The builder of a purpose, typed for its settings. */
export function purposeOf(settings: EngineSessionSettings) {
  return purposes[settings.purpose] as Purpose<
    EngineSessionSettings["settings"]
  >;
}
