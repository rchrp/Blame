// The new-project assistant: it discusses what the person wants to build and
// proposes a stack from Blame's catalog, trying commands in a scratch folder
// since there is no project yet.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { newProjectStackCatalogPrompt } from "../../new-project-planning.js";
import {
  normalizePersonalization,
  personalizationSystemSection,
} from "../../personalization.js";
import { renderPrompt } from "../../development-prompt-parts.js";
import { loadPrompt } from "../../prompt-loader.js";
import { webResearchGuidance } from "../../web-research-calls.js";
import type { NewProjectSettings } from "../protocol.js";
import { engineModel, type Purpose } from "./purpose.js";
import { purposeHarnessTools } from "./tool-sets.js";

/** The conversation's scratch folder, the same for every message of it. */
export function newProjectFolder(session: string) {
  return join(
    tmpdir(),
    "blame-new-project-assistant",
    session.replace(/[^\w.-]/gu, "_"),
  );
}

export const newProjectPurpose: Purpose<NewProjectSettings> = {
  workspace: (_settings, session) => ({
    root: newProjectFolder(session),
    location: "host",
  }),
  config(settings, session, { tools, clientTools, promptDate }) {
    const prompt = renderPrompt(loadPrompt("new-project-agent-system"), {
      CURRENT_DATE: promptDate.toISOString().slice(0, 10),
      PLATFORM_NAME: process.platform,
    });
    const style = personalizationSystemSection(
      normalizePersonalization(settings.personalization),
    );
    return {
      purpose: "new-project",
      workspace_root: newProjectFolder(session),
      ...engineModel(settings.model),
      system_prompt: [
        `${prompt}\n\n${newProjectStackCatalogPrompt(settings.title)}`,
        clientTools.includes("search_web") ? webResearchGuidance : "",
        style,
      ]
        .filter(Boolean)
        .join("\n\n"),
      engine_tools: ["harness"],
      client_tools: tools.specs(clientTools),
      tool_options: {
        harness: {
          taskContract: {
            environment: { isolated: true, managedPreview: false },
            effect_requirement: "none",
          },
          responseStyle: normalizePersonalization(settings.personalization)
            .responseStyle,
          ...(purposeHarnessTools["new-project"]
            ? { tools: [...purposeHarnessTools["new-project"]] }
            : {}),
        },
      },
      limits: {},
      checkpoints: false,
    };
  },
};
