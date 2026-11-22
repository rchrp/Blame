// An epic's orchestrator (docs/orchestrator.md): an agent that never codes.
// It reads the project folder (the harness's `search_code` and `read_code`
// only), creates and judges the epic's stories with the host's own tools
// (`engine/orchestrator/tools.ts`), and ends every turn through `end_turn`,
// the result tool of its completion contract.

import type { CompletionContract } from "@blame/engine-client";
import { renderPrompt } from "../../development-prompt-parts.js";
import {
  normalizePersonalization,
  personalizationSystemSection,
  type AgentPersonalization,
} from "../../personalization.js";
import { loadPrompt } from "../../prompt-loader.js";
import { webResearchGuidance } from "../../web-research-calls.js";
import type { EngineModelChoice, OrchestratorSettings } from "../protocol.js";
import { engineModel, type Purpose } from "./purpose.js";
import { purposeEngineTools, purposeHarnessTools } from "./tool-sets.js";

/** What the host reads of the epic before it builds the config (never sent by a window). */
export type OrchestratorResolution = {
  /** The epic's `orchestratorModel`, else the account's agent model. */
  model: EngineModelChoice;
  epic: {
    title: string;
    goal: string | null;
    branch: string | null;
    targetBranch: string | null;
  };
};

/** The settings as the host hands them to the builder: the window's, and what it read. */
export type ResolvedOrchestratorSettings = OrchestratorSettings & {
  resolved: OrchestratorResolution;
};

/** A turn ends only through an accepted `end_turn`; a reply that stops in text is corrected. */
export const orchestratorCompletionContract: CompletionContract = {
  result: { source: "tool", name: "end_turn" },
  max_corrections: 2,
};

export const orchestratorPurpose: Purpose<OrchestratorSettings> = {
  workspace: (settings) => settings.workspace,
  config(settings, _session, { tools, clientTools, toolNames, promptDate }) {
    const { resolved } = settings as Partial<ResolvedOrchestratorSettings>;
    if (!resolved)
      throw new Error("The epic's conversation needs its epic read first.");
    const harnessTools = purposeHarnessTools.orchestrator;
    return {
      purpose: "orchestrator",
      workspace_root: settings.workspace.root,
      ...engineModel(resolved.model),
      system_prompt: orchestratorPrompt({
        workspaceRoot: settings.workspace.root,
        epic: resolved.epic,
        personalization: settings.personalization,
        promptDate,
        web: toolNames.includes("search_web"),
      }),
      engine_tools: [...purposeEngineTools.orchestrator],
      client_tools: tools.specs(clientTools),
      tool_options: {
        harness: {
          taskContract: {
            environment: { isolated: false, managedPreview: false },
            effect_requirement: "none",
          },
          responseStyle: normalizePersonalization(settings.personalization)
            .responseStyle,
          ...(harnessTools ? { tools: [...harnessTools] } : {}),
        },
      },
      limits: settings.maxContextTokens
        ? { max_context_tokens: settings.maxContextTokens }
        : {},
      // It never edits: nothing to undo.
      checkpoints: false,
      contract: orchestratorCompletionContract,
    };
  },
};

function orchestratorPrompt(input: {
  workspaceRoot: string;
  epic: OrchestratorResolution["epic"];
  personalization?: Partial<AgentPersonalization>;
  promptDate: Date;
  web: boolean;
}) {
  const prompt = renderPrompt(loadPrompt("orchestrator-agent-system"), {
    CURRENT_DATE: input.promptDate.toISOString().slice(0, 10),
    EPIC_BRANCH: input.epic.branch ?? "(not created yet)",
    EPIC_GOAL: input.epic.goal?.trim() || "(the person's first message)",
    EPIC_TARGET: input.epic.targetBranch ?? "its target branch",
    EPIC_TITLE: input.epic.title,
    PLATFORM_NAME: process.platform,
    WORKSPACE_ROOT: input.workspaceRoot,
  });
  const style = personalizationSystemSection(
    normalizePersonalization(input.personalization),
  );
  return [prompt + (input.web ? webResearchGuidance : ""), style]
    .filter(Boolean)
    .join("\n\n");
}
