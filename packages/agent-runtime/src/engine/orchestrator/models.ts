// The models an epic runs on: the orchestrator's own (the epic's setting,
// else what a window sent, else the account's agent model), and the
// ranking its stories' models are chosen from (the providers list's, kept
// a few minutes).

import type { ModelRecommendations } from "../../types.js";
import type {
  EngineHostInput,
  EngineHostMethod,
  EngineHostResult,
  EngineModelChoice,
  Epic,
} from "../protocol.js";
import type { StoryService } from "../stories/service.js";

// The ranking stories' models come from, kept this long.
const recommendationsMs = 5 * 60_000;

export type ModelHost = {
  stories: StoryService;
  call<M extends EngineHostMethod>(
    method: M,
    input: EngineHostInput<M>,
  ): Promise<EngineHostResult<M>>;
  /** For tests: the ranking, instead of the providers list's. */
  ranking?(): Promise<ModelRecommendations>;
};

export class EpicModels {
  private readonly host: ModelHost;
  private recommendations:
    { at: number; value: Promise<ModelRecommendations> } | undefined;

  constructor(host: ModelHost) {
    this.host = host;
  }

  orchestrator(epic: Epic, sent?: EngineModelChoice) {
    const own = epic.settings.orchestratorModel;
    if (own?.providerId && own.modelId) return own;
    if (sent?.providerId && sent.modelId) return sent;
    return this.fallback();
  }

  /** The account's agent model, as the windows resolve it. */
  fallback(): EngineModelChoice | undefined {
    const agent = this.host.stories.preferences()?.agentModel;
    if (!agent) return undefined;
    const { maxInputTokens: _, ...model } = agent;
    void _;
    return model;
  }

  ranking(): Promise<ModelRecommendations> {
    if (this.host.ranking) return this.host.ranking();
    const known = this.recommendations;
    if (known && Date.now() - known.at < recommendationsMs) return known.value;
    const value = this.host
      .call("providers", { refresh: false })
      .then((list) => list.recommendations);
    this.recommendations = { at: Date.now(), value };
    value.catch(() => {
      if (this.recommendations?.value === value)
        this.recommendations = undefined;
    });
    return value;
  }
}
