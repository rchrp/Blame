// The skills of a conversation that still runs on Cline, from the engine's
// skill loader (engine/tools/skills.ts): the same folders, prompt section and
// `skills` tool, given to Cline through the client tool adapter.

import { clineTool } from "./cline-client-tools.js";
import {
  loadSkills,
  skillDirectories,
  skillScopeSection,
  skillsTool,
  usableSkills,
  type Skill,
} from "./engine/tools/skills.js";

type StartUserInstructionServiceInput = {
  cwd: string;
  pluginPaths: string[];
  sessionId: string;
  workspaceRoot: string;
};

/** The skill folders of a session and the skills they held when it started. */
export type SkillCatalog = { directories: string[]; snapshot: Skill[] };

export class BlameUserInstructionServices {
  async start(
    input: StartUserInstructionServiceInput,
  ): Promise<SkillCatalog | undefined> {
    const directories = skillDirectories({
      workspaceRoot: input.workspaceRoot,
      pluginPaths: input.pluginPaths,
    });
    try {
      return { directories, snapshot: await loadSkills(directories) };
    } catch {
      return undefined;
    }
  }

  // Nothing runs between calls: the skills tool reads the folders when called.
  stop(sessionId: string) {
    void sessionId;
  }

  stopAll() {}
}

/** The skills prompt section for a session with these tools. */
export function skillScopeSystemPrompt(
  catalog?: SkillCatalog,
  toolNames: readonly string[] = [],
) {
  return catalog
    ? skillScopeSection(usableSkills(catalog.snapshot, toolNames))
    : "";
}

/** The `skills` tool for a session with these tools, as a Cline tool. */
export function skillsClineTool(
  catalog: SkillCatalog | undefined,
  toolNames: readonly string[],
) {
  if (!catalog) return [];
  const tool = skillsTool(usableSkills(catalog.snapshot, toolNames), async () =>
    usableSkills(await loadSkills(catalog.directories), toolNames),
  );
  return tool ? [clineTool(tool)] : [];
}
